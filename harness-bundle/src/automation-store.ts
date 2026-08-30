import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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

type Clock = { now(): Date };

const defaultClock: Clock = { now: () => new Date() };

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
  if (parsed.kind === "interval")
    return new Date(after.getTime() + parsed.everyMinutes * 60_000);

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

  constructor(dshHome: string, clock: Clock = defaultClock) {
    this.#path = join(dshHome, "workagent", "automations.json");
    this.#clock = clock;
    if (existsSync(this.#path)) {
      const document = automationDocumentSchema.parse(
        JSON.parse(readFileSync(this.#path, "utf8")),
      );
      for (const definition of document.definitions)
        this.#definitions.set(definition.id, definition);
      let recovered = false;
      for (const value of document.runs) {
        const run =
          value.status === "running"
            ? {
                ...value,
                status: "pending" as const,
                startedAt: null,
                error: "runtime_restarted",
              }
            : value;
        if (run !== value) recovered = true;
        this.#runs.set(run.id, run);
      }
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
    const mutation = automationMutationSchema.partial().parse(input);
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
    this.#definitions.set(id, next);
    this.#save();
    return next;
  }

  delete(id: string): void {
    this.#required(id);
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

  runNow(automationId: string): AutomationRun {
    this.#required(automationId);
    const now = this.#clock.now().toISOString();
    const run = automationRunSchema.parse({
      id: `automation-run-${randomUUID()}`,
      automationId,
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
        nextRunAt: nextScheduleTime(definition.schedule, now).toISOString(),
        updatedAt: now.toISOString(),
      });
      changed = true;
    }
    if (changed) this.#save();
    return [...this.#runs.values()]
      .filter((run) => run.status === "pending")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  begin(runId: string): AutomationRun {
    const run = this.#requiredRun(runId);
    if (run.status !== "pending") throw new Error("automation_run_not_pending");
    const next = automationRunSchema.parse({
      ...run,
      status: "running",
      attempt: run.attempt + 1,
      startedAt: this.#clock.now().toISOString(),
      error: null,
    });
    this.#runs.set(runId, next);
    this.#save();
    return next;
  }

  finish(
    runId: string,
    outcome:
      | { status: "succeeded"; sessionId: string; result?: string }
      | { status: "failed"; error: string; sessionId?: string },
  ): AutomationRun {
    const run = this.#requiredRun(runId);
    if (run.status !== "running") throw new Error("automation_run_not_running");
    const next = automationRunSchema.parse({
      ...run,
      status: outcome.status,
      sessionId: outcome.sessionId ?? null,
      result: outcome.status === "succeeded" ? (outcome.result ?? null) : null,
      error: outcome.status === "failed" ? outcome.error : null,
      finishedAt: this.#clock.now().toISOString(),
    });
    this.#runs.set(runId, next);
    this.#save();
    return next;
  }

  cancel(runId: string): AutomationRun {
    const run = this.#requiredRun(runId);
    if (run.status !== "pending" && run.status !== "running")
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
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify(
        {
          version: 1,
          definitions: [...this.#definitions.values()],
          runs: [...this.#runs.values()],
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
};

export interface AutomationRunnerPort {
  execute(
    request: AutomationExecution,
  ): Promise<{ sessionId: string; result?: string }>;
}

export class AutomationScheduler {
  #ticking = false;

  constructor(
    readonly store: AutomationStore,
    readonly runner: AutomationRunnerPort,
  ) {}

  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      for (const pending of this.store.claimRunnable()) {
        let run: AutomationRun;
        try {
          run = this.store.begin(pending.id);
        } catch {
          continue;
        }
        const definition = this.store.get(run.automationId);
        if (definition === undefined) continue;
        try {
          const result = await this.runner.execute({
            automationRunId: run.id,
            definition,
          });
          this.store.finish(run.id, { status: "succeeded", ...result });
        } catch (error) {
          this.store.finish(run.id, {
            status: "failed",
            error: error instanceof Error ? error.message : "automation_failed",
          });
        }
      }
    } finally {
      this.#ticking = false;
    }
  }
}
