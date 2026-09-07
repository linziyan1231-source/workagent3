import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  baseURL,
  json,
  withPage,
  resolveRemoteSmokeProcess,
  adminJson,
  smokeUsername,
  openDshAfterRestart,
} from "./smoke-dsh-helpers.mjs";

// Run only after other employee acceptance turns finish: this restarts that employee's runtime.
const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
const sid = process.env.WORKAGENT_SMOKE_SID;
if (
  !evidence ||
  !process.env.WORKAGENT_SMOKE_SSH_TARGET ||
  !sid ||
  !process.env.WORKAGENT_SMOKE_ADMIN_USERNAME
)
  throw new Error(
    "Evidence directory, SSH target and exact employee SID required",
  );
await mkdir(evidence, { recursive: true });
await withPage(async (page) => {
  const report = { startedAt: new Date().toISOString(), sessions: [] };
  const rpc = async (method, payload) => {
    const result = await json(page, `/api/${method}`, {
      method: "POST",
      body: JSON.stringify({
        type: "client-request",
        rpcId: crypto.randomUUID(),
        method,
        payload,
      }),
    });
    assert.equal(result.result?.ok, true, JSON.stringify(result));
    return result.result.value;
  };
  const history = async (id) =>
    (await rpc("session.history", { sessionId: id })).projections.values
      .nativeSession;
  const turn = async (id, text, marker) => {
    const priorIds = new Set((await history(id)).messages.map((row) => row.id));
    await rpc("session.prompt", {
      sessionId: id,
      mode: "queue",
      content: [{ type: "text", text }],
    });
    for (let attempt = 0; attempt < 150; attempt++) {
      const projection = await history(id);
      const user = projection.messages.findLast((row) => row.role === "user");
      const answer = projection.messages.findLast(
        (row) => row.role === "assistant",
      );
      if (
        projection.activity.state === "idle" &&
        answer &&
        !priorIds.has(answer.id) &&
        answer.nativeTurnId === user?.nativeTurnId &&
        answer.text.includes(marker)
      ) {
        const state = await json(page, `/api/runtime/v1/sessions/${id}`);
        assert.equal(state.lastTurn.status, "completed");
        assert.equal(state.lastTurn.id, user.nativeTurnId);
        return projection;
      }
      await page.waitForTimeout(1000);
    }
    throw new Error(`Native recovery turn did not finish: ${id}`);
  };
  try {
    for (const engine of ["codex", "kimi"]) {
      const marker = `RECOVERY_${engine}_${Date.now()}`;
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
      const entry = { engine, id: session.id, marker };
      report.sessions.push(entry);
      const models = await rpc("session.models", { sessionId: session.id });
      const model = models.groups
        .flatMap((group) => group.models)
        .find((row) => row.id === models.current.model);
      const effort =
        model.reasoning?.efforts.find(
          (row) => row.id !== models.current.reasoningEffort,
        )?.id ?? models.current.reasoningEffort;
      const selection = {
        ...models.current,
        ...(effort ? { reasoningEffort: effort } : {}),
      };
      entry.selection = selection;
      const selected = await rpc("session.selectModel", {
        sessionId: session.id,
        ...selection,
      });
      assert.deepEqual(selected.selected, selection);
      assert.deepEqual(
        (await rpc("session.models", { sessionId: session.id })).current,
        selection,
      );
      const before = await turn(
        session.id,
        `记住口令 ${marker}，只回复此口令，不调用工具、不修改文件。`,
        marker,
      );
      assert.equal(before.metadata.permissionMode, "read_only");
      entry.before = before;
    }
    const visible = report.sessions[0];
    await page.goto(`${baseURL}/?frontend=dsh&session=${visible.id}`);
    await page
      .locator(".workagent-message.is-assistant")
      .filter({ hasText: visible.marker })
      .first()
      .waitFor();
    report.pidBefore = await resolveRemoteSmokeProcess(0, "node.exe", sid);
    const active = (await json(page, "/api/runtime/v1/sessions")).filter(
      (session) => ["running", "retrying"].includes(session.activity?.state),
    );
    assert.deepEqual(
      active.map((session) => session.id),
      [],
      "Coordinate active employee turns before the recovery restart",
    );
    // Use the existing employee-manager lifecycle to stop AND start the runtime.
    // The low-level system/restart signal only terminates the current UserHost.
    const maintenance = await adminJson(
      page,
      "/api/portal/admin/users/restart",
      {
        method: "POST",
        body: JSON.stringify({ username: smokeUsername }),
      },
    );
    assert.equal(maintenance.success, true);
    assert.ok(maintenance.job?.id);
    report.restartJobId = maintenance.job.id;
    for (let attempt = 0; attempt < 90; attempt++) {
      const { job } = await adminJson(
        page,
        `/api/portal/admin/user-jobs?id=${encodeURIComponent(report.restartJobId)}`,
      );
      report.restartStatus = job.status;
      if (["succeeded", "failed"].includes(job.status)) {
        assert.equal(job.status, "succeeded", job.error_message);
        break;
      }
      await page.waitForTimeout(1000);
    }
    assert.equal(report.restartStatus, "succeeded");
    // Managed restart disables/re-enables the employee and revokes authentication.
    // Recover through the existing login flow before probing employee-owned data.
    await openDshAfterRestart(page, `/?frontend=dsh&session=${visible.id}`);
    report.reauthenticated = true;
    const health = await json(page, "/api/runtime/v1/system/status");
    assert.ok(health.components.every((row) => row.status === "healthy"));
    report.pidAfter = await resolveRemoteSmokeProcess(0, "node.exe", sid);
    assert.ok(report.pidAfter);
    assert.notEqual(report.pidAfter, report.pidBefore);
    for (const entry of report.sessions) {
      const restored = await history(entry.id);
      assert.deepEqual(restored.messages, entry.before.messages);
      assert.equal(
        restored.metadata.workspaceId,
        entry.before.metadata.workspaceId,
      );
      assert.equal(restored.metadata.permissionMode, "read_only");
      assert.deepEqual(
        (await rpc("session.models", { sessionId: entry.id })).current,
        entry.selection,
      );
      entry.after = await turn(
        entry.id,
        "最初记住的口令是什么？只回复口令，不调用工具、不修改文件。",
        entry.marker,
      );
      if (entry.id === visible.id)
        await page
          .locator(".workagent-message.is-assistant")
          .filter({ hasText: entry.marker })
          .nth(1)
          .waitFor({ timeout: 30000 });
      const fork = await rpc("session.fork", { sessionId: entry.id });
      assert.notEqual(fork.sessionId, entry.id);
      entry.forkId = fork.sessionId;
      const child = await turn(
        fork.sessionId,
        "最初记住的口令是什么？只回复口令，不调用工具、不修改文件。",
        entry.marker,
      );
      assert.equal(child.metadata.parentSessionId, entry.id);
      entry.fork = child;
      await page.goto(`${baseURL}/?frontend=dsh&session=${entry.id}`);
      await page
        .locator(".workagent-message.is-assistant")
        .filter({ hasText: entry.marker })
        .nth(1)
        .waitFor();
      await page.screenshot({
        path: join(evidence, `${entry.engine}-standard-recovery.png`),
        animations: "disabled",
      });
      console.log(
        `${entry.engine}: standard model selection, real restart, history, native context and standard fork passed`,
      );
    }
    report.status = "passed";
  } finally {
    if (report.status !== "passed")
      for (const entry of report.sessions) {
        for (const id of [entry.id, entry.forkId].filter(Boolean))
          await rpc("session.cancel", { sessionId: id }).catch(() => {});
      }
    report.finishedAt = new Date().toISOString();
    await writeFile(
      join(evidence, "native-recovery-real.json"),
      JSON.stringify(report, null, 2),
    );
  }
});
