import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AutomationScheduler, AutomationStore } from "./automation-store.js";
import { TeamOrchestrator, TeamStore } from "./team-store.js";
import { QuotaAutomationRunner, QuotaTeamRunner } from "./quota-runner.js";
import { PersonalQuotaSettlements } from "./quota-settlement.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const presets = {
  resolve: () => ({ resolvedSnapshot: { modelId: "codex-native" } }),
};

function fixture(
  kind: "automation" | "team",
  gate: ReturnType<typeof deferred>,
  reserveFailure?: string,
) {
  const home = mkdtempSync(join(tmpdir(), "workagent-quota-shutdown-review-"));
  const reserving = deferred();
  const execute = vi.fn(async () => ({ sessionId: "session-after-quota" }));
  const cancel = vi.fn(async () => {});
  const settle = vi.fn(
    async (_request: { runId: string; actualUnits: number }) => {},
  );
  const reserve = vi.fn(
    async (input: { runId: string; estimatedUnits: number }) => {
      reserving.resolve();
      await gate.promise;
      if (reserveFailure) throw new Error(reserveFailure);
      return {
        runId: input.runId,
        sid: "S-1-5-21-review",
        modelId: "codex-native",
        period: "daily" as const,
        periodKey: "2026-09-12",
        reservedUnits: input.estimatedUnits,
        actualUnits: null,
        status: "reserved" as const,
      };
    },
  );
  const settlements = new PersonalQuotaSettlements(home, { reserve, settle });
  if (kind === "automation") {
    const store = new AutomationStore(home);
    const definition = store.create({
      name: "Review",
      enabled: false,
      schedule: { kind: "interval", everyMinutes: 5 },
      presetId: "builtin-codex",
      engine: "codex",
      workspaceId: "default",
      input: "Draft report",
      notificationPolicy: "none",
    });
    store.runNow(definition.id);
    const runner = new QuotaAutomationRunner(
      { execute, cancel },
      presets,
      { reserve, settle },
      settlements,
    );
    return {
      home,
      settlements,
      reserving,
      execute,
      cancel,
      settle,
      worker: new AutomationScheduler(store, runner),
    };
  }
  const store = new TeamStore(home);
  const team = store.create({
    name: "Review",
    workspaceId: "default",
    lead: { name: "Lead", engine: "codex", presetId: "builtin-codex" },
  });
  store.queueTask(team.id, {
    title: "Review",
    memberId: team.members[0]!.id,
    input: "Draft report",
  });
  const runner = new QuotaTeamRunner(
    { executeTeamTask: execute, cancelTeamTask: cancel },
    presets,
    { reserve, settle },
    settlements,
  );
  return {
    home,
    settlements,
    reserving,
    execute,
    cancel,
    settle,
    worker: new TeamOrchestrator(store, runner),
  };
}

describe.each(["automation", "team"] as const)("%s quota boundary", (kind) => {
  it("drops cancelled admission only after a definite rejection and keeps ambiguous failures", async () => {
    for (const error of [
      "quota_exceeded",
      "model_not_authorized",
      "network_timeout",
    ]) {
      const gate = deferred();
      const f = fixture(kind, gate, error);
      const work = f.worker.tick();
      await f.reserving.promise;
      const stop = f.worker.stop();
      await Promise.resolve();
      gate.resolve();
      await work;
      await stop;
      const document = JSON.parse(
        readFileSync(
          join(f.home, "workagent", "personal-quota-settlements.json"),
          "utf8",
        ),
      );
      expect(document.entries).toHaveLength(
        error === "network_timeout" ? 1 : 0,
      );
      expect(f.execute).not.toHaveBeenCalled();
    }
  });
  it("does not start an engine when quota reserve responds after shutdown cancellation", async () => {
    const gate = deferred();
    const f = fixture(kind, gate);
    const work = f.worker.tick();
    await f.reserving.promise;
    const stopping = f.worker.stop();
    await Promise.resolve();
    expect(f.cancel).toHaveBeenCalledTimes(1);
    gate.resolve();
    await work;
    await stopping;
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.settle).toHaveBeenCalledWith(
      expect.objectContaining({ actualUnits: 0 }),
    );
  });

  it("does not replace a completed run with zero usage when the first settlement request cannot be sent", async () => {
    const gate = deferred();
    gate.resolve();
    const f = fixture(kind, gate);
    f.settle.mockRejectedValueOnce(
      new Error("transport_unavailable_before_send"),
    );
    await f.worker.tick();
    await f.worker.stop();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(
      f.settle.mock.calls.every(([request]) => request.actualUnits > 0),
    ).toBe(true);
    const completed = f.settle.mock.calls[0]![0];
    const settle = vi.fn(async () => {});
    const restarted = new PersonalQuotaSettlements(f.home, {
      reserve: vi.fn(),
      settle,
    });
    expect(restarted.get(completed.runId)).toBe(completed.actualUnits);
    const stopRecovery = restarted.startRecovery();
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith(completed));
    await stopRecovery();
    expect(
      new PersonalQuotaSettlements(f.home, { reserve: vi.fn(), settle }).get(
        completed.runId,
      ),
    ).toBeUndefined();
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("replays the same zero completion after cancellation or engine failure even when the task is terminal", async () => {
    for (const cancelled of [false, true]) {
      const gate = deferred();
      const f = fixture(kind, gate);
      f.settle.mockRejectedValue(new Error("offline"));
      if (!cancelled) f.execute.mockRejectedValue(new Error("engine_failed"));
      const work = f.worker.tick();
      await f.reserving.promise;
      const stopped = cancelled ? f.worker.stop() : undefined;
      await Promise.resolve();
      gate.resolve();
      await work;
      await (stopped ?? f.worker.stop());
      const completed = f.settle.mock.calls[0]![0];
      expect(completed.actualUnits).toBe(0);
      const settle = vi.fn(async () => {});
      const restarted = new PersonalQuotaSettlements(f.home, {
        reserve: vi.fn(),
        settle,
      });
      const stopRecovery = restarted.startRecovery();
      await vi.waitFor(() => expect(settle).toHaveBeenCalledWith(completed));
      await stopRecovery();
      expect(
        new PersonalQuotaSettlements(f.home, { reserve: vi.fn(), settle }).get(
          completed.runId,
        ),
      ).toBeUndefined();
      expect(f.execute).toHaveBeenCalledTimes(cancelled ? 0 : 1);
    }
  });
});
