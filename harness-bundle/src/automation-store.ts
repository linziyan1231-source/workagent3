import { waitForShutdown } from "./shutdown.js";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Cron } from "croner";
import {
  SessionBusyError,
  type ExecutionAdmission,
} from "./execution-admission.js";
import {
  automationDocumentSchema,
  automationDefinitionSchema,
  automationMutationSchema,
  automationRunSchema,
  automationScheduleSchema,
  type AutomationDefinition,
  type AutomationMutation,
  type AutomationRun,
  type AutomationSchedule,
} from "@workagent/contracts";

import {
  PlatformNotificationClient,
  type TerminalNotificationPort,
} from "./notification-client.js";

type Clock = { now(): Date };

const defaultClock: Clock = { now: () => new Date() };

const validateMessageNotification = (
  definition: Pick<
    AutomationDefinition,
    "messageNotificationEnabled" | "messageNotificationTargetId"
  >,
) => {
  if (
    definition.messageNotificationEnabled &&
    !definition.messageNotificationTargetId
  )
    throw new Error("automation_notification_target_required");
};

const weekday = new Map([
  ["Sun", 0],
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6],
]);

const timezoneParts = (date: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return {
    day: weekday.get(value("weekday") ?? ""),
    hour: Number(value("hour")),
    minute: Number(value("minute")),
  };
};

export const nextScheduleTime = (
  schedule: AutomationSchedule,
  after: Date,
): Date => {
  const parsed = automationScheduleSchema.parse(schedule);
  if (parsed.kind === "once") {
    const at = new Date(parsed.at);
    if (at <= after) throw new Error("automation_once_time_in_past");
    return at;
  }
  if (parsed.kind === "interval")
    return new Date(after.getTime() + parsed.everyMinutes * 60_000);

  if (parsed.kind === "cron") {
    if (!parsed.expression.trim())
      throw new Error("automation_schedule_manual_only");
    const next = new Cron(parsed.expression, {
      paused: true,
      timezone: parsed.timezone,
    }).nextRun(after);
    if (next === null) throw new Error("automation_schedule_has_no_next_run");
    return next;
  }

  new Intl.DateTimeFormat("en-US", { timeZone: parsed.timezone }).format(after);
  const candidate = new Date(
    after.getTime() - (after.getTime() % 60_000) + 60_000,
  );
  for (let offset = 0; offset <= 8 * 24 * 60; offset += 1) {
    const value = new Date(candidate.getTime() + offset * 60_000);
    const local = timezoneParts(value, parsed.timezone);
    if (
      local.day !== undefined &&
      parsed.daysOfWeek.includes(local.day) &&
      local.hour === parsed.hour &&
      local.minute === parsed.minute
    )
      return value;
  }
  throw new Error("automation_schedule_has_no_next_run");
};

export class AutomationStore {
  readonly #path: string;
  readonly #clock: Clock;
  readonly #definitions = new Map<string, AutomationDefinition>();
  readonly #runs = new Map<string, AutomationRun>();
  readonly #quotaReconciledRunIds = new Set<string>();
  readonly #operations = new Map<
    string,
    { id: string; input: string; result: unknown }
  >();
  #batch = false;

  constructor(dshHome: string, clock: Clock = defaultClock) {
    this.#path = join(dshHome, "workagent", "automations.json");
    this.#clock = clock;
    if (existsSync(this.#path)) {
      const document = automationDocumentSchema.parse(
        JSON.parse(readFileSync(this.#path, "utf8")),
      );
      for (const definition of document.definitions)
        this.#definitions.set(definition.id, definition);
      for (const operation of document.operations)
        this.#operations.set(operation.id, operation);
      let recovered = false;
      for (const value of document.runs) {
        const run =
          value.status === "running"
            ? {
                ...value,
                status: "failed" as const,
                error: "runtime_restarted",
                finishedAt: this.#clock.now().toISOString(),
              }
            : value;
        if (run !== value) recovered = true;
        this.#runs.set(run.id, run);
      }
      for (const id of document.quotaReconciledRunIds)
        this.#quotaReconciledRunIds.add(id);
      if (recovered) this.#save();
    }
  }

  list(): AutomationDefinition[] {
    return [...this.#definitions.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  get(id: string): AutomationDefinition | undefined {
    return this.#definitions.get(id);
  }

  create(input: AutomationMutation): AutomationDefinition {
    const mutation = automationMutationSchema.parse(input);
    const now = this.#clock.now();
    const definition = automationDefinitionSchema.parse({
      ...mutation,
      id: `automation-${randomUUID()}`,
      version: 1,
      nextRunAt: mutation.enabled
        ? nextScheduleTime(mutation.schedule, now).toISOString()
        : null,
      lastRunAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    validateMessageNotification(definition);
    this.#definitions.set(definition.id, definition);
    this.#save();
    return definition;
  }

  update(
    id: string,
    expectedVersion: number,
    input: Partial<AutomationMutation>,
  ): AutomationDefinition {
    const current = this.#required(id);
    if (current.version !== expectedVersion)
      throw new Error("automation_version_conflict");
    const parsed = automationMutationSchema.partial().parse(input);
    const mutation = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => Object.hasOwn(input, key)),
    ) as Partial<AutomationMutation>;
    const now = this.#clock.now();
    const enabled = mutation.enabled ?? current.enabled;
    const schedule = mutation.schedule ?? current.schedule;
    const nextRunAt = !enabled
      ? null
      : !current.enabled || mutation.schedule !== undefined
        ? nextScheduleTime(schedule, now).toISOString()
        : current.nextRunAt;
    const next = automationDefinitionSchema.parse({
      ...current,
      ...mutation,
      enabled,
      schedule,
      version: current.version + 1,
      nextRunAt,
      updatedAt: now.toISOString(),
    });
    validateMessageNotification(next);
    this.#definitions.set(id, next);
    if (mutation.enabled === false) {
      for (const run of this.#runs.values()) {
        if (
          run.automationId === id &&
          (run.status === "waiting" || run.status === "pending") &&
          run.trigger === "scheduled"
        )
          this.#runs.set(run.id, {
            ...run,
            status: "cancelled",
            finishedAt: now.toISOString(),
          });
      }
    }
    this.#save();
    return next;
  }

  delete(id: string): void {
    this.#required(id);
    if (
      [...this.#runs.values()].some(
        (run) =>
          run.automationId === id &&
          ["pending", "waiting", "running"].includes(run.status),
      )
    )
      throw new Error("automation_has_active_run");
    this.#definitions.delete(id);
    for (const [runId, run] of this.#runs)
      if (run.automationId === id) this.#runs.delete(runId);
    this.#save();
  }

  history(automationId: string): AutomationRun[] {
    this.#required(automationId);
    return [...this.#runs.values()]
      .filter((run) => run.automationId === automationId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getRun(runId: string): AutomationRun | undefined {
    return this.#runs.get(runId);
  }

  runNow(automationId: string): AutomationRun {
    const definition = this.#required(automationId);
    const now = this.#clock.now().toISOString();
    const run = automationRunSchema.parse({
      id: `automation-run-${randomUUID()}`,
      automationId,
      definitionSnapshot: definition,
      trigger: "manual",
      scheduledFor: now,
      status: "pending",
      attempt: 0,
      sessionId: null,
      result: null,
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    });
    this.#runs.set(run.id, run);
    this.#save();
    return run;
  }

  claimRunnable(): AutomationRun[] {
    const now = this.#clock.now();
    let changed = false;
    for (const definition of this.#definitions.values()) {
      if (
        !definition.enabled ||
        definition.nextRunAt === null ||
        new Date(definition.nextRunAt) > now
      )
        continue;
      const scheduledFor = definition.nextRunAt;
      const id = `automation-run-${definition.id}-${new Date(scheduledFor).getTime()}`;
      if (!this.#runs.has(id)) {
        this.#runs.set(
          id,
          automationRunSchema.parse({
            id,
            automationId: definition.id,
            definitionSnapshot: definition,
            trigger: "scheduled",
            scheduledFor,
            status: "pending",
            attempt: 0,
            sessionId: null,
            result: null,
            error: null,
            createdAt: now.toISOString(),
            startedAt: null,
            finishedAt: null,
          }),
        );
        changed = true;
      }
      this.#definitions.set(definition.id, {
        ...definition,
        version: definition.version + 1,
        lastRunAt: scheduledFor,
        enabled:
          definition.schedule.kind === "once" ? false : definition.enabled,
        nextRunAt:
          definition.schedule.kind === "once"
            ? null
            : nextScheduleTime(definition.schedule, now).toISOString(),
        updatedAt: now.toISOString(),
      });
      changed = true;
    }
    if (changed) this.#save();
    return [...this.#runs.values()]
      .filter(
        (run) =>
          run.status === "pending" ||
          (run.status === "waiting" &&
            run.notBefore !== null &&
            new Date(run.notBefore) <= now),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  begin(runId: string): AutomationRun {
    const run = this.#requiredRun(runId);
    if (run.status !== "pending" && run.status !== "waiting")
      throw new Error("automation_run_not_pending");
    const next = automationRunSchema.parse({
      ...run,
      status: "running",
      attempt: run.attempt + 1,
      startedAt: this.#clock.now().toISOString(),
      error: null,
      notBefore: null,
    });
    this.#runs.set(runId, next);
    this.#save();
    return next;
  }

  bindSession(runId: string, sessionId: string): void {
    const run = this.#requiredRun(runId);
    if (run.status !== "running") return;
    this.#runs.set(runId, automationRunSchema.parse({ ...run, sessionId }));
    this.#save();
  }

  submitted(runId: string, turnId: string): void {
    const run = this.#requiredRun(runId);
    if (run.status !== "running") return;
    this.#runs.set(runId, {
      ...run,
      turnId,
      submittedAt: this.#clock.now().toISOString(),
    });
    this.#save();
  }

  deferBusy(runId: string): AutomationRun {
    const run = this.#requiredRun(runId);
    if (run.status === "cancelled") return run;
    if (run.status !== "running" || run.submittedAt)
      throw new Error("automation_run_not_retryable");
    const exhausted = run.busyRetryCount >= 3;
    const next: AutomationRun = {
      ...run,
      status: exhausted ? "skipped_busy" : "waiting",
      attempt: Math.max(0, run.attempt - 1),
      busyRetryCount: run.busyRetryCount + (exhausted ? 0 : 1),
      notBefore: exhausted
        ? null
        : new Date(this.#clock.now().getTime() + 30_000).toISOString(),
      lastWaitReason: "session_busy",
      error: exhausted ? "automation_session_busy_after_retries" : null,
      startedAt: null,
      finishedAt: exhausted ? this.#clock.now().toISOString() : null,
    };
    this.#runs.set(runId, next);
    this.#save();
    return next;
  }

  nextWakeAt(): string | null {
    return (
      [
        ...this.list().flatMap((definition) =>
          definition.enabled && definition.nextRunAt
            ? [definition.nextRunAt]
            : [],
        ),
        ...[...this.#runs.values()].flatMap((run) =>
          run.status === "waiting" && run.notBefore ? [run.notBefore] : [],
        ),
      ].sort()[0] ?? null
    );
  }

  interruptedExecutions(): AutomationExecution[] {
    return [...this.#runs.values()]
      .filter(
        (run) =>
          run.status === "failed" &&
          run.error === "runtime_restarted" &&
          !this.#quotaReconciledRunIds.has(run.id),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((run) => ({
        automationRunId: run.id,
        definition: run.definitionSnapshot,
      }));
  }

  acknowledgeInterruptedExecution(runId: string): void {
    const run = this.#requiredRun(runId);
    if (run.status !== "failed" || run.error !== "runtime_restarted")
      throw new Error("automation_run_not_interrupted");
    this.#quotaReconciledRunIds.add(runId);
    this.#save();
  }

  finish(
    runId: string,
    outcome:
      | {
          status: "succeeded";
          sessionId: string;
          result?: string;
          skillSuggestionPath?: string;
        }
      | { status: "failed"; error: string; sessionId?: string },
  ): AutomationRun {
    const run = this.#requiredRun(runId);
    if (run.status === "cancelled") return run;
    if (run.status !== "running") throw new Error("automation_run_not_running");
    const next = automationRunSchema.parse({
      ...run,
      status: outcome.status,
      sessionId: outcome.sessionId ?? run.sessionId,
      result: outcome.status === "succeeded" ? (outcome.result ?? null) : null,
      skillSuggestionPath:
        outcome.status === "succeeded"
          ? (outcome.skillSuggestionPath ?? null)
          : null,
      error: outcome.status === "failed" ? outcome.error : null,
      finishedAt: this.#clock.now().toISOString(),
    });
    this.#runs.set(runId, next);
    this.#save();
    return next;
  }

  cancel(automationId: string, runId: string): AutomationRun {
    const run = this.#requiredRun(runId);
    if (run.automationId !== automationId)
      throw new Error("automation_run_not_found");
    if (
      run.status !== "pending" &&
      run.status !== "waiting" &&
      run.status !== "running"
    )
      throw new Error("automation_run_not_cancellable");
    const next = automationRunSchema.parse({
      ...run,
      status: "cancelled",
      finishedAt: this.#clock.now().toISOString(),
    });
    this.#runs.set(runId, next);
    this.#save();
    return next;
  }

  operation<T>(id: string, input: unknown, perform: () => T): T {
    if (!/^[A-Za-z0-9_:@.-]{1,200}$/.test(id))
      throw new Error("invalid_operation_id");
    const encoded = JSON.stringify(input);
    const known = this.#operations.get(id);
    if (known) {
      if (known.input !== encoded) throw new Error("operation_id_conflict");
      return known.result as T;
    }
    const definitions = new Map(this.#definitions),
      runs = new Map(this.#runs);
    this.#batch = true;
    try {
      const result = perform();
      this.#operations.set(id, { id, input: encoded, result });
      this.#batch = false;
      this.#save();
      return result;
    } catch (error) {
      this.#definitions.clear();
      for (const [key, value] of definitions) this.#definitions.set(key, value);
      this.#runs.clear();
      for (const [key, value] of runs) this.#runs.set(key, value);
      this.#operations.delete(id);
      this.#batch = false;
      throw error;
    }
  }

  #required(id: string): AutomationDefinition {
    const value = this.#definitions.get(id);
    if (value === undefined) throw new Error("automation_not_found");
    return value;
  }

  #requiredRun(id: string): AutomationRun {
    const value = this.#runs.get(id);
    if (value === undefined) throw new Error("automation_run_not_found");
    return value;
  }

  #save(): void {
    if (this.#batch) return;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify(
        {
          version: 1,
          definitions: [...this.#definitions.values()],
          runs: [...this.#runs.values()],
          quotaReconciledRunIds: [...this.#quotaReconciledRunIds].sort(),
          operations: [...this.#operations.values()],
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporary, this.#path);
  }
}

export type AutomationExecution = {
  automationRunId: string;
  definition: AutomationDefinition;
  onSessionStarted?: (sessionId: string) => void;
  onSubmitted?: ((turnId: string) => void) | undefined;
  executionContext?: string | undefined;
};

export interface AutomationRunnerPort {
  admit?(request: AutomationExecution): ExecutionAdmission;
  billingModel?(
    request: AutomationExecution,
    recovery?: boolean,
  ): Promise<string>;
  execute(request: AutomationExecution): Promise<{
    sessionId: string;
    result?: string;
    skillSuggestionPath?: string;
  }>;
  cancel?(automationRunId: string): Promise<void>;
  reconcileInterrupted?(request: AutomationExecution): Promise<void>;
}

export class AutomationScheduler {
  #stopped = false;
  #stopping: Promise<void> | undefined;
  #work: Promise<void> = Promise.resolve();
  #activeRunId: string | undefined;
  #notifications = new Set<Promise<unknown>>();
  #ticking = false;
  #recovered = false;
  #recovering: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly store: AutomationStore,
    readonly runner: AutomationRunnerPort,
    readonly notifier:
      | TerminalNotificationPort
      | undefined = PlatformNotificationClient.fromEnvironment(),
  ) {}

  start(intervalMs = 30_000): void {
    if (this.#stopped || this.#timer !== undefined) return;
    void this.tick().catch(() => undefined);
    this.#timer = setInterval(
      () => void this.tick().catch(() => undefined),
      intervalMs,
    );
    this.#timer.unref();
  }

  stop(timeoutMs = 5_000): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    const activeRunId = this.#activeRunId;
    const cancel =
      activeRunId === undefined
        ? Promise.resolve()
        : Promise.resolve().then(() => this.runner.cancel?.(activeRunId));
    const drain = Promise.allSettled([cancel, this.#work]).then(() =>
      Promise.allSettled([...this.#notifications]),
    );
    this.#stopping = waitForShutdown(drain, timeoutMs);
    return this.#stopping;
  }

  async cancel(automationId: string, runId: string): Promise<AutomationRun> {
    const run = this.store.cancel(automationId, runId);
    await this.runner.cancel?.(runId);
    return run;
  }

  tick(): Promise<void> {
    if (this.#stopped || this.#ticking) return Promise.resolve();
    this.#ticking = true;
    this.#work = this.#run().finally(() => {
      this.#ticking = false;
    });
    return this.#work;
  }

  async #run(): Promise<void> {
    await this.#recoverInterruptedRuns();
    if (this.#stopped) return;
    try {
      for (const pending of this.store.claimRunnable()) {
        if (this.#stopped) break;
        // Isolate each run: a failing begin/execute/finish must not abort the
        // loop and starve the remaining pending runs of this tick.
        try {
          let run: AutomationRun;
          try {
            run = this.store.begin(pending.id);
          } catch {
            continue;
          }
          this.#activeRunId = run.id;
          try {
            const result = await this.runner.execute({
              automationRunId: run.id,
              definition: run.definitionSnapshot,
              onSessionStarted: (sessionId) =>
                this.store.bindSession(run.id, sessionId),
              onSubmitted: (turnId) => this.store.submitted(run.id, turnId),
            });
            this.#notifyTerminal(
              this.store.finish(run.id, { status: "succeeded", ...result }),
            );
          } catch (error) {
            if (error instanceof SessionBusyError) {
              this.#notifyTerminal(this.store.deferBusy(run.id));
              continue;
            }
            this.#notifyTerminal(
              this.store.finish(run.id, {
                status: "failed",
                error:
                  error instanceof Error ? error.message : "automation_failed",
              }),
            );
          }
        } catch {
          // The run is no longer finishable (e.g. completed elsewhere); skip
          // it and keep scheduling the rest.
        }
      }
    } finally {
      this.#activeRunId = undefined;
    }
  }

  // Delivers the terminal-state notification through the platform
  // Notifications module. Publish failures must never break the run, so the
  // promise is fire-and-forget.
  #notifyTerminal(run: AutomationRun): void {
    if (this.notifier === undefined) return;
    // A cancel can race execute; finish() then returns the cancelled run.
    if (
      run.status !== "succeeded" &&
      run.status !== "failed" &&
      run.status !== "skipped_busy"
    )
      return;
    const policy = run.definitionSnapshot.notificationPolicy;
    if (
      policy === "none" ||
      (policy === "on_failure" && run.status === "succeeded")
    )
      return;
    const name = run.definitionSnapshot.name;
    const notification = this.notifier
      .publish({
        kind: "automation",
        title:
          run.status !== "succeeded"
            ? "Automation failed"
            : "Automation completed",
        message:
          run.status !== "succeeded"
            ? `Automation "${name}" failed: ${run.error ?? "unknown error"}`
            : `Automation "${name}" finished successfully.`,
        deepLink: `/scheduled/${run.automationId}`,
      })
      .catch(() => undefined);
    this.#notifications.add(notification);
    void notification.finally(() => this.#notifications.delete(notification));
  }

  async #recoverInterruptedRuns(): Promise<void> {
    if (this.#recovered) return;
    if (this.#recovering === undefined) {
      this.#recovering = (async () => {
        for (const request of this.store.interruptedExecutions()) {
          if (this.#stopped) return;
          if (this.runner.reconcileInterrupted !== undefined)
            await this.runner.reconcileInterrupted(request);
          this.store.acknowledgeInterruptedExecution(request.automationRunId);
        }
        this.#recovered = true;
      })().finally(() => {
        this.#recovering = undefined;
      });
    }
    await this.#recovering;
  }
}
