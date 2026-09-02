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
  teamCreateSchema,
  teamDocumentSchema,
  teamEventSchema,
  teamMailboxMessageSchema,
  teamMemberSchema,
  teamSchema,
  teamTaskSchema,
  type EngineId,
  type Team,
  type TeamCreate,
  type TeamEvent,
  type TeamMailboxMessage,
  type TeamMember,
  type TeamTask,
} from "@workagent/contracts";

import {
  PlatformNotificationClient,
  type TerminalNotificationPort,
} from "./notification-client.js";

type Clock = { now(): Date };
const defaultClock: Clock = { now: () => new Date() };

export class TeamStore {
  readonly #path: string;
  readonly #clock: Clock;
  readonly #teams = new Map<string, Team>();
  readonly #tasks = new Map<string, TeamTask>();
  readonly #messages = new Map<string, TeamMailboxMessage>();
  readonly #events: TeamEvent[] = [];
  #sequence = 0;
  readonly #quotaReconciledTaskIds = new Set<string>();

  constructor(dshHome: string, clock: Clock = defaultClock) {
    this.#path = join(dshHome, "workagent", "teams.json");
    this.#clock = clock;
    if (!existsSync(this.#path)) return;
    const document = teamDocumentSchema.parse(
      JSON.parse(readFileSync(this.#path, "utf8")),
    );
    for (const team of document.teams) this.#teams.set(team.id, team);
    let recovered = false;
    for (const stored of document.tasks) {
      const task =
        stored.status === "running"
          ? teamTaskSchema.parse({
              ...stored,
              status: "failed",
              error: "runtime_restarted",
              finishedAt: this.#now(),
            })
          : stored;
      if (task !== stored) recovered = true;
      this.#tasks.set(task.id, task);
    }
    for (const message of document.messages)
      this.#messages.set(message.id, message);
    for (const event of document.events) this.#events.push(event);
    this.#sequence = Math.max(
      document.eventSequence,
      ...document.events.map((event) => event.sequence),
      0,
    );
    for (const id of document.quotaReconciledTaskIds)
      this.#quotaReconciledTaskIds.add(id);
    if (recovered) {
      for (const [id, team] of this.#teams)
        this.#teams.set(id, {
          ...team,
          members: team.members.map((member) =>
            member.status === "running"
              ? { ...member, status: "idle" }
              : member,
          ),
        });
      this.#save();
    }
  }

  list(): Team[] {
    return [...this.#teams.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }
  get(id: string): Team | undefined {
    return this.#teams.get(id);
  }

  create(input: TeamCreate): Team {
    const value = teamCreateSchema.parse(input);
    const now = this.#now();
    const id = `team-${randomUUID()}`;
    const lead = teamMemberSchema.parse({
      id: `member-${randomUUID()}`,
      ...value.lead,
      role: "lead",
      status: "idle",
      sessionId: `session-${randomUUID()}`,
      createdAt: now,
    });
    const team = teamSchema.parse({
      id,
      version: 1,
      name: value.name,
      workspaceId: value.workspaceId,
      sessionMode: null,
      members: [lead],
      createdAt: now,
      updatedAt: now,
    });
    this.#teams.set(id, team);
    this.#event(id, "team.created", id);
    this.#save();
    return team;
  }

  update(
    id: string,
    expectedVersion: number,
    mutation: { name?: string; sessionMode?: string | null },
  ): Team {
    const team = this.#requiredTeam(id);
    if (team.version !== expectedVersion)
      throw new Error("team_version_conflict");
    const next = teamSchema.parse({
      ...team,
      ...(mutation.name === undefined ? {} : { name: mutation.name }),
      ...(mutation.sessionMode === undefined
        ? {}
        : { sessionMode: mutation.sessionMode }),
      version: team.version + 1,
      updatedAt: this.#now(),
    });
    this.#teams.set(id, next);
    this.#event(
      id,
      mutation.name === undefined ? "team.updated" : "team.renamed",
      id,
    );
    this.#save();
    return next;
  }

  addMember(
    teamId: string,
    input: { name: string; engine: EngineId; presetId: string },
  ): Team {
    const team = this.#requiredTeam(teamId);
    if (
      team.members.some(
        (member) =>
          member.name.toLocaleLowerCase() ===
          input.name.trim().toLocaleLowerCase(),
      )
    )
      throw new Error("team_member_name_conflict");
    const member = teamMemberSchema.parse({
      id: `member-${randomUUID()}`,
      ...input,
      role: "member",
      status: "idle",
      sessionId: `session-${randomUUID()}`,
      createdAt: this.#now(),
    });
    const next = teamSchema.parse({
      ...team,
      version: team.version + 1,
      members: [...team.members, member],
      updatedAt: this.#now(),
    });
    this.#teams.set(teamId, next);
    this.#event(teamId, "member.added", member.id);
    this.#save();
    return next;
  }

  updateMember(
    teamId: string,
    memberId: string,
    input: { name?: string; engine?: EngineId; presetId?: string },
  ): Team {
    const team = this.#requiredTeam(teamId);
    const current = this.#requiredMember(team, memberId);
    if (current.status === "running") throw new Error("team_member_busy");
    if (
      input.name !== undefined &&
      team.members.some(
        (member) =>
          member.id !== memberId &&
          member.name.toLocaleLowerCase() ===
            input.name!.trim().toLocaleLowerCase(),
      )
    )
      throw new Error("team_member_name_conflict");
    const updated = teamMemberSchema.parse({ ...current, ...input });
    const next = teamSchema.parse({
      ...team,
      version: team.version + 1,
      members: team.members.map((member) =>
        member.id === memberId ? updated : member,
      ),
      updatedAt: this.#now(),
    });
    this.#teams.set(teamId, next);
    this.#event(
      teamId,
      input.name !== undefined && input.name !== current.name
        ? "member.renamed"
        : "team.updated",
      memberId,
    );
    this.#save();
    return next;
  }

  removeMember(teamId: string, memberId: string): Team {
    const team = this.#requiredTeam(teamId);
    const member = this.#requiredMember(team, memberId);
    if (member.role === "lead") throw new Error("team_lead_cannot_be_removed");
    if (
      member.status === "running" ||
      this.tasks(teamId).some(
        (task) =>
          task.memberId === memberId &&
          (task.status === "queued" || task.status === "running"),
      )
    )
      throw new Error("team_member_busy");
    const next = teamSchema.parse({
      ...team,
      version: team.version + 1,
      members: team.members.filter((value) => value.id !== memberId),
      updatedAt: this.#now(),
    });
    this.#teams.set(teamId, next);
    this.#event(teamId, "member.removed", memberId);
    this.#save();
    return next;
  }

  delete(teamId: string): void {
    this.#requiredTeam(teamId);
    if (
      this.tasks(teamId).some(
        (task) => task.status === "queued" || task.status === "running",
      )
    )
      throw new Error("team_has_active_task");
    this.#event(teamId, "team.removed", teamId);
    this.#teams.delete(teamId);
    for (const [id, task] of this.#tasks)
      if (task.teamId === teamId) this.#tasks.delete(id);
    for (const [id, message] of this.#messages)
      if (message.teamId === teamId) this.#messages.delete(id);
    for (let index = this.#events.length - 1; index >= 0; index--)
      if (
        this.#events[index]!.teamId === teamId &&
        this.#events[index]!.type !== "team.removed"
      )
        this.#events.splice(index, 1);
    this.#save();
  }

  tasks(teamId: string): TeamTask[] {
    this.#requiredTeam(teamId);
    return [...this.#tasks.values()]
      .filter((task) => task.teamId === teamId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  task(id: string): TeamTask | undefined {
    return this.#tasks.get(id);
  }
  queueTask(
    teamId: string,
    input: { memberId: string; title: string; input: string },
  ): TeamTask {
    const team = this.#requiredTeam(teamId);
    this.#requiredMember(team, input.memberId);
    const now = this.#now();
    const task = teamTaskSchema.parse({
      id: `team-task-${randomUUID()}`,
      teamId,
      ...input,
      status: "queued",
      sessionId: null,
      result: null,
      error: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    });
    this.#tasks.set(task.id, task);
    this.#event(teamId, "task.queued", task.id);
    this.#save();
    return task;
  }

  claimQueued(): TeamTask[] {
    return [...this.#tasks.values()]
      .filter((task) => task.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  interruptedExecutions(): TeamExecution[] {
    const executions: TeamExecution[] = [];
    for (const task of this.#tasks.values()) {
      if (task.status !== "failed" || task.error !== "runtime_restarted")
        continue;
      if (this.#quotaReconciledTaskIds.has(task.id)) continue;
      const team = this.#requiredTeam(task.teamId);
      const member = this.#requiredMember(team, task.memberId);
      executions.push(this.#execution(task, team, member));
    }
    return executions.sort((left, right) =>
      left.taskId.localeCompare(right.taskId),
    );
  }
  acknowledgeInterruptedExecution(taskId: string): void {
    const task = this.#requiredTask(taskId);
    if (task.status !== "failed" || task.error !== "runtime_restarted")
      throw new Error("team_task_not_interrupted");
    this.#quotaReconciledTaskIds.add(taskId);
    this.#save();
  }
  beginTask(id: string): { task: TeamTask; member: TeamMember; team: Team } {
    const task = this.#requiredTask(id);
    if (task.status !== "queued") throw new Error("team_task_not_queued");
    const team = this.#requiredTeam(task.teamId);
    const member = this.#requiredMember(team, task.memberId);
    if (member.status === "running") throw new Error("team_member_busy");
    const nextTask = teamTaskSchema.parse({
      ...task,
      status: "running",
      startedAt: this.#now(),
    });
    const running = teamMemberSchema.parse({
      ...member,
      status: "running",
      sessionId: member.sessionId ?? `session-${randomUUID()}`,
    });
    const nextTeam = teamSchema.parse({
      ...team,
      members: team.members.map((value) =>
        value.id === member.id ? running : value,
      ),
      updatedAt: this.#now(),
    });
    this.#tasks.set(id, nextTask);
    this.#teams.set(team.id, nextTeam);
    this.#event(team.id, "task.started", id);
    this.#save();
    return { task: nextTask, member: running, team: nextTeam };
  }

  finishTask(
    id: string,
    outcome:
      | { status: "succeeded"; sessionId: string; result?: string }
      | { status: "failed"; error: string; sessionId?: string },
  ): TeamTask {
    const task = this.#requiredTask(id);
    if (task.status === "cancelled") return task;
    if (task.status !== "running") throw new Error("team_task_not_running");
    const next = teamTaskSchema.parse({
      ...task,
      status: outcome.status,
      sessionId: outcome.sessionId ?? null,
      result: outcome.status === "succeeded" ? (outcome.result ?? null) : null,
      error: outcome.status === "failed" ? outcome.error : null,
      finishedAt: this.#now(),
    });
    this.#tasks.set(id, next);
    this.#idleMember(task.teamId, task.memberId, outcome.status === "failed");
    this.#event(
      task.teamId,
      outcome.status === "failed" ? "task.failed" : "task.completed",
      id,
    );
    this.#save();
    return next;
  }

  cancelTask(teamId: string, id: string): TeamTask {
    const task = this.#requiredTask(id);
    if (task.teamId !== teamId) throw new Error("team_task_not_found");
    if (task.status !== "queued" && task.status !== "running")
      throw new Error("team_task_not_cancellable");
    const next = teamTaskSchema.parse({
      ...task,
      status: "cancelled",
      finishedAt: this.#now(),
    });
    this.#tasks.set(id, next);
    if (task.status === "running")
      this.#idleMember(teamId, task.memberId, false);
    this.#event(teamId, "task.cancelled", id);
    this.#save();
    return next;
  }

  messages(teamId: string, memberId?: string): TeamMailboxMessage[] {
    const team = this.#requiredTeam(teamId);
    if (memberId !== undefined) this.#requiredMember(team, memberId);
    return [...this.#messages.values()]
      .filter(
        (message) =>
          message.teamId === teamId &&
          (memberId === undefined ||
            message.toMemberId === null ||
            message.toMemberId === memberId ||
            message.fromMemberId === memberId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  sendMessage(
    teamId: string,
    input: {
      fromMemberId: string | null;
      toMemberId: string | null;
      body: string;
    },
  ): TeamMailboxMessage {
    const team = this.#requiredTeam(teamId);
    if (input.fromMemberId !== null)
      this.#requiredMember(team, input.fromMemberId);
    if (input.toMemberId !== null) this.#requiredMember(team, input.toMemberId);
    const message = teamMailboxMessageSchema.parse({
      id: `team-mail-${randomUUID()}`,
      teamId,
      ...input,
      createdAt: this.#now(),
      readAt: null,
    });
    this.#messages.set(message.id, message);
    this.#event(teamId, "mail.received", message.id);
    this.#save();
    return message;
  }
  events(teamId: string, after = 0): TeamEvent[] {
    this.#requiredTeam(teamId);
    return this.#events.filter(
      (event) => event.teamId === teamId && event.sequence > after,
    );
  }
  allEvents(after = 0): TeamEvent[] {
    return this.#events.filter((event) => event.sequence > after);
  }

  #idleMember(teamId: string, memberId: string, failed: boolean): void {
    const team = this.#requiredTeam(teamId);
    this.#teams.set(teamId, {
      ...team,
      members: team.members.map((member) =>
        member.id === memberId
          ? { ...member, status: failed ? "error" : "idle" }
          : member,
      ),
      updatedAt: this.#now(),
    });
  }
  #event(teamId: string, type: TeamEvent["type"], subjectId: string): void {
    this.#events.push(
      teamEventSchema.parse({
        id: `team-event-${randomUUID()}`,
        teamId,
        sequence: ++this.#sequence,
        type,
        subjectId,
        occurredAt: this.#now(),
      }),
    );
  }
  #requiredTeam(id: string): Team {
    const value = this.#teams.get(id);
    if (value === undefined) throw new Error("team_not_found");
    return value;
  }
  #requiredTask(id: string): TeamTask {
    const value = this.#tasks.get(id);
    if (value === undefined) throw new Error("team_task_not_found");
    return value;
  }
  #requiredMember(team: Team, id: string): TeamMember {
    const value = team.members.find((member) => member.id === id);
    if (value === undefined) throw new Error("team_member_not_found");
    return value;
  }
  #execution(task: TeamTask, team: Team, member: TeamMember): TeamExecution {
    return {
      taskId: task.id,
      teamId: team.id,
      memberId: member.id,
      sessionId: member.sessionId ?? `session-${task.id}`,
      name: `${team.name} · ${member.name}`,
      engine: member.engine,
      presetId: member.presetId,
      workspaceId: team.workspaceId,
      input: task.input,
    };
  }
  #now(): string {
    return this.#clock.now().toISOString();
  }
  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, teams: this.list(), tasks: [...this.#tasks.values()], messages: [...this.#messages.values()], events: this.#events, eventSequence: this.#sequence, quotaReconciledTaskIds: [...this.#quotaReconciledTaskIds].sort() }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporary, this.#path);
  }
}

export type TeamExecution = {
  taskId: string;
  teamId: string;
  memberId: string;
  sessionId: string;
  name: string;
  engine: EngineId;
  presetId: string;
  workspaceId: string;
  input: string;
};
export interface TeamRunnerPort {
  executeTeamTask(
    request: TeamExecution,
  ): Promise<{ sessionId: string; result?: string }>;
  cancelTeamTask?(taskId: string): Promise<void>;
  reconcileInterruptedTeamTask?(request: TeamExecution): Promise<void>;
}

export type TeamSessionRequest = {
  sessionId: string;
  title: string;
  engine: EngineId;
  presetId: string;
  workspaceId: string;
};
export interface TeamSessionPort {
  openTeamSession(request: TeamSessionRequest): Promise<void>;
}

export class TeamOrchestrator {
  #ticking = false;
  #recovered = false;
  #recovering: Promise<void> | undefined;
  constructor(
    readonly store: TeamStore,
    readonly runner: TeamRunnerPort,
    readonly notifier:
      | TerminalNotificationPort
      | undefined = PlatformNotificationClient.fromEnvironment(),
  ) {}
  start(): void {
    void this.tick().catch(() => undefined);
  }
  async tick(): Promise<void> {
    await this.#recoverInterruptedTasks();
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      for (;;) {
        const executions: Promise<void>[] = [];
        for (const queued of this.store.claimQueued()) {
          let begun;
          try {
            begun = this.store.beginTask(queued.id);
          } catch {
            continue;
          }
          executions.push(this.#execute(begun));
        }
        if (executions.length === 0) return;
        await Promise.all(executions);
      }
    } finally {
      this.#ticking = false;
    }
  }

  async #recoverInterruptedTasks(): Promise<void> {
    if (this.#recovered) return;
    if (this.#recovering === undefined) {
      this.#recovering = (async () => {
        for (const request of this.store.interruptedExecutions()) {
          if (this.runner.reconcileInterruptedTeamTask !== undefined)
            await this.runner.reconcileInterruptedTeamTask(request);
          this.store.acknowledgeInterruptedExecution(request.taskId);
        }
        this.#recovered = true;
      })().finally(() => {
        this.#recovering = undefined;
      });
    }
    await this.#recovering;
  }

  async #execute(begun: ReturnType<TeamStore["beginTask"]>): Promise<void> {
    try {
      const result = await this.runner.executeTeamTask({
        taskId: begun.task.id,
        teamId: begun.team.id,
        memberId: begun.member.id,
        sessionId: begun.member.sessionId ?? `session-${begun.task.id}`,
        name: `${begun.team.name} · ${begun.member.name}`,
        engine: begun.member.engine,
        presetId: begun.member.presetId,
        workspaceId: begun.team.workspaceId,
        input: begun.task.input,
      });
      this.#notifyTerminal(
        begun.team,
        this.store.finishTask(begun.task.id, {
          status: "succeeded",
          ...result,
        }),
      );
    } catch (error) {
      this.#notifyTerminal(
        begun.team,
        this.store.finishTask(begun.task.id, {
          status: "failed",
          error: error instanceof Error ? error.message : "team_task_failed",
        }),
      );
    }
  }

  // Delivers the terminal-state notification through the platform
  // Notifications module. Publish failures must never break the task, so the
  // promise is fire-and-forget.
  #notifyTerminal(team: Team, task: TeamTask): void {
    if (this.notifier === undefined) return;
    // A cancel can race execute; finishTask() then returns the cancelled task.
    if (task.status !== "succeeded" && task.status !== "failed") return;
    void this.notifier
      .publish({
        kind: "team",
        title:
          task.status === "failed" ? "Team task failed" : "Team task completed",
        message:
          task.status === "failed"
            ? `Team "${team.name}" task "${task.title}" failed: ${task.error ?? "unknown error"}`
            : `Team "${team.name}" task "${task.title}" completed.`,
        deepLink: `/team/${team.id}`,
      })
      .catch(() => undefined);
  }
  async cancel(teamId: string, taskId: string): Promise<TeamTask> {
    const task = this.store.cancelTask(teamId, taskId);
    await this.runner.cancelTeamTask?.(taskId);
    return task;
  }
}
