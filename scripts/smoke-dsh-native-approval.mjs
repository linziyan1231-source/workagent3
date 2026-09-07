import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseURL, json, withPage } from "./smoke-dsh-helpers.mjs";

// Run only after the release containing native standard approvals is activated.
// Authentication comes exclusively from the existing smoke helper environment.
const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
if (!evidence) throw new Error("WORKAGENT_SMOKE_EVIDENCE_DIR required");
await mkdir(evidence, { recursive: true });
const report = {
  startedAt: new Date().toISOString(),
  engine: "codex",
  cases: [],
  complete: false,
};

await withPage(async (page) => {
  const rpc = async (method, payload) => {
    const response = await json(page, `/api/${method}`, {
      method: "POST",
      body: JSON.stringify({
        type: "client-request",
        rpcId: randomUUID(),
        method,
        payload,
      }),
    });
    assert.equal(
      response.result?.ok,
      true,
      `${method}: ${JSON.stringify(response.result)}`,
    );
    return response.result.value;
  };
  const history = async (sessionId) => rpc("session.history", { sessionId });
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
      window.__nativeApprovalSmoke = state;
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
      frames: window.__nativeApprovalSmoke.frames,
      error: window.__nativeApprovalSmoke.error,
    }));
  const stopMux = () =>
    page.evaluate(async () => {
      const state = window.__nativeApprovalSmoke;
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
  const waitFrame = async (type, approvalId, timeout = 120000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const observed = await frames();
      if (observed.error) throw new Error(observed.error);
      const match = observed.frames.find(
        (frame) =>
          frame.payload.type === type &&
          (!approvalId || frame.payload.approvalId === approvalId),
      );
      if (match) return match;
      await page.waitForTimeout(500);
    }
    return undefined;
  };
  const idle = async (sessionId) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const value = await history(sessionId);
      if (value.projections?.values?.nativeSession?.activity.state === "idle")
        return value;
      await page.waitForTimeout(500);
    }
    throw new Error("Native turn did not settle after cancellation");
  };

  try {
    for (const decision of ["reject", "cancel"]) {
      const nonce = `${Date.now()}-${randomUUID()}`;
      const filename = `native-approval-smoke-${nonce}.txt`;
      const row = {
        decision,
        filename,
        status: "started",
        guarantees:
          "No approval is automatically allowed; only this relative project file is requested.",
      };
      report.cases.push(row);
      const created = await json(page, "/api/runtime/v1/sessions", {
        method: "POST",
        body: JSON.stringify({
          engine: "codex",
          presetId: "builtin-codex",
          title: `Native approval ${decision} ${nonce}`,
          workspace: "default",
          modelId: "gpt-6-astra",
          thinkingEffort: "low",
          permissionMode: "read_only",
        }),
      });
      row.sessionId = created.id;
      let muxStarted = false;
      try {
        const listed = await rpc("session.list", {});
        const summary = listed.items.find(
          (item) => item.sessionId === created.id,
        );
        assert.ok(
          summary?.cwd,
          "Created native session must expose its project cwd",
        );
        row.cwd = summary.cwd;
        const initial = await history(created.id);
        assert.equal(
          initial.projections?.values?.nativeSession?.metadata.engine,
          "codex",
        );
        await page.goto(
          `${baseURL}/?frontend=dsh&session=${encodeURIComponent(created.id)}`,
        );
        await page.getByText("WorkAgent", { exact: true }).waitFor();
        await startMux(created.id);
        muxStarted = true;
        const command = `[System.IO.File]::WriteAllText((Join-Path (Get-Location).Path '${filename}'), 'native-approval-smoke')`;
        await rpc("session.prompt", {
          sessionId: created.id,
          mode: "queue",
          content: [
            {
              type: "text",
              text: `请实际执行一个无害的原生 shell 操作：在当前项目工作目录中新建唯一文件 ${filename}，内容为 native-approval-smoke。Windows PowerShell 命令为：${command}。只允许这个相对文件名，不要访问或修改项目外路径，不要修改其他文件。当前是只读沙箱，如果执行需要权限，请通过原生 commandExecution/requestApproval 请求批准并等待；不要绕过沙箱，不要伪造执行。审批被拒绝后立即结束，不要换工具重试。`,
            },
          ],
        });
        const requested = await waitFrame("approval/requested");
        if (!requested) {
          row.status = "not-observed";
          row.limitation =
            "The real engine did not emit a native approval; it may refuse in read-only mode or use an unapproved capability. This case is not accepted.";
          continue;
        }
        assert.equal(requested.type, "server-request");
        assert.equal(requested.method, "approval/requested");
        assert.ok(requested.rpcId.startsWith("workagent-native-approval:"));
        row.requested = requested;
        const actual = await json(
          page,
          `/api/runtime/v1/interactions?sessionId=${encodeURIComponent(created.id)}`,
        );
        assert.ok(
          actual.some(
            (item) =>
              item.id === requested.payload.approvalId &&
              item.status === "pending" &&
              item.sessionId === created.id,
          ),
          "Standard frame must correspond to the actual live interaction",
        );
        if (decision === "reject") {
          row.receipt = await json(page, "/api/respond", {
            method: "POST",
            body: JSON.stringify({
              type: "client-response",
              rpcId: requested.rpcId,
              result: {
                ok: true,
                value: {
                  sessionId: created.id,
                  approvalId: requested.payload.approvalId,
                  outcome: "rejected",
                },
              },
            }),
          });
          assert.equal(row.receipt.accepted, true);
        } else await rpc("session.cancel", { sessionId: created.id });
        const resolved = await waitFrame(
          "approval/resolved",
          requested.payload.approvalId,
          30000,
        );
        assert.ok(resolved, "Actual approval must resolve on the standard mux");
        assert.equal(
          resolved.payload.outcome,
          decision === "reject" ? "rejected" : "cancelled",
        );
        row.resolved = resolved;
        // Do not allow any retry to outlive this explicitly bounded smoke case.
        await rpc("session.cancel", { sessionId: created.id });
        const final = await idle(created.id);
        const remaining = await json(
          page,
          `/api/runtime/v1/interactions?sessionId=${encodeURIComponent(created.id)}`,
        );
        assert.equal(remaining.length, 0);
        await writeFile(
          join(evidence, `native-approval-${decision}-history.json`),
          JSON.stringify(final, null, 2),
        );
        await page.screenshot({
          path: join(evidence, `native-approval-${decision}.png`),
          animations: "disabled",
        });
        row.status = "verified";
      } finally {
        await rpc("session.cancel", { sessionId: created.id }).catch(
          (error) => {
            row.cleanupError = String(error);
          },
        );
        if (muxStarted) {
          row.frames = (await frames()).frames;
          await stopMux();
        }
        row.finalHistory = await history(created.id).catch((error) => ({
          error: String(error),
        }));
      }
    }
    report.complete = report.cases.every((row) => row.status === "verified");
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(
      join(evidence, "native-approval-real.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify({
        complete: report.complete,
        cases: report.cases.map(({ decision, sessionId, status }) => ({
          decision,
          sessionId,
          status,
        })),
      }),
    );
  }
});
if (!report.complete)
  throw new Error(
    "Real native approval coverage incomplete; inspect native-approval-real.json",
  );
