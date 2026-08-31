import { describe, expect, it, vi } from "vitest";
import type { AutomationExecution } from "./automation-store.js";
import {
  QuotaAutomationRunner,
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
});
