import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  baseURL,
  login,
  requireSmokeEnvironment,
} from "./smoke-dsh-helpers.mjs";

requireSmokeEnvironment();
const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
if (!evidence) throw new Error("Evidence directory required");
await mkdir(evidence, { recursive: true });
const candidate = process.env.WORKAGENT_SMOKE_IM_CLIENT
  ? await readFile(process.env.WORKAGENT_SMOKE_IM_CLIENT, "utf8")
  : undefined;
const report = {
  status: "running",
  checks: [],
  errors: [],
  fixture:
    "browser response only; no production data or external messages changed",
};
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  if (candidate)
    await page.route(
      "**/plugins/@michengai/dsh-im-connect/client.js*",
      (route) =>
        route.fulfill({ contentType: "text/javascript", body: candidate }),
    );
  await login(page);
  const response = await page.request.get(`${baseURL}/api/runtime/v1/sessions`);
  assert.equal(response.status(), 200);
  const tasks = await response.json();
  const task = tasks.find(
    (row) =>
      row.engine === "codex" &&
      row.branchKind !== "side_chat" &&
      !row.id.startsWith("session-channel-"),
  );
  assert.ok(
    task,
    "An existing webpage task is required for read-only navigation",
  );
  const workspaces = await (
    await page.request.get(`${baseURL}/api/runtime/v1/workspaces`)
  ).json();
  const project =
    workspaces.find((row) => row.id === task.workspaceId)?.name || "默认项目";
  const fixture = {
    ok: true,
    groups: [
      {
        id: "weixin",
        label: "微信",
        sessions: [
          {
            channel: "weixin",
            kind: "dm",
            chatId: "im-unified-fixture",
            chatTitle: "接续验收私聊",
            sessionId: task.id,
            title: task.title,
            workspaceName: project,
            updatedAt: new Date().toISOString(),
          },
          {
            channel: "weixin",
            kind: "group",
            chatId: "im-unified-group",
            chatTitle: "接续验收群聊",
            sessionId: task.id,
            title: task.title,
            workspaceName: project,
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    ],
  };
  await page.route("**/dsh-im-connect/api/channels", (route) =>
    route.fulfill({ json: fixture }),
  );
  // Keep the actual task history and runtime responses; only model two external chat bindings.
  const channels = page.getByRole("button", { name: "频道", exact: true });
  const taskTab = page.getByRole("button", { name: "任务", exact: true });
  await channels.click();
  const first = page.locator(".ima-n-sess").filter({ hasText: "接续验收私聊" });
  await first.waitFor();
  assert.ok((await first.innerText()).includes(project));
  assert.ok((await first.innerText()).includes(task.title));
  assert.equal(await page.locator(".ima-n-sess").count(), 2);
  await page.screenshot({ path: join(evidence, "channels-desktop.png") });
  await first.click();
  await page.waitForURL((url) => url.searchParams.get("session") === task.id);
  await channels.waitFor();
  assert.equal(new URL(page.url()).searchParams.get("sidebar"), "channels");
  await page.locator(".workagent-conversation").first().waitFor();
  report.checks.push(
    "two independent chat entries point to the same existing webpage task",
    "channel row shows chat, project and task",
    "opening channel retains original task ID and conversation",
  );
  await taskTab.click();
  await page.locator(".workagent-sidebar-browser").waitFor();
  report.checks.push("task and channel navigation remain available");
  await channels.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(evidence, "channels-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await channels.waitFor();
  await page
    .locator(".ima-n-sess")
    .filter({ hasText: "接续验收私聊" })
    .waitFor();
  report.checks.push("channel view and binding survive reload");
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
