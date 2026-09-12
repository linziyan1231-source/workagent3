import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { baseURL, requireSmokeEnvironment } from "./smoke-dsh-helpers.mjs";

// Authenticated production shell; all prompt writes and target history are
// intercepted in this browser. No model calls or production messages are made.
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
requireSmokeEnvironment();
const out = `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/${engine}`;
await mkdir(out, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const report = { engine, checks: [], errors: [] };
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.on("pageerror", (error) => report.errors.push(error.message));
    await page.addInitScript(() =>
      localStorage.setItem("workagent.files.open", "false"),
    );
    const login = await page.request.post(`${baseURL}/api/auth/login`, {
      data: {
        username: process.env.WORKAGENT_SMOKE_USERNAME,
        password: process.env.WORKAGENT_SMOKE_PASSWORD,
      },
      headers: { Origin: new URL(baseURL).origin },
    });
    assert.ok(login.ok());
    await page.setViewportSize({ width, height: 1000 });
    const sessions = await (
      await page.request.get(`${baseURL}/api/runtime/v1/sessions`)
    ).json();
    const session = sessions.find(
      (row) => row.engine === "codex" && row.activity?.state !== "running",
    );
    assert.ok(session);
    let state = {
      sequence: 1000000000,
      metadata: { ...session, queue: [] },
      messages: [],
      processes: {},
      tools: {},
      draft: "",
      activity: { state: "idle" },
    };
    await page.routeWebSocket("**/api/events.mux", (ws) => {
      const server = ws.connectToServer();
      server.onMessage((data) => {
        if (String(data).includes(session.id)) return;
        ws.send(data);
      });
    });
    await page.route("**/api/session.history", async (route) => {
      const req = route.request().postDataJSON();
      if (req.payload?.sessionId !== session.id) return route.continue();
      await route.fulfill({
        json: {
          type: "server-response",
          rpcId: req.rpcId,
          result: {
            ok: true,
            value: {
              events: [],
              hasMore: false,
              projections: {
                asOfSeq: state.sequence,
                values: { nativeSession: state },
              },
            },
          },
        },
      });
    });
    let pending;
    const requests = [];
    await page.route("**/api/session.prompt", async (route) => {
      const req = route.request().postDataJSON();
      requests.push(req);
      pending = { route, req };
    });
    await page.goto(`${baseURL}/?frontend=dsh&session=${session.id}`);
    const input = page.getByRole("textbox", { name: "继续对话", exact: true });
    await input.waitFor();
    const submit = async (text) => {
      pending = null;
      await input.fill(text);
      await input.press("Enter");
      for (let n = 0; !pending && n < 100; n++) await page.waitForTimeout(50);
      assert.ok(pending, "prompt intercepted");
      return pending.req.rpcId;
    };
    const accept = async (queued = false) => {
      const { route, req } = pending;
      const row = {
        id: req.rpcId,
        sessionId: session.id,
        role: "user",
        text: req.payload.content[0].text,
        createdAt: new Date().toISOString(),
      };
      if (queued)
        state.metadata.queue = [
          { messageId: row.id, content: row.text, createdAt: row.createdAt },
        ];
      else state.messages.push(row);
      state.activity = { state: "running" };
      state.sequence++;
      await route.fulfill({
        json: {
          type: "server-response",
          rpcId: req.rpcId,
          result: { ok: true, value: { accepted: true } },
        },
      });
    };
    const id = await submit("请生成申请文书，发送后立刻显示这条指令。");
    const bubble = page.locator(`[data-message-id="${id}"]`);
    await bubble.getByText("发送中", { exact: false }).waitFor();
    assert.equal(await input.innerText(), "");
    await page.screenshot({ path: `${out}/${width}-sending.png` });
    await accept();
    await page.getByText("正在思考", { exact: true }).waitFor();
    assert.equal(await bubble.count(), 1);
    const queuedId = await submit("再补充一段职业规划。");
    await accept(true);
    await page
      .locator(`[data-message-id="${queuedId}"]`)
      .getByText("排队中", { exact: true })
      .waitFor();
    await page.screenshot({ path: `${out}/${width}-queued.png` });
    state.messages.push({
      id: queuedId,
      role: "user",
      text: "再补充一段职业规划。",
    });
    state.metadata.queue = [];
    state.messages.push({
      id: "done",
      role: "assistant",
      text: "同步恢复验证完成。",
    });
    state.activity = { state: "idle" };
    state.sequence++;
    await page
      .getByText("同步恢复验证完成。", { exact: true })
      .waitFor({ timeout: 15000 });
    assert.equal(
      await page.locator(`[data-message-id="${queuedId}"]`).count(),
      1,
    );
    const failedId = await submit("失败后保留原文并重试。");
    await input.fill("正在写下一条消息");
    await pending.route.fulfill({
      status: 503,
      json: { error: "fixture_send_failed" },
    });
    const failed = page.locator(`[data-message-id="${failedId}"]`);
    await failed.getByRole("button", { name: "重试" }).waitFor();
    assert.equal(await input.innerText(), "正在写下一条消息");
    pending = null;
    await failed.getByRole("button", { name: "重试" }).click();
    for (let n = 0; !pending && n < 100; n++) await page.waitForTimeout(50);
    assert.equal(pending.req.rpcId, failedId);
    await accept();
    await page.waitForTimeout(300);
    assert.equal(await failed.count(), 1);
    assert.equal(await input.innerText(), "正在写下一条消息");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    report.checks.push({
      width,
      immediateBubble: true,
      activeSync: true,
      missedPushRecovery: true,
      queueMerge: true,
      safeRetry: true,
      requests: requests.length,
    });
    // End error collection before closing the document and aborting its fetches.
    page.removeAllListeners("pageerror");
    await page.close();
  }
  assert.deepEqual(report.errors, []);
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify(report));
