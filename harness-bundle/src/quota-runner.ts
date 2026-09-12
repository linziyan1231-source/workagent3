import { executionBillingModel } from "./execution-configuration.js";
import type { PersonalQuotaSettlements } from "./quota-settlement.js";
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
import type {
  AutomationQuotaPort,
  SharedTurnQuotaPort,
} from "./quota-client.js";
import type { SharedTurnRunnerPort } from "./shared-turn-api.js";
import type { TeamExecution, TeamRunnerPort } from "./team-store.js";

export interface AutomationPresetResolverPort {
  resolve(id: string): {
    resolvedSnapshot: { modelId?: string | null };
  };
}

// Until every Engine emits normalized token telemetry, successful runs settle
// the conservative reservation. Failed runs release it with zero usage.
export const estimatedAutomationUnits = (input: string): number =>
  Math.max(1, Math.ceil(Buffer.byteLength(input, "utf8") / 4) + 1024);

const reservationWasRejected = (error: unknown): boolean =>
  error instanceof Error &&
  ["quota_exceeded", "model_not_authorized"].includes(error.message);

export class QuotaAutomationRunner implements AutomationRunnerPort {
  readonly #active = new Map<
    string,
    { cancelled: boolean; started: boolean }
  >();
  constructor(
    readonly inner: AutomationRunnerPort,
    readonly presets: AutomationPresetResolverPort,
    readonly quota: AutomationQuotaPort,
    readonly settlements?: PersonalQuotaSettlements,
  ) {}

  async execute(request: AutomationExecution) {
    const preset = this.presets.resolve(request.definition.presetId);
    const modelId = executionBillingModel(
      request.definition.engine,
      preset.resolvedSnapshot.modelId,
    );
    const units = estimatedAutomationUnits(request.definition.input);
    const state = { cancelled: false, started: false };
    this.#active.set(request.automationRunId, state);
    try {
      try {
        await this.quota.reserve({
          runId: request.automationRunId,
          engine: request.definition.engine,
          modelId,
          estimatedUnits: units,
        });
      } catch (error) {
        if (state.cancelled && reservationWasRejected(error))
          this.settlements?.discard(request.automationRunId);
        throw error;
      }
      let result: Awaited<ReturnType<AutomationRunnerPort["execute"]>>;
      try {
        if (state.cancelled) throw new Error("automation_cancelled");
        state.started = true;
        result = await this.inner.execute(request);
      } catch (error) {
        try {
          await this.#settle(request.automationRunId, 0);
        } catch (settlementError) {
          throw new AggregateError(
            [error, settlementError],
            "automation_failed_and_quota_settlement_failed",
          );
        }
        throw error;
      }
      // A failed settlement is not an engine failure. The durable journal
      // retries this exact completed amount rather than sending a second zero.
      await this.#settle(request.automationRunId, units);
      return result;
    } finally {
      this.#active.delete(request.automationRunId);
    }
  }

  #settle(runId: string, actualUnits: number): Promise<void> {
    return (
      this.settlements?.settle(runId, actualUnits) ??
      this.quota.settle({ runId, actualUnits })
    );
  }

  async reconcileInterrupted(request: AutomationExecution): Promise<void> {
    const recorded = this.settlements?.get(request.automationRunId);
    if (recorded !== undefined) {
      await this.#settle(request.automationRunId, recorded);
      return;
    }
    const preset = this.presets.resolve(request.definition.presetId);
    const modelId = executionBillingModel(
      request.definition.engine,
      preset.resolvedSnapshot.modelId,
    );
    const units = estimatedAutomationUnits(request.definition.input);
    const reservation = await this.quota.reserve({
      runId: request.automationRunId,
      engine: request.definition.engine,
      modelId,
      estimatedUnits: units,
    });
    if (reservation.status === "settled") return;
    await this.#settle(request.automationRunId, units);
  }

  cancel(automationRunId: string): Promise<void> {
    const active = this.#active.get(automationRunId);
    if (active) {
      active.cancelled = true;
      if (!active.started) this.settlements?.track(automationRunId, 0);
    }
    return this.inner.cancel?.(automationRunId) ?? Promise.resolve();
  }
}

export class QuotaTeamRunner implements TeamRunnerPort {
  readonly #active = new Map<
    string,
    { cancelled: boolean; started: boolean }
  >();
  constructor(
    readonly inner: TeamRunnerPort,
    readonly presets: AutomationPresetResolverPort,
    readonly quota: AutomationQuotaPort,
    readonly settlements?: PersonalQuotaSettlements,
  ) {}

  async executeTeamTask(request: TeamExecution) {
    const preset = this.presets.resolve(request.presetId);
    const modelId = executionBillingModel(
      request.engine,
      preset.resolvedSnapshot.modelId,
    );
    const units = estimatedAutomationUnits(request.input);
    const state = { cancelled: false, started: false };
    this.#active.set(request.taskId, state);
    try {
      try {
        await this.quota.reserve({
          runId: request.taskId,
          engine: request.engine,
          modelId,
          estimatedUnits: units,
        });
      } catch (error) {
        if (state.cancelled && reservationWasRejected(error))
          this.settlements?.discard(request.taskId);
        throw error;
      }
      let result: Awaited<ReturnType<TeamRunnerPort["executeTeamTask"]>>;
      try {
        if (state.cancelled) throw new Error("team_task_cancelled");
        state.started = true;
        result = await this.inner.executeTeamTask(request);
      } catch (error) {
        try {
          await this.#settle(request.taskId, 0);
        } catch (settlementError) {
          throw new AggregateError(
            [error, settlementError],
            "team_task_failed_and_quota_settlement_failed",
          );
        }
        throw error;
      }
      await this.#settle(request.taskId, units);
      return result;
    } finally {
      this.#active.delete(request.taskId);
    }
  }

  #settle(runId: string, actualUnits: number): Promise<void> {
    return (
      this.settlements?.settle(runId, actualUnits) ??
      this.quota.settle({ runId, actualUnits })
    );
  }

  async reconcileInterruptedTeamTask(request: TeamExecution): Promise<void> {
    const recorded = this.settlements?.get(request.taskId);
    if (recorded !== undefined) {
      await this.#settle(request.taskId, recorded);
      return;
    }
    const preset = this.presets.resolve(request.presetId);
    const modelId = executionBillingModel(
      request.engine,
      preset.resolvedSnapshot.modelId,
    );
    const units = estimatedAutomationUnits(request.input);
    const reservation = await this.quota.reserve({
      runId: request.taskId,
      engine: request.engine,
      modelId,
      estimatedUnits: units,
    });
    if (reservation.status === "settled") return;
    await this.#settle(request.taskId, units);
  }

  cancelTeamTask(taskId: string): Promise<void> {
    const active = this.#active.get(taskId);
    if (active) {
      active.cancelled = true;
      if (!active.started) this.settlements?.track(taskId, 0);
    }
    return this.inner.cancelTeamTask?.(taskId) ?? Promise.resolve();
  }
}

export type SharedTurnQuotaEntry = {
  actualUnits?: number;
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
  readonly #active = new Set<string>();
  readonly #cancelled = new Set<string>();
  #reconciling: Promise<void> | undefined;
  constructor(
    readonly inner: SharedTurnRunnerPort,
    readonly quota: SharedTurnQuotaPort,
    readonly journal: SharedTurnQuotaJournal,
  ) {}

  async executeSharedTurn(
    request: SharedTurnRuntimeRequest,
  ): Promise<SharedTurnResult> {
    if (this.#active.has(request.runId))
      throw new Error("shared_turn_already_running");
    this.#active.add(request.runId);
    const entry: SharedTurnQuotaEntry = this.journal
      .pending()
      .find((pending) => pending.runId === request.runId) ?? {
      runId: request.runId,
      payerSid: request.payerSid,
      modelId: request.quotaModelId ?? request.modelId,
      estimatedUnits: estimatedAutomationUnits(request.context),
    };
    try {
      // Persist before the claim: a lost claim response must be recoverable.
      this.journal.track(entry);
      const reservation = await this.quota.reserve({
        runId: entry.runId,
        engine: request.engine,
        modelId: entry.modelId,
        estimatedUnits: entry.estimatedUnits,
        payerSid: entry.payerSid,
      });
      if (reservation.status === "settled") {
        this.journal.release(entry.runId);
        throw new Error("shared_turn_already_settled");
      }
      if (reservation.alreadyAccepted)
        throw new Error("shared_turn_already_accepted");
      let result: SharedTurnResult;
      try {
        if (this.#cancelled.has(request.runId))
          throw new Error("shared_turn_cancelled");
        result = await this.inner.executeSharedTurn(request);
      } catch (error) {
        entry.actualUnits = 0;
        this.journal.track(entry);
        try {
          await this.#settle(entry);
        } catch (settlementError) {
          throw new AggregateError(
            [error, settlementError],
            "shared_turn_failed_and_quota_settlement_failed",
          );
        }
        throw error;
      }
      entry.actualUnits = entry.estimatedUnits;
      this.journal.track(entry);
      // A successful execution followed by a settlement transport failure must
      // retain its successful amount, never fall into a zero-usage catch path.
      await this.#settle(entry);
      return result;
    } finally {
      this.#active.delete(request.runId);
      this.#cancelled.delete(request.runId);
    }
  }

  async #settle(entry: SharedTurnQuotaEntry): Promise<void> {
    await this.quota.settle({
      runId: entry.runId,
      actualUnits: entry.actualUnits ?? entry.estimatedUnits,
      payerSid: entry.payerSid,
    });
    this.journal.release(entry.runId);
  }

  reconcileInterrupted(): Promise<void> {
    if (this.#reconciling) return this.#reconciling;
    this.#reconciling = this.#reconcile().finally(() => {
      this.#reconciling = undefined;
    });
    return this.#reconciling;
  }

  async #reconcile(): Promise<void> {
    const failures: unknown[] = [];
    for (const entry of this.journal.pending()) {
      if (this.#active.has(entry.runId)) continue;
      try {
        // Lookup only: recovery cannot manufacture a missing shared admission,
        // and revoking a model cannot prevent accounting for an existing run.
        const reservation = await this.quota.lookup(entry.runId);
        if (this.#active.has(entry.runId)) continue;
        if (reservation.status === "settled") {
          this.journal.release(entry.runId);
          continue;
        }
        if (reservation.accepted === false) continue;
        await this.#settle(entry);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "quota_reservation_not_found"
        ) {
          // May be legacy authorization awaiting Portal reconciliation. Keep
          // the journal; never infer another employee's billing permission.
          continue;
        }
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "shared_quota_recovery_pending");
  }

  startRecovery(): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        await this.reconcileInterrupted();
      } catch {
        /* persisted entries retry below */
      }
      if (!stopped) {
        timer = setTimeout(() => {
          void run();
        }, 5000);
        timer.unref?.();
      }
    };
    void run();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  cancelSharedTurn(runId: string): Promise<void> {
    if (this.#active.has(runId)) this.#cancelled.add(runId);
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
