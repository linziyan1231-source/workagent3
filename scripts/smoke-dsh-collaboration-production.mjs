import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { baseURL, login } from "./smoke-dsh-helpers.mjs";

// Additive, authenticated release acceptance. The validation project is kept
// hidden after success; no production project, history or file is deleted.
const out = ".cache/collaboration/production";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [], report = { checks: [], errors };
page.on("pageerror", (error) => errors.push(error.message));
let project;
try {
  await login(page);
  const api = async (path, method = "GET", data, headers = {}) => {
    const response = await page.request.fetch(baseURL + path, { method, headers: { Origin: baseURL, ...headers }, ...(data === undefined ? {} : { data }) });
    if (!response.ok()) throw new Error(`${path}: ${response.status()} ${await response.text()}`);
    return response.status() === 204 ? undefined : response.json();
  };
  const presets = await api("/api/runtime/v1/presets");
  const models = await api("/api/runtime/v1/model-options");
  const preset = presets.find((row) => row.enabled && row.engine === "codex") || presets.find((row) => row.enabled && row.engine === "kimi");
  assert(preset, "no native assistant available for real-run acceptance");
  const model = models.find((row) => row.engine === preset.engine)?.models[0];
  assert(model, "no authorized native model available");
  const created = process.env.WORKAGENT_SMOKE_SHARED_DISCUSSION ? { project: { id: process.env.WORKAGENT_SMOKE_SHARED_PROJECT }, conversation: { id: process.env.WORKAGENT_SMOKE_SHARED_DISCUSSION } } : process.env.WORKAGENT_SMOKE_SHARED_PROJECT
    ? { project: { id: process.env.WORKAGENT_SMOKE_SHARED_PROJECT }, conversation: (await api("/api/portal/shared-conversations", "POST", { project_id: process.env.WORKAGENT_SMOKE_SHARED_PROJECT, name: "修复复验", operation_id: crypto.randomUUID() })).conversation }
    : await api("/api/portal/shared-projects", "POST", { name: "协作发布验收 · 保留记录", operation_id: crypto.randomUUID() });
  project = created.project;
  const discussion = created.conversation.id;
  report.projectId = project.id; report.discussionId = discussion;
  if (!process.env.WORKAGENT_SMOKE_SHARED_PROJECT) assert.equal(created.conversation.assistant_id, "");
  const historyWord = `HISTORY-${Date.now()}`, fileWord = `FILE-${Date.now()}`;
  const ordinary = await api("/api/portal/shared-messages", "POST", { conversation_id: discussion, body: `这是普通讨论。此前讨论暗号：${historyWord}`, client_message_id: crypto.randomUUID(), mentions: [] });
  assert.equal(ordinary.ai_started, false);
  assert.equal(ordinary.ai_status, "not_requested");
  report.checks.push("default discussion without assistant", "ordinary message does not execute");
  const fileName = `协作验收-${Date.now()}.txt`;
  const bytes = Buffer.from(`共享文件暗号：${fileWord}\n`, "utf8");
  const uploads = `/api/portal/shared-workspaces/${project.id}/uploads`;
  const upload = await api(uploads, "POST", { path: fileName, name: fileName, size: bytes.length, lastModified: 0 });
  await api(`${uploads}/${upload.id}`, "PATCH", bytes, { "Content-Type": "application/octet-stream", "Upload-Offset": "0" });
  await api(`${uploads}/${upload.id}/complete`, "POST", {});
  await api(`${uploads}/${upload.id}/complete`, "POST", {});
  const downloaded = await page.request.get(`${baseURL}/api/portal/shared-workspaces/${project.id}/content?path=${encodeURIComponent(fileName)}`);
  assert(downloaded.ok()); assert.equal(await downloaded.text(), bytes.toString());
  report.checks.push("shared upload", "idempotent completion", "authenticated shared download");
  await api(`/api/portal/shared-conversations/${discussion}/assistant`, "PUT", { assistant_id: preset.id, assistant_backend: preset.engine, model_id: model.id, thinking_effort: "medium" });
  await page.goto(`${baseURL}/?frontend=dsh&workagent=shared&project=${project.id}&discussion=${discussion}`);
  const composer = page.getByLabel("共享消息", { exact: true });
  await composer.fill("@");
  await page.getByRole("option", { name: /助手.*本条/ }).click();
  await composer.press("End");
  await composer.pressSequentially(` 请读取共享目录中的${fileName}，回复文件中的暗号和此前讨论中最新的暗号。只读取并回复，不修改任何文件。`, { delay: 5 });
  const posted = page.waitForResponse((response) => response.url().endsWith("/api/portal/shared-messages") && response.request().method() === "POST");
  await page.locator(".workagent-collab-chat").getByRole("button", { name: "发送消息", exact: true }).click();
  const started = await (await posted).json();
  assert.equal(started.ai_started, true, JSON.stringify({ status: started.ai_status, reason: started.ai_reason }));
  console.log("REAL_SHARED_ASSISTANT_STARTED");
  const deadline = Date.now() + 180000;
  let answer;
  while (Date.now() < deadline) {
    const result = await api(`/api/portal/shared-messages?conversation_id=${discussion}`);
    answer = result.messages.find((row) => row.kind === "assistant" && row.seq > started.message.seq);
    if (answer) break;
    const failure = result.messages.find((row) => row.kind === "system" && row.seq > started.message.seq);
    if (failure) throw new Error(failure.body);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  assert(answer, "assistant did not finish in acceptance window");
  assert(answer.body.includes(historyWord), "assistant did not use preceding discussion");
  assert(answer.body.includes(fileWord), "assistant did not read shared file");
  report.checks.push("real selected assistant", "preceding discussion context", "shared file read by assistant");
  const next = await api("/api/portal/shared-messages", "POST", { conversation_id: discussion, body: "验收完成，这条普通消息无需助手。", client_message_id: crypto.randomUUID(), mentions: [] });
  assert.equal(next.ai_started, false);
  await page.reload();
  await page.getByText("验收完成，这条普通消息无需助手。", { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/accepted.png` });
  await api(`/api/portal/shared-projects/${project.id}`, "PATCH", { hidden: true });
  report.checks.push("reload persistence", "next ordinary message", "validation project retained hidden");
  assert.deepEqual(errors, []);
  report.status = "passed";
  console.log("PRODUCTION_COLLABORATION_ACCEPTED");
} catch (error) {
  report.status = "failed"; report.failure = error.message;
  await page.screenshot({ path: `${out}/failure.png` });
  throw error;
} finally { await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); }
