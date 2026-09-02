import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  SharedTurnResult,
  SharedTurnRuntimeRequest,
} from "@workagent/contracts";
import type { AutomationExecution } from "./automation-store.js";
import type { TeamExecution } from "./team-store.js";
import {
  FailClosedAutomationRunner,
  FailClosedSharedTurnRunner,
  FailClosedTeamRunner,
  QuotaAutomationRunner,
  QuotaSharedTurnRunner,
  QuotaTeamRunner,
  SharedTurnQuotaJournal,
  estimatedAutomationUnits,
} from "./quota-runner.js";

const request: AutomationExecution = {
  automationRunId: "automation-run-1",
  definition: {
    id: "automation-1",
    version: 1,
    name: "Daily brief",
    enabled: true,
    schedule: { kind: "interval", everyMinutes: 5 },
    presetId: "preset-1",
    engine: "codex",
    workspaceId: "workspace-default",
    input: "Prepare the brief",
    notificationPolicy: "on_failure",
    executionMode: "new_conversation",
    conversationId: null,
    nextRunAt: "2026-08-31T00:05:00.000Z",
    lastRunAt: null,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  },
};

const presets = {
  resolve: vi.fn(() => ({
    resolvedSnapshot: { modelId: "codex-model-1" },
  })),
};

describe("QuotaAutomationRunner", () => {
  it("reserves before execution and settles the correlated successful run", async () => {
    const order: string[] = [];
    const reserve = vi.fn(async () => {
      order.push("reserve");
      return {
        runId: request.automationRunId,
        sid: "S-1-5-21-test",
        modelId: "codex-model-1",
        period: "daily" as const,
        periodKey: "2026-08-31",
        reservedUnits: estimatedAutomationUnits(request.definition.input),
        actualUnits: null,
        status: "reserved" as const,
      };
    });
    const execute = vi.fn(async () => {
      order.push("execute");
      return { sessionId: "session-1" };
    });
    const settle = vi.fn(async () => {
      order.push("settle");
    });
    const runner = new QuotaAutomationRunner({ execute }, presets, {
      reserve,
      settle,
    });

    await expect(runner.execute(request)).resolves.toEqual({
      sessionId: "session-1",
    });
    expect(order).toEqual(["reserve", "execute", "settle"]);
    expect(reserve).toHaveBeenCalledWith({
      runId: request.automationRunId,
      modelId: "codex-model-1",
      estimatedUnits: estimatedAutomationUnits(request.definition.input),
    });
    expect(settle).toHaveBeenCalledWith({
      runId: request.automationRunId,
      actualUnits: estimatedAutomationUnits(request.definition.input),
    });
  });

  it("does not execute when reservation fails", async () => {
    const execute = vi.fn();
    const runner = new QuotaAutomationRunner({ execute }, presets, {
      reserve: vi.fn().mockRejectedValue(new Error("quota_exceeded")),
      settle: vi.fn(),
    });
    await expect(runner.execute(request)).rejects.toThrow("quota_exceeded");
    expect(execute).not.toHaveBeenCalled();
  });

  it("releases the reservation and preserves an engine failure", async () => {
    const failure = new Error("engine_failed");
    const settle = vi.fn();
    const runner = new QuotaAutomationRunner(
      { execute: vi.fn().mockRejectedValue(failure) },
      presets,
      {
        reserve: vi.fn().mockResolvedValue({}),
        settle,
      },
    );
    await expect(runner.execute(request)).rejects.toBe(failure);
    expect(settle).toHaveBeenCalledWith({
      runId: request.automationRunId,
      actualUnits: 0,
    });
  });

  it("conservatively reconciles an interrupted automation reservation", async () => {
    const settle = vi.fn().mockResolvedValue(undefined);
    const runner = new QuotaAutomationRunner({ execute: vi.fn() }, presets, {
      reserve: vi.fn().mockResolvedValue({ status: "reserved" }),
      settle,
    });

    await runner.reconcileInterrupted(request);

    expect(settle).toHaveBeenCalledWith({
      runId: request.automationRunId,
      actualUnits: estimatedAutomationUnits(request.definition.input),
    });
  });

  it("accepts automation quota settled immediately before a crash", async () => {
    const settle = vi.fn();
    const runner = new QuotaAutomationRunner({ execute: vi.fn() }, presets, {
      reserve: vi.fn().mockResolvedValue({ status: "settled" }),
      settle,
    });

    await runner.reconcileInterrupted(request);

    expect(settle).not.toHaveBeenCalled();
  });
});

describe("QuotaTeamRunner", () => {
  const teamRequest = {
    taskId: "team-task-1",
    teamId: "team-1",
    memberId: "member-1",
    sessionId: "session-member-1",
    name: "Launch · Reviewer",
    engine: "codex" as const,
    presetId: "preset-1",
    workspaceId: "workspace-default",
    input: "Review launch",
  };

  it("attributes a successful member task to its durable task id", async () => {
    const reserve = vi.fn().mockResolvedValue({});
    const settle = vi.fn().mockResolvedValue(undefined);
    const executeTeamTask = vi
      .fn()
      .mockResolvedValue({ sessionId: "team-session-1", result: "done" });
    const runner = new QuotaTeamRunner({ executeTeamTask }, presets, {
      reserve,
      settle,
    });

    await expect(runner.executeTeamTask(teamRequest)).resolves.toEqual({
      sessionId: "team-session-1",
      result: "done",
    });
    expect(reserve).toHaveBeenCalledWith({
      runId: teamRequest.taskId,
      modelId: "codex-model-1",
      estimatedUnits: estimatedAutomationUnits(teamRequest.input),
    });
    expect(settle).toHaveBeenCalledWith({
      runId: teamRequest.taskId,
      actualUnits: estimatedAutomationUnits(teamRequest.input),
    });
  });

  it("releases a failed member task reservation and delegates cancellation", async () => {
    const settle = vi.fn().mockResolvedValue(undefined);
    const cancelTeamTask = vi.fn().mockResolvedValue(undefined);
    const failure = new Error("member_engine_failed");
    const runner = new QuotaTeamRunner(
      {
        executeTeamTask: vi.fn().mockRejectedValue(failure),
        cancelTeamTask,
      },
      presets,
      { reserve: vi.fn().mockResolvedValue({}), settle },
    );

    await expect(runner.executeTeamTask(teamRequest)).rejects.toBe(failure);
    expect(settle).toHaveBeenCalledWith({
      runId: teamRequest.taskId,
      actualUnits: 0,
    });
    await runner.cancelTeamTask(teamRequest.taskId);
    expect(cancelTeamTask).toHaveBeenCalledWith(teamRequest.taskId);
  });

  it("conservatively reconciles an interrupted task reservation", async () => {
    const reserve = vi.fn().mockResolvedValue({ status: "reserved" });
    const settle = vi.fn().mockResolvedValue(undefined);
    const runner = new QuotaTeamRunner({ executeTeamTask: vi.fn() }, presets, {
      reserve,
      settle,
    });

    await runner.reconcileInterruptedTeamTask(teamRequest);

    expect(reserve).toHaveBeenCalledWith({
      runId: teamRequest.taskId,
      modelId: "codex-model-1",
      estimatedUnits: estimatedAutomationUnits(teamRequest.input),
    });
    expect(settle).toHaveBeenCalledWith({
      runId: teamRequest.taskId,
      actualUnits: estimatedAutomationUnits(teamRequest.input),
    });
  });

  it("accepts an interrupted task that was already settled before the crash", async () => {
    const settle = vi.fn();
    const runner = new QuotaTeamRunner({ executeTeamTask: vi.fn() }, presets, {
      reserve: vi.fn().mockResolvedValue({ status: "settled" }),
      settle,
    });

    await runner.reconcileInterruptedTeamTask(teamRequest);

    expect(settle).not.toHaveBeenCalled();
  });
});

describe("QuotaSharedTurnRunner", () => {
  const sharedRequest: SharedTurnRuntimeRequest = {
    runId: "run-shared-1234567890",
    conversationId: "conversation-1234567",
    projectId: "project-1234567890",
    engine: "codex",
    modelId: "gpt-5",
    thinkingEffort: "medium",
    context: "Shared context",
    recoveryContext: "Full shared context",
    workspacePath: "/tmp/shared-project",
    payerSid: "S-1-5-21-2000",
  };
  const sharedResult: SharedTurnResult = {
    runId: sharedRequest.runId,
    runtimeSessionId: "session-shared-1",
    assistantBody: "Shared answer",
    recovered: false,
  };
  const sharedUnits = estimatedAutomationUnits(sharedRequest.context);
  const reservation = (status: "reserved" | "settled") => ({
    runId: sharedRequest.runId,
    sid: sharedRequest.payerSid,
    modelId: "gpt-5",
    period: "daily" as const,
    periodKey: "2026-09-01",
    reservedUnits: sharedUnits,
    actualUnits: null,
    status,
  });

  const sharedHome = () => mkdtempSync(join(tmpdir(), "shared-turn-quota-"));

  it("reserves against the frozen payer and settles the payer reservation", async () => {
    const order: string[] = [];
    const reserve = vi.fn(async () => {
      order.push("reserve");
      return reservation("reserved");
    });
    const executeSharedTurn = vi.fn(async () => {
      order.push("execute");
      return sharedResult;
    });
    const settle = vi.fn(async () => {
      order.push("settle");
    });
    const runner = new QuotaSharedTurnRunner(
      { executeSharedTurn, cancelSharedTurn: vi.fn() },
      { reserve, settle },
      new SharedTurnQuotaJournal(sharedHome()),
    );

    await expect(runner.executeSharedTurn(sharedRequest)).resolves.toEqual(
      sharedResult,
    );
    expect(order).toEqual(["reserve", "execute", "settle"]);
    expect(reserve).toHaveBeenCalledWith({
      runId: sharedRequest.runId,
      modelId: "gpt-5",
      estimatedUnits: sharedUnits,
      payerSid: sharedRequest.payerSid,
    });
    expect(settle).toHaveBeenCalledWith({
      runId: sharedRequest.runId,
      actualUnits: sharedUnits,
      payerSid: sharedRequest.payerSid,
    });
  });

  it("releases the payer reservation with zero usage when the turn fails", async () => {
    const failure = new Error("engine_failed");
    const settle = vi.fn().mockResolvedValue(undefined);
    const journal = new SharedTurnQuotaJournal(sharedHome());
    const runner = new QuotaSharedTurnRunner(
      {
        executeSharedTurn: vi.fn().mockRejectedValue(failure),
        cancelSharedTurn: vi.fn(),
      },
      { reserve: vi.fn().mockResolvedValue(reservation("reserved")), settle },
      journal,
    );

    await expect(runner.executeSharedTurn(sharedRequest)).rejects.toBe(failure);
    expect(settle).toHaveBeenCalledWith({
      runId: sharedRequest.runId,
      actualUnits: 0,
      payerSid: sharedRequest.payerSid,
    });
    expect(journal.pending()).toEqual([]);
  });

  it("keeps the journaled reservation when settlement fails", async () => {
    const home = sharedHome();
    const settle = vi.fn().mockRejectedValue(new Error("platform_unreachable"));
    const runner = new QuotaSharedTurnRunner(
      {
        executeSharedTurn: vi.fn().mockResolvedValue(sharedResult),
        cancelSharedTurn: vi.fn(),
      },
      { reserve: vi.fn().mockResolvedValue(reservation("reserved")), settle },
      new SharedTurnQuotaJournal(home),
    );

    const rejection = await runner
      .executeSharedTurn(sharedRequest)
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(AggregateError);
    // A fresh journal instance (process restart) still sees the reservation.
    expect(new SharedTurnQuotaJournal(home).pending()).toEqual([
      {
        runId: sharedRequest.runId,
        payerSid: sharedRequest.payerSid,
        modelId: "gpt-5",
        estimatedUnits: sharedUnits,
      },
    ]);
  });

  it("reconciles a reservation the process journaled before being killed", async () => {
    const home = sharedHome();
    // The process died between Reserve and Settle: the entry survived on disk.
    new SharedTurnQuotaJournal(home).track({
      runId: sharedRequest.runId,
      payerSid: sharedRequest.payerSid,
      modelId: "gpt-5",
      estimatedUnits: sharedUnits,
    });
    const recovered = new SharedTurnQuotaJournal(home);
    expect(recovered.pending()).toHaveLength(1);

    const settle = vi.fn().mockResolvedValue(undefined);
    const reconciler = new QuotaSharedTurnRunner(
      { executeSharedTurn: vi.fn(), cancelSharedTurn: vi.fn() },
      { reserve: vi.fn().mockResolvedValue(reservation("reserved")), settle },
      recovered,
    );
    await reconciler.reconcileInterrupted();
    expect(settle).toHaveBeenCalledWith({
      runId: sharedRequest.runId,
      actualUnits: sharedUnits,
      payerSid: sharedRequest.payerSid,
    });
    expect(recovered.pending()).toEqual([]);
  });

  it("skips reconciliation for a reservation settled before the crash", async () => {
    const home = sharedHome();
    const journal = new SharedTurnQuotaJournal(home);
    journal.track({
      runId: sharedRequest.runId,
      payerSid: sharedRequest.payerSid,
      modelId: "gpt-5",
      estimatedUnits: sharedUnits,
    });
    const settle = vi.fn();
    const runner = new QuotaSharedTurnRunner(
      { executeSharedTurn: vi.fn(), cancelSharedTurn: vi.fn() },
      { reserve: vi.fn().mockResolvedValue(reservation("settled")), settle },
      journal,
    );

    await runner.reconcileInterrupted();
    expect(settle).not.toHaveBeenCalled();
    expect(journal.pending()).toEqual([]);
  });

  it("delegates cancellation to the inner runner", async () => {
    const cancelSharedTurn = vi.fn().mockResolvedValue(undefined);
    const runner = new QuotaSharedTurnRunner(
      { executeSharedTurn: vi.fn(), cancelSharedTurn },
      { reserve: vi.fn(), settle: vi.fn() },
      new SharedTurnQuotaJournal(sharedHome()),
    );
    await runner.cancelSharedTurn(sharedRequest.runId);
    expect(cancelSharedTurn).toHaveBeenCalledWith(sharedRequest.runId);
  });
});

describe("fail-closed runners without platform quota", () => {
  it("refuses to start automation runs and still delegates cancellation", async () => {
    const execute = vi.fn();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const runner = new FailClosedAutomationRunner({ execute, cancel });
    await expect(runner.execute(request)).rejects.toThrow(
      "platform_quota_unconfigured",
    );
    expect(execute).not.toHaveBeenCalled();
    await expect(runner.reconcileInterrupted(request)).resolves.toBeUndefined();
    await runner.cancel(request.automationRunId);
    expect(cancel).toHaveBeenCalledWith(request.automationRunId);
  });

  it("refuses to start team tasks", async () => {
    const executeTeamTask = vi.fn();
    const runner = new FailClosedTeamRunner({ executeTeamTask });
    const teamRequest: TeamExecution = {
      taskId: "task-1",
      teamId: "team-1",
      memberId: "member-1",
      sessionId: "session-1",
      name: "Launch · Reviewer",
      engine: "codex",
      presetId: "preset-1",
      workspaceId: "workspace-default",
      input: "Review launch",
    };
    await expect(runner.executeTeamTask(teamRequest)).rejects.toThrow(
      "platform_quota_unconfigured",
    );
    expect(executeTeamTask).not.toHaveBeenCalled();
    await expect(
      runner.reconcileInterruptedTeamTask(teamRequest),
    ).resolves.toBeUndefined();
  });

  it("refuses to start shared turns", async () => {
    const executeSharedTurn = vi.fn();
    const runner = new FailClosedSharedTurnRunner({
      executeSharedTurn,
      cancelSharedTurn: vi.fn().mockResolvedValue(undefined),
    });
    await expect(
      runner.executeSharedTurn({
        runId: "run-shared-1",
        conversationId: "conversation-1",
        projectId: "project-1",
        engine: "codex",
        modelId: "gpt-5",
        thinkingEffort: "medium",
        context: "Shared context",
        recoveryContext: "Full shared context",
        workspacePath: "/tmp/shared-project",
        payerSid: "S-1-5-21-2000",
      }),
    ).rejects.toThrow("platform_quota_unconfigured");
    expect(executeSharedTurn).not.toHaveBeenCalled();
  });
});
