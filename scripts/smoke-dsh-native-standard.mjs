import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { createRequire } from "node:module";
import { request } from "playwright";
import { baseURL, json, withPage } from "./smoke-dsh-helpers.mjs";

const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
const JSZip = createRequire(
  new URL("../packages/dsh-client-workagent/package.json", import.meta.url),
)("jszip");
if (!evidence) throw new Error("WORKAGENT_SMOKE_EVIDENCE_DIR required");
await mkdir(evidence, { recursive: true });
await withPage(async (page) => {
  const report = [];
  const rpc = async (method, payload) => {
    const response = await json(page, `/api/${method}`, {
      method: "POST",
      body: JSON.stringify({
        type: "client-request",
        rpcId: crypto.randomUUID(),
        method,
        payload,
      }),
    });
    assert.equal(response.result?.ok, true, JSON.stringify(response));
    return response.result.value;
  };
  const history = async (id) =>
    (await rpc("session.history", { sessionId: id })).projections?.values
      ?.nativeSession;
  const startMux = async (sessionId) => {
    await page.evaluate(async (sessionId) => {
      const url = new URL("/api/events.mux", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      const state = {
        frames: [],
        error: null,
        socket,
        sessionId,
        closing: false,
      };
      window.__nativeReadApprovalSmoke = state;
      socket.addEventListener("message", (event) => {
        try {
          const frame = JSON.parse(event.data);
          if (
            frame.payload?.sessionId === sessionId &&
            frame.payload.type?.startsWith("approval/")
          )
            state.frames.push(frame);
        } catch (error) {
          state.error = String(error);
        }
      });
      socket.addEventListener("error", () => {
        if (!state.closing) state.error = "Standard mux WebSocket error";
      });
      socket.addEventListener("close", (event) => {
        if (!state.closing)
          state.error = `Standard mux WebSocket closed (${event.code})`;
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          state.closing = true;
          socket.close();
          reject(new Error("Standard mux WebSocket open timed out"));
        }, 15000);
        socket.addEventListener(
          "open",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        socket.addEventListener(
          "error",
          () => {
            clearTimeout(timer);
            reject(new Error("Standard mux WebSocket connection failed"));
          },
          { once: true },
        );
        socket.addEventListener(
          "close",
          (event) => {
            clearTimeout(timer);
            reject(new Error(`Standard mux WebSocket closed (${event.code})`));
          },
          { once: true },
        );
      });
    }, sessionId);
  };
  const frames = () =>
    page.evaluate(() => ({
      frames: window.__nativeReadApprovalSmoke.frames,
      error: window.__nativeReadApprovalSmoke.error,
    }));
  const stopMux = () =>
    page.evaluate(async () => {
      const state = window.__nativeReadApprovalSmoke;
      if (!state || state.socket.readyState === WebSocket.CLOSED) return;
      state.closing = true;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        state.socket.addEventListener(
          "close",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        state.socket.close(1000);
      });
    });
  const exactReadCommand = "Get-ChildItem -LiteralPath . -File -Name";
  const isExactReadCommand = (command) => {
    if (command === exactReadCommand) return true;
    if (typeof command !== "string") return false;
    const wrapped = /^"([^"\r\n]+)" -Command '([^'\r\n]+)'$/.exec(command);
    return (
      !!wrapped &&
      wrapped[1].replace(/\\+/g, "\\") ===
        String.raw`C:\Program Files\PowerShell\7\pwsh.exe` &&
      wrapped[2] === exactReadCommand
    );
  };
  const allowedReads = [];
  const answered = new Set();
  const allowExactProjectRead = async (sessionId, projectCwd, engine) => {
    const observed = await frames();
    if (observed.error) throw new Error(observed.error);
    for (const frame of observed.frames) {
      if (
        frame.payload.type !== "approval/requested" ||
        answered.has(frame.rpcId)
      )
        continue;
      const pending = await json(
        page,
        `/api/runtime/v1/interactions?sessionId=${encodeURIComponent(sessionId)}`,
      );
      const item = pending.find(
        (item) =>
          item.id === frame.payload.approvalId &&
          item.sessionId === sessionId &&
          item.status === "pending",
      );
      if (!item) continue;
      const cwd = item.input?.cwd;
      const sameProject =
        typeof cwd === "string" &&
        typeof projectCwd === "string" &&
        win32.isAbsolute(cwd) &&
        win32.isAbsolute(projectCwd) &&
        win32.normalize(cwd).toLowerCase() ===
          win32.normalize(projectCwd).toLowerCase();
      const exact =
        engine === "codex" &&
        item.native === true &&
        sameProject &&
        item.input?.kind === "command" &&
        item.input.turnId === item.turnId &&
        isExactReadCommand(item.input.command) &&
        item.tool === item.input.command &&
        item.options?.includes("accept") &&
        item.input.availableDecisions?.includes("accept") &&
        frame.type === "server-request" &&
        frame.method === "approval/requested" &&
        frame.payload.sessionId === sessionId &&
        frame.rpcId === `workagent-native-approval:${item.id}` &&
        !allowedReads.some((row) => row.sessionId === sessionId);
      if (!exact) {
        await writeFile(
          join(evidence, `${engine}-read-refused.json`),
          JSON.stringify(
            {
              sessionId,
              engine,
              projectCwd,
              item,
              frame,
              checks: {
                native: item.native === true,
                sameProject,
                commandKind: item.input?.kind === "command",
                sameTurn: item.input?.turnId === item.turnId,
                exactCommand: isExactReadCommand(item.input?.command),
                sameTool: item.tool === item.input?.command,
                acceptsOnce: item.options?.includes("accept"),
                alreadyAllowed: allowedReads.some(
                  (row) => row.sessionId === sessionId,
                ),
              },
            },
            null,
            2,
          ),
        );
        await rpc("session.cancel", { sessionId });
        throw new Error(
          "Refused unexpected approval: only one exact Get-ChildItem command in this session's project is authorized",
        );
      }
      const receipt = await json(page, "/api/respond", {
        method: "POST",
        body: JSON.stringify({
          type: "client-response",
          rpcId: frame.rpcId,
          result: {
            ok: true,
            value: {
              sessionId,
              approvalId: item.id,
              outcome: "allowed-once",
            },
          },
        }),
      });
      assert.equal(
        receipt.accepted,
        true,
        "Exact project read approval was not accepted",
      );
      answered.add(frame.rpcId);
      allowedReads.push({
        sessionId,
        approvalId: item.id,
        rpcId: frame.rpcId,
        command: item.input.command,
        cwd,
        outcome: "allowed-once",
      });
    }
  };
  const settled = async (id, marker, cwd, engine) => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await allowExactProjectRead(id, cwd, engine);
      const projection = await history(id);
      if (
        projection?.activity.state === "idle" &&
        projection.messages.some(
          (row) => row.role === "assistant" && row.text.includes(marker),
        )
      )
        return projection;
      if (projection?.activity.state === "idle" && projection.activity.message)
        throw new Error(projection.activity.message);
      await page.waitForTimeout(750);
    }
    throw new Error(`Native standard turn timed out: ${id}`);
  };
  for (const engine of ["codex", "kimi"]) {
    const marker = `standard-${engine}-${Date.now()}`;
    const session = await json(page, "/api/runtime/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        engine,
        presetId: `builtin-${engine}`,
        title: marker,
        workspace: "default",
        modelId: engine === "codex" ? "gpt-6-astra" : "kimi-code/kimi-k3",
        thinkingEffort: "low",
        permissionMode: "read_only",
      }),
    });
    const listed = await rpc("session.list", {});
    assert.ok(listed.items.some((row) => row.sessionId === session.id));
    const initial = await history(session.id);
    assert.equal(initial.metadata.engine, engine);
    assert.equal(initial.metadata.workspaceId, session.workspaceId);
    const config = await rpc("session.models", { sessionId: session.id });
    assert.equal(config.current.provider, engine);
    const projectCwd = listed.items.find(
      (row) => row.sessionId === session.id,
    ).cwd;
    assert.ok(projectCwd, "Native session must expose its project cwd");
    let completed;
    try {
      await startMux(session.id);
      await rpc("session.prompt", {
        sessionId: session.id,
        mode: "queue",
        content: [
          {
            type: "text",
            text:
              engine === "kimi"
                ? `请实际调用原生 Glob 工具，在项目目录 ${projectCwd} 用非递归模式 * 列出第一层文件名。只访问这个项目，不使用 Bash 或其他 shell 工具，不执行命令，不修改文件。始终保持当前只读/计划模式，不调用 ExitPlanMode，不提交计划审批，不新建计划文件。Glob 返回后直接发送最终文本回复口令 ${marker}。`
                : `请使用一个只读工具列出当前项目根目录的一层文件名，不访问其他目录。Windows PowerShell 请严格使用这一条命令，不追加其他语句或参数：Get-ChildItem -LiteralPath . -File -Name。如果需要审批，请只请求这条命令并等待。然后回复口令 ${marker}。`,
          },
        ],
      });
      completed = await settled(session.id, marker, projectCwd, engine);
    } catch (error) {
      await rpc("session.cancel", { sessionId: session.id }).catch(() => {});
      throw error;
    } finally {
      const observed = await frames().catch(() => ({
        frames: [],
        error: "mux unavailable",
      }));
      await writeFile(
        join(evidence, `${engine}-standard-read-approvals.json`),
        JSON.stringify(
          {
            allowed: allowedReads.filter((row) => row.sessionId === session.id),
            ...observed,
          },
          null,
          2,
        ),
      );
      await stopMux();
    }
    assert.ok(completed.messages.some((row) => row.role === "user"));
    assert.ok(
      Object.keys(completed.tools).length > 0,
      "Real engine did not produce a tool call",
    );
    await page.goto(`${baseURL}/?frontend=dsh&session=${session.id}`);
    await page
      .locator(".workagent-message.is-assistant")
      .filter({ hasText: marker })
      .first()
      .waitFor({ timeout: 30000 });
    await page.reload();
    await page
      .locator(".workagent-message.is-assistant")
      .filter({ hasText: marker })
      .first()
      .waitFor({ timeout: 30000 });
    const restored = await history(session.id);
    assert.deepEqual(restored.messages, completed.messages);
    const download = await page.request.get(
      `${baseURL}/api/session.export?sessionId=${session.id}`,
    );
    assert.equal(download.status(), 200);
    assert.match(download.headers()["content-type"], /zip/);
    const archive = await download.body();
    assert.equal(archive.readUInt32LE(0), 0x04034b50);
    const zip = await JSZip.loadAsync(archive);
    const log = Object.values(zip.files).find(
      (file) => !file.dir && file.name.endsWith(".jsonl"),
    );
    assert.ok(log, "Official export contains no JSONL artifact");
    const raw = await log.async("string");
    assert.ok(raw.includes('"type":"user/message"'));
    assert.ok(raw.includes('"type":"workagent/native/event"'));
    assert.ok(raw.includes('"type":"tool.completed"'));
    assert.equal(
      raw.includes('"type":"request/header"'),
      false,
      "Native task fabricated a DSH model request",
    );
    await writeFile(
      join(evidence, `${engine}-official-session-log.zip`),
      archive,
    );
    await writeFile(
      join(evidence, `${engine}-standard-projection.json`),
      JSON.stringify(restored, null, 2),
    );
    await page.screenshot({
      path: join(evidence, `${engine}-standard-real.png`),
      animations: "disabled",
    });
    await rpc("session.prompt", {
      sessionId: session.id,
      mode: "queue",
      content: [
        {
          type: "text",
          text: "请运行只读等待命令等待 20 秒，然后回复 WAIT_FINISHED。不要修改文件。",
        },
      ],
    });
    await page
      .getByRole("button", { name: "停止", exact: true })
      .waitFor({ timeout: 30000 });
    const queuedMarker = `queued-until-explicit-retry-${engine}`;
    await rpc("session.prompt", {
      sessionId: session.id,
      mode: "queue",
      content: [{ type: "text", text: queuedMarker }],
    });
    const waiting = await history(session.id);
    assert.equal(waiting.metadata.queue.length, 1);
    const cancellation = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/session.cancel") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "停止", exact: true }).click();
    assert.equal((await (await cancellation).json()).result.ok, true);
    let stopped;
    for (let attempt = 0; attempt < 40; attempt++) {
      stopped = await history(session.id);
      if (stopped.activity.state === "idle") break;
      await page.waitForTimeout(500);
    }
    assert.equal(stopped.activity.state, "idle");
    assert.equal(
      stopped.metadata.queue.length,
      1,
      "Stop must retain queued input",
    );
    assert.equal(
      stopped.messages.some((row) => row.text === queuedMarker),
      false,
    );
    await writeFile(
      join(evidence, `${engine}-standard-stop-queue.json`),
      JSON.stringify(stopped, null, 2),
    );
    await rpc("session.updateQueue", {
      sessionId: session.id,
      itemId: stopped.metadata.queue[0].messageId,
      action: { kind: "remove" },
    });
    report.push({
      engine,
      sessionId: session.id,
      config,
      messages: restored.messages.length,
      officialZipBytes: archive.length,
    });
  }
  await writeFile(
    join(evidence, "native-standard-real.json"),
    JSON.stringify(report, null, 2),
  );
  if (
    process.env.WORKAGENT_SMOKE_SECOND_USERNAME &&
    process.env.WORKAGENT_SMOKE_SECOND_PASSWORD
  ) {
    const other = await request.newContext({ baseURL });
    try {
      const login = await other.post("/api/auth/login", {
        data: {
          username: process.env.WORKAGENT_SMOKE_SECOND_USERNAME,
          password: process.env.WORKAGENT_SMOKE_SECOND_PASSWORD,
        },
        headers: { Origin: new URL(baseURL).origin },
      });
      assert.equal(login.ok(), true, "Second employee login failed");
      const response = await other.post("/api/session.history", {
        data: {
          type: "client-request",
          rpcId: crypto.randomUUID(),
          method: "session.history",
          payload: { sessionId: report[0].sessionId },
        },
        headers: { Origin: new URL(baseURL).origin },
      });
      const value = await response.json();
      assert.equal(
        value.result?.ok,
        false,
        "Another employee could read the native session",
      );
      await writeFile(
        join(evidence, "native-standard-isolation.json"),
        JSON.stringify(
          { sessionId: report[0].sessionId, result: value.result },
          null,
          2,
        ),
      );
    } finally {
      await other.dispose();
    }
  }
  console.log(JSON.stringify(report));
});
