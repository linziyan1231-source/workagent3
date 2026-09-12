import assert from "node:assert/strict";
import { mkdir, writeFile, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, webkit } from "playwright";
import { WorkspaceStore } from "../harness-bundle/dist/workspace-store.js";
import {
  fileReferenceParts,
  fileReferenceText,
} from "../packages/contracts/dist/file-reference.js";
import {
  baseURL,
  login,
  requireSmokeEnvironment,
} from "./smoke-dsh-helpers.mjs";

// Authenticated shell, isolated local workspace storage and intercepted sends.
// No production project files, messages, settings or model runs are written.
requireSmokeEnvironment();
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const out = join(process.env.WORKAGENT_SMOKE_EVIDENCE_DIR, engine);
await mkdir(out, { recursive: true });
const fixture = await mkdtemp(join(tmpdir(), "wa-reference-browser-"));
const store = new WorkspaceStore(
  join(fixture, "projects"),
  join(fixture, "home"),
);
const project = store.create("文件引用验证");
store.write(project.id, "已存在.txt", Buffer.from("原始资料"));
const browser = await { chromium, webkit }[engine].launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const report = {
  engine,
  status: "running",
  checks: [],
  errors: [],
  uploads: [],
  sends: [],
};
const fileBytes = new Map();
let messages = [],
  queue = [];
const session = {
  id: "session-file-reference-fixture",
  title: "文件引用验证",
  engine: "harness",
  permissionMode: "workspace_write",
  workspaceId: project.id,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  activity: { state: "idle" },
};
page.on("pageerror", (error) => {
  // WebKit cancels an intercepted old-document list read during explicit reload.
  // Keep the known fixture cancellation in evidence; all other errors fail.
  if (
    engine === "webkit" &&
    report.phase === "reload" &&
    /\/api\/runtime\/v1\/(?:sessions|interactions\?sessionId=session-file-reference-fixture) due to access control checks\.$/.test(
      error.message,
    )
  )
    (report.fixtureNavigationCancellations ??= []).push(error.message);
  else report.errors.push(error.message);
});
await page.addInitScript(() => {
  localStorage.setItem("workagent.files.open", "false");
});
try {
  await page.route("**/api/runtime/v1/interactions?sessionId=session-file-reference-fixture", route => route.fulfill({ json: [] }));
  await page.route("**/api/session.models", route => {
    const request = route.request().postDataJSON();
    if (request.payload?.sessionId !== session.id) return route.fallback();
    return route.fulfill({ json: { type: "server-response", rpcId: request.rpcId, result: { ok: true, value: { current: { provider: "fixture", model: "fixture-model" }, groups: [{ provider: "fixture", name: "验证模型", models: [{ id: "fixture-model", name: "验证模型", reasoning: [] }] }] } } } });
  });
  const candidate = process.env.WORKAGENT_UPLOAD_CANDIDATE;
  if (candidate)
    for (const file of ["client.js", "tokens.css"])
      await page.route(`**/plugins/@workagent/dsh-client/${file}*`, (route) =>
        route.fulfill({
          path: join(candidate, file),
          contentType: file.endsWith("css")
            ? "text/css"
            : "application/javascript",
        }),
      );
  await page.route("**/api/runtime/v1/model-options", (route) =>
    route.fulfill({
      json: [
        {
          engine: "codex",
          state: "ready",
          models: [
            {
              id: "fixture-model",
              name: "验证模型",
              isDefault: true,
              reasoning: [],
            },
          ],
        },
      ],
    }),
  );
  await page.route(
    /\/api\/runtime\/v1\/workspaces(?:\/|$|\?)/,
    async (route) => {
      const req = route.request(),
        url = new URL(req.url()),
        path = url.pathname;
      try {
        let data;
        if (path.endsWith("/workspaces")) data = store.list();
        else if (path.endsWith("/uploads"))
          data =
            req.method() === "POST"
              ? store.uploads.create(project.id, req.postDataJSON())
              : store.uploads.list(project.id);
        else if (path.endsWith("/complete")) {
          data = await store.uploads.finish(project.id, path.split("/").at(-2));
          report.uploads.push(data);
        } else if (path.includes("/uploads/")) {
          const id = path.split("/").at(-1),
            row = store.uploads.get(project.id, id);
          const bytes =
            req.postDataBuffer() ||
            fileBytes
              .get(row.name)
              .subarray(row.offset, row.offset + 8 * 1024 * 1024);
          data = await store.uploads.append(
            project.id,
            id,
            Number(req.headers()["upload-offset"]),
            (async function* () {
              yield bytes;
            })(),
          );
        } else if (path.endsWith("/files"))
          data = store.listFiles(
            project.id,
            url.searchParams.get("path") || "",
          );
        else if (path.endsWith("/locate"))
          data = store.locate(project.id, url.searchParams.get("path"));
        else if (path.endsWith("/content"))
          return route.fulfill({
            contentType: "text/plain; charset=utf-8",
            body: store.read(project.id, url.searchParams.get("path")),
          });
        else data = project;
        await route.fulfill({ json: data });
      } catch (error) {
        await route.fulfill({ status: 409, json: { error: error.message } });
      }
    },
  );
  await page.route(/\/api\/runtime\/v1\/sessions(?:\/|$|\?)/, async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname;
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "text/event-stream",
        body: ": fixture\n\n",
      });
    let data;
    if (req.method() === "POST") {
      const input = req.postDataJSON();
      if (path.endsWith("/sessions")) data = session;
      else if (path.endsWith("/fork"))
        return route.fulfill({
          status: 409,
          json: { error: "fixture_resend_rejected" },
        });
      else {
        report.sends.push(input);
        if (path.endsWith("/queue"))
          queue.push({ ...input, messageId: "queued-reference" });
        else
          messages.push({
            id: `message-${messages.length}`,
            role: "user",
            text: input.content,
            createdAt: new Date().toISOString(),
          });
        data = {};
      }
    } else if (path.endsWith("/sessions")) data = [session];
    else if (path.endsWith("/messages")) data = messages;
    else if (path.endsWith("/queue")) data = queue;
    else if (
      path.endsWith("/tools") ||
      path.endsWith("/approvals") ||
      path.endsWith("/processes")
    )
      data = [];
    else if (path.endsWith("/models")) data = [];
    else data = session;
    await route.fulfill({ json: data });
  });
  report.phase = "login";
  await login(page);
  await page
    .getByRole("combobox", { name: "个人项目" })
    .selectOption(project.id);
  let editor = page.getByLabel("输入消息", { exact: true });
  await editor.fill("请分析 结论");
  await editor.evaluate((element) => {
    const r = document.createRange();
    r.setStart(element.firstChild, 4);
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await upload("三七互娱.docx", "document fixture");
  await editor.getByRole("link", { name: "预览 三七互娱.docx" }).waitFor();
  assert.equal(await editor.textContent(), "请分析 📄三七互娱.docx× 结论");
  assert.equal(report.uploads[0].path, "三七互娱.docx");
  assert(!(await editor.innerText()).includes("项目文件："));
  assert.equal(
    await editor.locator("[data-file-reference]").getAttribute("title"),
    "三七互娱.docx",
  );
  await upload("三七互娱.docx", "second document");
  await editor.getByRole("link", { name: "预览 三七互娱 (1).docx" }).waitFor();
  await editor.press(
    (await page.evaluate(() => navigator.platform)).includes("Mac")
      ? "Meta+z"
      : "Control+z",
  );
  assert.equal(
    await editor.getByRole("link", { name: "预览 三七互娱 (1).docx" }).count(),
    0,
  );
  await editor.press(
    (await page.evaluate(() => navigator.platform)).includes("Mac")
      ? "Meta+Shift+z"
      : "Control+Shift+z",
  );
  await editor.getByRole("link", { name: "预览 三七互娱 (1).docx" }).waitFor();
  assert.equal(
    store.read(project.id, "三七互娱.docx").toString(),
    "document fixture",
  );
  report.checks.push(
    "root upload, saved caret insertion, blue named file atoms, hidden raw paths, atomic collision rename",
  );
  await page.getByRole("button", { name: /settings|设置/i }).click();
  const toggle = page.getByRole("switch", { name: "上传文件保存到当前项目" });
  await toggle.waitFor();
  assert(await toggle.isChecked());
  await toggle.uncheck();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await upload("会话资料.txt", "会话附件内容");
  await editor.getByRole("link", { name: "预览 会话资料.txt" }).waitFor();
  const privateFile = report.uploads.at(-1);
  assert(privateFile.path.startsWith(".workagent-attachments/"));
  assert(
    !store.listFiles(project.id).some((file) => file.name === "会话资料.txt"),
  );
  await editor.getByRole("link", { name: "预览 会话资料.txt" }).click();
  await page.getByText("会话附件内容", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "关闭文件侧栏", exact: true })
    .first()
    .click();
  report.checks.push(
    "general setting defaults on, switches to durable outside-project storage and previews its content",
  );
  await editor.getByRole("button", { name: "移除引用 会话资料.txt" }).click();
  assert.equal(
    store.read(project.id, privateFile.path).toString(),
    "会话附件内容",
  );
  await editor.press("Control+End");
  await editor.pressSequentially(" @已存在");
  await page.getByRole("button", { name: "已存在.txt", exact: true }).click();
  await editor.getByRole("link", { name: "预览 已存在.txt" }).waitFor();
  report.checks.push(
    "@ references the existing file and removing an atom does not delete uploaded files",
  );
  // A chooser, paste and drop all use the same uploader and selected destination.
  await dropOrPaste("paste", "粘贴.txt", "paste");
  await editor.getByRole("link", { name: "预览 粘贴.txt" }).waitFor();
  await dropOrPaste("drop", "拖入.txt", "drop");
  await editor.getByRole("link", { name: "预览 拖入.txt" }).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({
      path: join(out, `composer-${width}.png`),
      fullPage: true,
    });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  report.phase = "send";
  await page.locator(".workagent-hero-composer button[type=submit]").click();
  await page.getByLabel("继续对话", { exact: true }).waitFor();
  const sent = page.locator(".workagent-message.is-user");
  await sent.getByRole("link", { name: /三七互娱 \(1\)/ }).waitFor();
  assert(!(await sent.innerText()).includes("项目文件："));
  assert.equal(
    fileReferenceParts(report.sends[0].content).filter((part) => part.reference)
      .length,
    5,
  );
  report.checks.push(
    "paste and drag attachments, responsive layout, send preserves durable references with named message links",
  );
  await sent.hover();
  await sent.getByRole("button", { name: "编辑", exact: true }).click();
  await page
    .getByLabel("编辑消息", { exact: true })
    .getByRole("link", { name: "预览 已存在.txt" })
    .waitFor();
  await page.getByRole("button", { name: "保存并重发" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "fixture_resend_rejected" })
    .waitFor();
  await page
    .getByLabel("编辑消息", { exact: true })
    .getByRole("link", { name: "预览 已存在.txt" })
    .waitFor();
  await page.getByRole("button", { name: "取消编辑", exact: true }).click();
  editor = page.getByLabel("继续对话", { exact: true });
  await upload("恢复草稿.txt", "draft");
  await editor.getByRole("link", { name: "预览 恢复草稿.txt" }).waitFor();
  await page.waitForTimeout(300);
  report.phase = "reload";
  await page.reload();
  await editor.getByRole("link", { name: "预览 恢复草稿.txt" }).waitFor();
  report.phase = "restored";
  await page.getByRole("button", { name: /settings|设置/i }).click();
  assert(
    !(await page
      .getByRole("switch", { name: "上传文件保存到当前项目" })
      .isChecked()),
  );
  await page.keyboard.press("Escape");
  report.checks.push(
    "history editing preserves references after rejected resend; draft and upload preference survive reload",
  );
  await page.screenshot({
    path: join(out, "conversation.png"),
    fullPage: true,
  });
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.failure = error.stack;
  await page.screenshot({ path: join(out, "failure.png"), fullPage: true });
  throw error;
} finally {
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
}
async function upload(name, content) {
  fileBytes.set(name, Buffer.from(content));
  await page
    .getByLabel("选择会话附件")
    .last()
    .setInputFiles({
      name,
      mimeType: "application/octet-stream",
      buffer: Buffer.from(content),
    });
}
async function dropOrPaste(kind, name, content) {
  fileBytes.set(name, Buffer.from(content));
  await page.locator(".workagent-composer-input").evaluate(
    (element, { kind, name, content }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([content], name));
      element.dispatchEvent(
        kind === "paste"
          ? new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: transfer,
            })
          : new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
            }),
      );
    },
    { kind, name, content },
  );
}
