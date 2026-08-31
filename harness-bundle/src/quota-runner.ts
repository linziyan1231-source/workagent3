import type {
  AutomationExecution,
  AutomationRunnerPort,
} from "./automation-store.js";
import type { AutomationQuotaPort } from "./quota-client.js";
import type { TeamExecution, TeamRunnerPort } from "./team-store.js";

export interface AutomationPresetResolverPort {
  resolve(id: string): {
    resolvedSnapshot: { modelId?: string | null };
  };
}

const defaultModel = {
  harness: "harness-default",
  codex: "codex-native",
  kimi: "kimi-native",
} as const;

// Until every Engine emits normalized token telemetry, successful runs settle
// the conservative reservation. Failed runs release it with zero usage.
export const estimatedAutomationUnits = (input: string): number =>
  Math.max(1, Math.ceil(Buffer.byteLength(input, "utf8") / 4) + 1024);

export class QuotaAutomationRunner implements AutomationRunnerPort {
  constructor(
    readonly inner: AutomationRunnerPort,
    readonly presets: AutomationPresetResolverPort,
    readonly quota: AutomationQuotaPort,
  ) {}

  async execute(request: AutomationExecution) {
    const preset = this.presets.resolve(request.definition.presetId);
    const modelId =
      preset.resolvedSnapshot.modelId ??
      defaultModel[request.definition.engine];
    const units = estimatedAutomationUnits(request.definition.input);
    await this.quota.reserve({
      runId: request.automationRunId,
      modelId,
      estimatedUnits: units,
    });
    try {
      const result = await this.inner.execute(request);
      await this.quota.settle({
        runId: request.automationRunId,
        actualUnits: units,
      });
      return result;
    } catch (error) {
      try {
        await this.quota.settle({
          runId: request.automationRunId,
          actualUnits: 0,
        });
      } catch (settlementError) {
        throw new AggregateError(
          [error, settlementError],
          "automation_failed_and_quota_settlement_failed",
        );
      }
      throw error;
    }
  }

  async reconcileInterrupted(request: AutomationExecution): Promise<void> {
    const preset = this.presets.resolve(request.definition.presetId);
    const modelId =
      preset.resolvedSnapshot.modelId ??
      defaultModel[request.definition.engine];
    const units = estimatedAutomationUnits(request.definition.input);
    const reservation = await this.quota.reserve({
      runId: request.automationRunId,
      modelId,
      estimatedUnits: units,
    });
    if (reservation.status === "settled") return;
    await this.quota.settle({
      runId: request.automationRunId,
      actualUnits: units,
    });
  }

  cancel(automationRunId: string): Promise<void> {
    return this.inner.cancel?.(automationRunId) ?? Promise.resolve();
  }
}

export class QuotaTeamRunner implements TeamRunnerPort {
  constructor(
    readonly inner: TeamRunnerPort,
    readonly presets: AutomationPresetResolverPort,
    readonly quota: AutomationQuotaPort,
  ) {}

  async executeTeamTask(request: TeamExecution) {
    const preset = this.presets.resolve(request.presetId);
    const modelId =
      preset.resolvedSnapshot.modelId ?? defaultModel[request.engine];
    const units = estimatedAutomationUnits(request.input);
    await this.quota.reserve({
      runId: request.taskId,
      modelId,
      estimatedUnits: units,
    });
    try {
      const result = await this.inner.executeTeamTask(request);
      await this.quota.settle({ runId: request.taskId, actualUnits: units });
      return result;
    } catch (error) {
      try {
        await this.quota.settle({ runId: request.taskId, actualUnits: 0 });
      } catch (settlementError) {
        throw new AggregateError(
          [error, settlementError],
          "team_task_failed_and_quota_settlement_failed",
        );
      }
      throw error;
    }
  }

  async reconcileInterruptedTeamTask(request: TeamExecution): Promise<void> {
    const preset = this.presets.resolve(request.presetId);
    const modelId =
      preset.resolvedSnapshot.modelId ?? defaultModel[request.engine];
    const units = estimatedAutomationUnits(request.input);
    const reservation = await this.quota.reserve({
      runId: request.taskId,
      modelId,
      estimatedUnits: units,
    });
    if (reservation.status === "settled") return;
    await this.quota.settle({ runId: request.taskId, actualUnits: units });
  }

  cancelTeamTask(taskId: string): Promise<void> {
    return this.inner.cancelTeamTask?.(taskId) ?? Promise.resolve();
  }
}
