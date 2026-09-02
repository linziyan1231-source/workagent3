import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  SharedTurnRuntimeRequest,
  SharedTurnResult,
} from "@workagent/contracts";
import type {
  AutomationExecution,
  AutomationRunnerPort,
} from "./automation-store.js";
import type { AutomationQuotaPort } from "./quota-client.js";
import type { SharedTurnRunnerPort } from "./shared-turn-api.js";
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

export type SharedTurnQuotaEntry = {
  runId: string;
  payerSid: string;
  modelId: string;
  estimatedUnits: number;
};

// SharedTurnQuotaJournal remembers reservations between Reserve and Settle so
// a runtime process killed in between reconciles them at startup, the same
// role the automation/team stores play for their interrupted executions.
export class SharedTurnQuotaJournal {
  readonly #path: string;
  readonly #entries = new Map<string, SharedTurnQuotaEntry>();

  constructor(dshHome: string) {
    this.#path = join(dshHome, "workagent", "shared-turn-quota.json");
    if (existsSync(this.#path)) {
      const document = JSON.parse(readFileSync(this.#path, "utf8")) as {
        entries?: SharedTurnQuotaEntry[];
      };
      for (const entry of document.entries ?? [])
        this.#entries.set(entry.runId, entry);
    }
  }

  pending(): SharedTurnQuotaEntry[] {
    return [...this.#entries.values()];
  }

  track(entry: SharedTurnQuotaEntry): void {
    this.#entries.set(entry.runId, entry);
    this.#save();
  }

  release(runId: string): void {
    if (this.#entries.delete(runId)) this.#save();
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, entries: [...this.#entries.values()] }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporary, this.#path);
  }
}

// QuotaSharedTurnRunner bills a shared AI run to the frozen payer (the member
// who mentioned the assistant), not to the runtime owner. The Portal reserved
// at admission, so reserve here is an idempotent pass-through that anchors
// the journaled reservation for kill-between-Reserve-and-Settle reconcile.
export class QuotaSharedTurnRunner implements SharedTurnRunnerPort {
  constructor(
    readonly inner: SharedTurnRunnerPort,
    readonly quota: AutomationQuotaPort,
    readonly journal: SharedTurnQuotaJournal,
  ) {}

  async executeSharedTurn(
    request: SharedTurnRuntimeRequest,
  ): Promise<SharedTurnResult> {
    const entry: SharedTurnQuotaEntry = {
      runId: request.runId,
      payerSid: request.payerSid,
      modelId: request.modelId,
      estimatedUnits: estimatedAutomationUnits(request.context),
    };
    await this.quota.reserve({
      runId: entry.runId,
      modelId: entry.modelId,
      estimatedUnits: entry.estimatedUnits,
      payerSid: entry.payerSid,
    });
    this.journal.track(entry);
    try {
      const result = await this.inner.executeSharedTurn(request);
      await this.quota.settle({
        runId: entry.runId,
        actualUnits: entry.estimatedUnits,
        payerSid: entry.payerSid,
      });
      this.journal.release(entry.runId);
      return result;
    } catch (error) {
      try {
        await this.quota.settle({
          runId: entry.runId,
          actualUnits: 0,
          payerSid: entry.payerSid,
        });
        this.journal.release(entry.runId);
      } catch (settlementError) {
        throw new AggregateError(
          [error, settlementError],
          "shared_turn_failed_and_quota_settlement_failed",
        );
      }
      throw error;
    }
  }

  async reconcileInterrupted(): Promise<void> {
    for (const entry of this.journal.pending()) {
      const reservation = await this.quota.reserve({
        runId: entry.runId,
        modelId: entry.modelId,
        estimatedUnits: entry.estimatedUnits,
        payerSid: entry.payerSid,
      });
      if (reservation.status !== "settled")
        await this.quota.settle({
          runId: entry.runId,
          actualUnits: entry.estimatedUnits,
          payerSid: entry.payerSid,
        });
      this.journal.release(entry.runId);
    }
  }

  cancelSharedTurn(runId: string): Promise<void> {
    return this.inner.cancelSharedTurn(runId);
  }
}

// quotaUnconfiguredError rejects a run at the entry when the platform quota
// channel is not configured: without it no reservation is possible, so the
// run entry is fail-closed instead of running unbilled.
export const quotaUnconfiguredError = () =>
  new Error("platform_quota_unconfigured");

export class FailClosedAutomationRunner implements AutomationRunnerPort {
  constructor(readonly inner: AutomationRunnerPort) {}

  execute(_request: AutomationExecution): Promise<never> {
    return Promise.reject(quotaUnconfiguredError());
  }

  reconcileInterrupted(_request: AutomationExecution): Promise<void> {
    return Promise.resolve();
  }

  cancel(automationRunId: string): Promise<void> {
    return this.inner.cancel?.(automationRunId) ?? Promise.resolve();
  }
}

export class FailClosedTeamRunner implements TeamRunnerPort {
  constructor(readonly inner: TeamRunnerPort) {}

  executeTeamTask(_request: TeamExecution): Promise<never> {
    return Promise.reject(quotaUnconfiguredError());
  }

  reconcileInterruptedTeamTask(_request: TeamExecution): Promise<void> {
    return Promise.resolve();
  }

  cancelTeamTask(taskId: string): Promise<void> {
    return this.inner.cancelTeamTask?.(taskId) ?? Promise.resolve();
  }
}

export class FailClosedSharedTurnRunner implements SharedTurnRunnerPort {
  constructor(readonly inner: SharedTurnRunnerPort) {}

  executeSharedTurn(_request: SharedTurnRuntimeRequest): Promise<never> {
    return Promise.reject(quotaUnconfiguredError());
  }

  cancelSharedTurn(runId: string): Promise<void> {
    return this.inner.cancelSharedTurn(runId);
  }
}
