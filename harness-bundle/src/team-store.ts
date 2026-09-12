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
import {
  SessionBusyError,
  type ExecutionAdmission,
} from "./execution-admission.js";
import {
  teamCreateSchema,
  teamDocumentSchema,
  teamEventSchema,
  teamMailboxMessageSchema,
  teamMemberSchema,
  teamSchema,
  teamTaskSchema,
  teamRunSchema,
  teamDispatchSchema,
  type TeamRun,
  type TeamDispatch,
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
  readonly #runs = new Map<string, TeamRun>();
  readonly #dispatches = new Map<string, TeamDispatch>();
  readonly #operations = new Map<
    string,
    { id: string; input: string; result: ReturnType<typeof JSON.parse> }
  >();
  #batch = false;

  readonly #quotaReconciledTaskIds = new Set<string>();

  constructor(dshHome: string, clock: Clock = defaultClock) {
    this.#path = join(dshHome, "workagent", "teams.json");
    this.#clock = clock;
    if (!existsSync(this.#path)) return;
    const document = teamDocumentSchema.parse(
      JSON.parse(readFileSync(this.#path, "utf8")),
    );
    for (const team of document.teams) this.#teams.set(team.id, team);
    for (const value of document.runs) this.#runs.set(value.id, value);
    for (const value of document.operations)
      this.#operations.set(value.id, value);
    for (const value of document.dispatches) {
      const interrupted = value.status === "running";
      this.#dispatches.set(
        value.id,
        interrupted
          ? {
              ...value,
              status: "interrupted",
              error: "runtime_restarted",
              finishedAt: this.#now(),
            }
          : value,
      );
      if (interrupted) {
        const run = this.#runs.get(value.runId)!;
        this.#runs.set(run.id, {
          ...run,
          status: "interrupted",
          reason: "runtime_restarted",
          updatedAt: this.#now(),
        });
      }
    }
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
    for (const dispatch of this.#dispatches.values()) {
      const task = dispatch.taskId
        ? this.#tasks.get(dispatch.taskId)
        : undefined;
      if (
        dispatch.status === "queued" &&
        task &&
        ["failed", "succeeded", "cancelled"].includes(task.status)
      )
        this.#dispatches.set(dispatch.id, {
          ...dispatch,
          status: "cancelled",
          finishedAt: this.#now(),
        });
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
    for (const task of this.#tasks.values()) {
      if (
        task.status === "queued" &&
        ![...this.#dispatches.values()].some((item) => item.taskId === task.id)
      ) {
        const run = this.#ensureRun(task.teamId, task.input);
        this.#enqueue(run, task.memberId, task.input, null, task.id);
        recovered = true;
      }
    }
    if (
      recovered ||
      document.dispatches.some((item) => item.status === "running")
    ) {
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
    mutation: {
      name?: string;
      sessionMode?: string | null;
      memberIds?: string[];
    },
  ): Team {
    const team = this.#requiredTeam(id);
    if (team.version !== expectedVersion)
      throw new Error("team_version_conflict");
    if (
      mutation.memberIds &&
      (mutation.memberIds.length !== team.members.length ||
        new Set(mutation.memberIds).size !== team.members.length ||
        mutation.memberIds[0] !==
          team.members.find((member) => member.role === "lead")?.id ||
        mutation.memberIds.some(
          (id) => !team.members.some((member) => member.id === id),
        ))
    )
      throw new Error("invalid_member_order");
    const next = teamSchema.parse({
      ...team,
      members: mutation.memberIds
        ? mutation.memberIds.map(
            (id) => team.members.find((member) => member.id === id)!,
          )
        : team.members,
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
    input: {
      name: string;
      engine: EngineId;
      presetId: string;
      acpCatalogId?: string;
    },
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
    input: {
      name?: string;
      engine?: EngineId;
      presetId?: string;
      acpCatalogId?: string;
    },
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
    const changedEngine =
      (input.engine !== undefined && input.engine !== current.engine) ||
      (input.presetId !== undefined && input.presetId !== current.presetId) ||
      (input.acpCatalogId !== undefined &&
        input.acpCatalogId !== current.acpCatalogId);
    const updated = teamMemberSchema.parse({
      ...current,
      ...input,
      ...(changedEngine ? { sessionId: `session-${randomUUID()}` } : {}),
    });
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
      this.dispatches().some(
        (item) =>
          item.memberId === memberId &&
          ["queued", "running"].includes(item.status),
      ) ||
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
      this.dispatches().some(
        (item) =>
          item.teamId === teamId && ["queued", "running"].includes(item.status),
      ) ||
      this.tasks(teamId).some(
        (task) => task.status === "queued" || task.status === "running",
      )
    )
      throw new Error("team_has_active_task");
    this.#event(teamId, "team.removed", teamId);
    this.#teams.delete(teamId);
    for (const [id, run] of this.#runs)
      if (run.teamId === teamId) this.#runs.delete(id);
    for (const [id, dispatch] of this.#dispatches)
      if (dispatch.teamId === teamId) this.#dispatches.delete(id);
    for (const id of this.#operations.keys())
      if (id.startsWith(`${teamId}:`)) this.#operations.delete(id);
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
    input: {
      memberId: string;
      title: string;
      input: string;
      dependsOnIds?: string[];
      createdByMemberId?: string | null;
    },
    parentId: string | null = null,
  ): TeamTask {
    if (!this.#batch)
      return this.#transaction(() => this.queueTask(teamId, input, parentId));
    const team = this.#requiredTeam(teamId);
    this.#requiredMember(team, input.memberId);
    this.#validateDependencies(teamId, input.dependsOnIds ?? []);
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
    const run = this.#ensureRun(teamId, task.input);
    this.#enqueue(run, task.memberId, task.input, parentId, task.id);
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
      if (
        this.dispatches().some(
          (item) => item.taskId === task.id && item.status === "interrupted",
        )
      )
        continue;
      if (task.status !== "failed" || task.error !== "runtime_restarted")
        continue;
      if (this.#quotaReconciledTaskIds.has(task.id)) continue;
      const team = this.#requiredTeam(task.teamId);
      const member = this.#requiredMember(team, task.memberId);
      executions.push(this.#execution(task, team, member));
    }
    for (const item of this.#dispatches.values()) {
      if (
        item.status !== "interrupted" ||
        this.#quotaReconciledTaskIds.has(item.id)
      )
        continue;
      const team = this.#requiredTeam(item.teamId);
      const member = this.#requiredMember(team, item.memberId);
      executions.push({
        taskId: item.id,
        teamId: team.id,
        memberId: member.id,
        sessionId: member.sessionId!,
        name: team.name,
        engine: member.engine,
        acpCatalogId: member.acpCatalogId,
        presetId: member.presetId,
        workspaceId: team.workspaceId,
        input: item.input,
      });
    }
    return executions.sort((left, right) =>
      left.taskId.localeCompare(right.taskId),
    );
  }
  acknowledgeInterruptedExecution(taskId: string): void {
    if (this.#dispatches.get(taskId)?.status === "interrupted") {
      this.#quotaReconciledTaskIds.add(taskId);
      this.#save();
      return;
    }
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
    if (
      task.dependsOnIds.some(
        (id) => this.#tasks.get(id)?.status !== "succeeded",
      )
    )
      throw new Error("team_task_blocked");
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
    for (const dispatch of this.#dispatches.values())
      if (
        dispatch.taskId === id &&
        ["queued", "running"].includes(dispatch.status)
      )
        this.#dispatches.set(dispatch.id, {
          ...dispatch,
          status: "cancelled",
          finishedAt: this.#now(),
        });
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
    parentId: string | null = null,
  ): TeamMailboxMessage {
    if (!this.#batch)
      return this.#transaction(() => this.sendMessage(teamId, input, parentId));
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
    const run = this.#ensureRun(teamId, input.body);
    const targets = input.toMemberId
      ? [input.toMemberId]
      : team.members
          .filter((member) => member.id !== input.fromMemberId)
          .map((member) => member.id);
    for (const memberId of targets) {
      const pending = [...this.#dispatches.values()].find(
        (item) =>
          item.runId === run.id &&
          item.memberId === memberId &&
          item.status === "queued" &&
          item.taskId === null &&
          item.messageIds.length > 0,
      );
      const text = `团队消息（${input.fromMemberId ?? "用户"}）：\n${input.body}`;
      if (pending) {
        const depth = this.#registerEdge(run, memberId, parentId);
        this.#dispatches.set(pending.id, {
          ...pending,
          depth: Math.max(pending.depth, depth),
          messageIds: [...pending.messageIds, message.id],
          input: `${pending.input}\n\n${text}`,
        });
      } else this.#enqueue(run, memberId, text, parentId, null, [message.id]);
    }
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

  runs(teamId: string): TeamRun[] {
    this.#requiredTeam(teamId);
    return [...this.#runs.values()].filter((run) => run.teamId === teamId);
  }
  contextForSession(sessionId: string) {
    for (const team of this.#teams.values()) {
      const member = team.members.find((item) => item.sessionId === sessionId);
      if (member)
        return {
          team,
          member,
          dispatch: this.dispatches().find(
            (item) => item.memberId === member.id && item.status === "running",
          ),
          run: this.runs(team.id).findLast(
            (item) => !["completed", "cancelled"].includes(item.status),
          ),
        };
    }
    return undefined;
  }
  operation<T>(id: string, input: unknown, perform: () => T): T {
    if (!/^[A-Za-z0-9_:@.-]{1,200}$/.test(id))
      throw new Error("invalid_operation_id");
    const encoded = JSON.stringify(input);
    const previous = this.#operations.get(id);
    if (previous) {
      if (previous.input !== encoded) throw new Error("operation_id_conflict");
      return previous.result as T;
    }
    return this.#transaction(() => {
      const result = perform();
      this.#operations.set(id, {
        id,
        input: encoded,
        result: JSON.parse(JSON.stringify(result ?? null)),
      });
      return result;
    });
  }
  #transaction<T>(perform: () => T): T {
    if (this.#batch) return perform();
    const before = {
      teams: new Map(this.#teams),
      tasks: new Map(this.#tasks),
      messages: new Map(this.#messages),
      runs: new Map(this.#runs),
      dispatches: new Map(this.#dispatches),
      operations: new Map(this.#operations),
      events: [...this.#events],
      sequence: this.#sequence,
    };
    this.#batch = true;
    try {
      const result = perform();
      this.#batch = false;
      this.#save();
      return result;
    } catch (error) {
      for (const [target, snapshot] of [
        [this.#teams, before.teams],
        [this.#tasks, before.tasks],
        [this.#messages, before.messages],
        [this.#runs, before.runs],
        [this.#dispatches, before.dispatches],
        [this.#operations, before.operations],
      ] as [Map<string, unknown>, Map<string, unknown>][]) {
        target.clear();
        for (const [key, value] of snapshot) target.set(key, value);
      }
      this.#events.splice(0, this.#events.length, ...before.events);
      this.#sequence = before.sequence;
      this.#batch = false;
      throw error;
    }
  }
  startRun(teamId: string, input: string, memberId?: string): TeamRun {
    if (!input.trim() || input.length > 65536)
      throw new Error("invalid_team_input");
    const team = this.#requiredTeam(teamId);
    const target =
      memberId ?? team.members.find((item) => item.role === "lead")!.id;
    this.#requiredMember(team, target);
    const run = this.#ensureRun(teamId, input);
    if (run.status !== "running") throw new Error("team_run_requires_resume");
    this.#enqueue(run, target, input);
    this.#save();
    return run;
  }
  controlRun(
    teamId: string,
    runId: string,
    action: "pause" | "resume" | "cancel",
  ): TeamRun {
    if (!this.#batch)
      return this.#transaction(() => this.controlRun(teamId, runId, action));
    const run = this.#runs.get(runId);
    if (!run || run.teamId !== teamId) throw new Error("team_run_not_found");
    if (["completed", "cancelled"].includes(run.status))
      throw new Error("team_run_finished");
    const next: TeamRun = {
      ...run,
      status:
        action === "resume"
          ? "running"
          : action === "pause"
            ? "paused"
            : "cancelled",
      reason: null,
      updatedAt: this.#now(),
      ...(action === "resume"
        ? { segment: run.segment + 1, dispatchCount: 0, recruitedCount: 0 }
        : {}),
    };
    this.#runs.set(runId, next);
    if (action === "cancel")
      for (const item of this.#dispatches.values()) {
        if (
          item.runId !== runId ||
          !["queued", "running"].includes(item.status)
        )
          continue;
        this.#dispatches.set(item.id, {
          ...item,
          status: "cancelled",
          finishedAt: this.#now(),
        });
        if (
          item.taskId &&
          ["queued", "running"].includes(this.#requiredTask(item.taskId).status)
        )
          this.cancelTask(teamId, item.taskId);
        this.#idleMember(teamId, item.memberId, false);
      }
    if (action === "resume") {
      for (const item of this.#dispatches.values())
        if (item.runId === runId && item.status === "queued")
          this.#dispatches.set(item.id, { ...item, depth: 0, parentId: null });
      if (run.status === "interrupted" || run.reason === "dependency_failed") {
        const lead = this.#requiredTeam(teamId).members.find(
          (member) => member.role === "lead",
        )!;
        this.#enqueue(
          next,
          lead.id,
          "用户要求继续团队目标。上次运行中断，已经发送的操作可能发生过，请先检查成员会话和文件状态；不要盲目重复外部操作。",
        );
      }
    }
    this.#event(teamId, "run.updated", runId);
    this.#save();
    return next;
  }
  recruit(
    teamId: string,
    parentId: string,
    input: {
      name: string;
      engine: EngineId;
      presetId: string;
      acpCatalogId?: string;
    },
  ): Team {
    if (!this.#batch)
      return this.#transaction(() => this.recruit(teamId, parentId, input));
    const parent = this.#dispatches.get(parentId);
    if (!parent || parent.teamId !== teamId || parent.status !== "running")
      throw new Error("team_dispatch_expired");
    const run = this.#runs.get(parent.runId)!;
    if (run.status !== "running") throw new Error("team_run_paused");
    if (run.recruitedCount >= 8) throw new Error("team_recruit_limit");
    const team = this.addMember(teamId, input);
    this.#runs.set(run.id, {
      ...run,
      recruitedCount: run.recruitedCount + 1,
      ...(run.recruitedCount + 1 >= 8
        ? { status: "paused_limit", reason: "recruit_limit" }
        : {}),
    });
    this.#event(teamId, "run.updated", run.id);
    this.#save();
    return team;
  }
  updateTask(
    teamId: string,
    taskId: string,
    version: number,
    input: {
      title?: string;
      input?: string;
      dependsOnIds?: string[];
      status?: "succeeded" | "failed";
      result?: string;
    },
    callerMemberId?: string,
  ): TeamTask {
    const task = this.#requiredTask(taskId);
    if (task.teamId !== teamId) throw new Error("team_task_not_found");
    if (task.version !== version) throw new Error("team_task_version_conflict");
    if (input.status && task.status !== "running")
      throw new Error("team_task_not_running");
    if (
      callerMemberId &&
      task.memberId !== callerMemberId &&
      this.#requiredMember(this.#requiredTeam(teamId), callerMemberId).role !==
        "lead"
    )
      throw new Error("team_task_forbidden");
    if (input.dependsOnIds)
      this.#validateDependencies(teamId, input.dependsOnIds, taskId);
    if (task.status !== "queued" && (input.input || input.dependsOnIds))
      throw new Error("team_task_already_started");
    const next = teamTaskSchema.parse({
      ...task,
      ...input,
      version: task.version + 1,
      ...(input.status ? { finishedAt: this.#now() } : {}),
    });
    this.#tasks.set(taskId, next);
    if (input.input)
      for (const item of this.#dispatches.values())
        if (item.taskId === taskId && item.status === "queued")
          this.#dispatches.set(item.id, { ...item, input: input.input });
    this.#event(teamId, "task.updated", taskId);
    this.#save();
    return next;
  }
  dispatches(runId?: string): TeamDispatch[] {
    return [...this.#dispatches.values()].filter(
      (item) => !runId || item.runId === runId,
    );
  }
  hasActiveWork(): boolean {
    return this.dispatches().some(
      (item) =>
        item.status === "running" ||
        (item.status === "queued" &&
          this.#runs.get(item.runId)?.status === "running" &&
          (!item.notBefore || new Date(item.notBefore) <= this.#clock.now()) &&
          (!item.taskId ||
            this.#requiredTask(item.taskId).dependsOnIds.every(
              (id) => this.#tasks.get(id)?.status === "succeeded",
            ))),
    );
  }
  nextWakeAt(): string | null {
    return (
      this.dispatches()
        .filter(
          (item) =>
            item.status === "queued" &&
            this.#runs.get(item.runId)?.status === "running" &&
            item.notBefore,
        )
        .map((item) => item.notBefore!)
        .sort()[0] ?? null
    );
  }
  queuedDispatches(): TeamDispatch[] {
    return this.dispatches().filter(
      (item) =>
        item.status === "queued" &&
        this.#runs.get(item.runId)?.status === "running" &&
        (!item.notBefore || new Date(item.notBefore) <= this.#clock.now()),
    );
  }
  pauseBlockedRuns(): void {
    for (const run of this.#runs.values()) {
      if (run.status !== "running") continue;
      const outstanding = this.dispatches(run.id).filter((item) =>
        ["queued", "running"].includes(item.status),
      );
      if (
        !outstanding.length ||
        outstanding.some(
          (item) =>
            item.status === "running" ||
            !item.taskId ||
            !this.#requiredTask(item.taskId).dependsOnIds.some((id) =>
              ["failed", "cancelled"].includes(this.#requiredTask(id).status),
            ),
        )
      )
        continue;
      this.#runs.set(run.id, {
        ...run,
        status: "paused",
        reason: "dependency_failed",
        updatedAt: this.#now(),
      });
      this.#event(run.teamId, "run.updated", run.id);
      this.#save();
    }
  }
  beginDispatch(id: string): TeamExecution {
    const item = this.#dispatches.get(id)!;
    const run = this.#runs.get(item.runId)!;
    if (item.status !== "queued" || run.status !== "running")
      throw new Error("team_dispatch_not_ready");
    const team = this.#requiredTeam(item.teamId);
    const member = this.#requiredMember(team, item.memberId);
    if (
      member.status === "running" ||
      this.dispatches(item.runId).filter((row) => row.status === "running")
        .length >= 4
    )
      throw new Error("team_member_busy");
    if (run.dispatchCount >= 64 || item.depth > 8) {
      this.#runs.set(run.id, {
        ...run,
        status: "paused_limit",
        reason: run.dispatchCount >= 64 ? "dispatch_budget" : "depth_limit",
        updatedAt: this.#now(),
      });
      this.#event(team.id, "run.updated", run.id);
      this.#save();
      throw new Error("team_run_limit");
    }
    return this.#transaction(() => {
      if (item.taskId) this.beginTask(item.taskId);
      else
        this.#teams.set(team.id, {
          ...team,
          members: team.members.map((row) =>
            row.id === member.id ? { ...row, status: "running" } : row,
          ),
        });
      this.#runs.set(run.id, { ...run, dispatchCount: run.dispatchCount + 1 });
      this.#dispatches.set(id, { ...item, status: "running", notBefore: null });
      this.#event(team.id, "dispatch.updated", id);
      this.#save();
      return {
        taskId: id,
        runId: run.id,
        ...(item.taskId ? { logicalTaskId: item.taskId } : {}),
        teamId: team.id,
        memberId: member.id,
        sessionId: member.sessionId!,
        name: `${team.name} · ${member.name}`,
        engine: member.engine,
        acpCatalogId: member.acpCatalogId,
        presetId: member.presetId,
        workspaceId: team.workspaceId,
        input: item.input,
        executionContext: `你是持久 AI 团队「${team.name}」的${member.role === "lead" ? "组长" : "成员"}「${member.name}」。使用协作工具查询成员和任务、分工、消息与依赖。仅组长可招募；原生子 agent 不会成为持久成员。收到成员结果后组长检查并总结。避免互相发送无新内容的确认。\n团队目标：${run.input}\n\n`,
        onSubmitted: (turnId) => this.submittedDispatch(id, turnId),
      };
    });
  }
  submittedDispatch(id: string, turnId: string): void {
    const item = this.#dispatches.get(id)!;
    if (item.status !== "running") return;
    this.#dispatches.set(id, { ...item, turnId, submittedAt: this.#now() });
    for (const messageId of item.messageIds) {
      const message = this.#messages.get(messageId)!;
      this.#messages.set(messageId, { ...message, readAt: this.#now() });
    }
    this.#save();
  }
  deferDispatch(id: string): void {
    const item = this.#dispatches.get(id)!;
    if (item.status !== "running" || item.submittedAt) return;
    this.#dispatches.set(id, {
      ...item,
      status: "queued",
      notBefore: new Date(this.#clock.now().getTime() + 1000).toISOString(),
    });
    const run = this.#runs.get(item.runId)!;
    this.#runs.set(run.id, {
      ...run,
      dispatchCount: Math.max(0, run.dispatchCount - 1),
    });
    if (item.taskId) {
      const task = this.#requiredTask(item.taskId);
      this.#tasks.set(task.id, { ...task, status: "queued", startedAt: null });
    }
    this.#idleMember(item.teamId, item.memberId, false);
    this.#save();
  }
  finishDispatch(
    id: string,
    result: { sessionId: string; result?: string } | { error: string },
  ): void {
    if (!this.#batch)
      return this.#transaction(() => this.finishDispatch(id, result));
    const item = this.#dispatches.get(id)!;
    if (item.status !== "running") return;
    const failed = "error" in result;
    this.#dispatches.set(id, {
      ...item,
      status: failed ? "failed" : "succeeded",
      result: failed ? null : (result.result ?? null),
      error: failed ? result.error : null,
      finishedAt: this.#now(),
    });
    if (item.taskId && this.#requiredTask(item.taskId).status === "running")
      this.finishTask(
        item.taskId,
        failed
          ? { status: "failed", error: result.error }
          : { status: "succeeded", ...result },
      );
    else this.#idleMember(item.teamId, item.memberId, failed);
    const run = this.#runs.get(item.runId)!;
    if (!["cancelled", "interrupted", "completed"].includes(run.status)) {
      const team = this.#requiredTeam(item.teamId);
      const lead = team.members.find((member) => member.role === "lead")!;
      if (lead.id !== item.memberId)
        this.sendMessage(
          team.id,
          {
            fromMemberId: item.memberId,
            toMemberId: lead.id,
            body: `成员回合 ${id} ${failed ? "失败" : "完成"}：\n${failed ? result.error : (result.result ?? "已完成，请检查成果。")}`,
          },
          id,
        );
      else if (
        !this.dispatches(run.id).some((row) =>
          ["queued", "running"].includes(row.status),
        )
      )
        this.#runs.set(run.id, {
          ...run,
          status: failed ? "interrupted" : "completed",
          reason: failed ? result.error : null,
          result: failed ? null : (result.result ?? null),
          updatedAt: this.#now(),
        });
    }
    this.#event(item.teamId, "dispatch.updated", id);
    this.#event(item.teamId, "run.updated", run.id);
    this.#save();
  }
  #ensureRun(teamId: string, input: string): TeamRun {
    const active = this.runs(teamId).findLast(
      (run) => !["completed", "cancelled"].includes(run.status),
    );
    if (active) return active;
    const run = teamRunSchema.parse({
      id: `team-run-${randomUUID()}`,
      teamId,
      input,
      status: "running",
      segment: 1,
      dispatchCount: 0,
      recruitedCount: 0,
      reason: null,
      result: null,
      createdAt: this.#now(),
      updatedAt: this.#now(),
    });
    this.#runs.set(run.id, run);
    this.#event(teamId, "run.updated", run.id);
    return run;
  }
  #enqueue(
    run: TeamRun,
    memberId: string,
    input: string,
    parentId: string | null = null,
    taskId: string | null = null,
    messageIds: string[] = [],
  ): void {
    const depth = this.#registerEdge(run, memberId, parentId);
    const item = teamDispatchSchema.parse({
      id: `team-dispatch-${randomUUID()}`,
      teamId: run.teamId,
      runId: run.id,
      memberId,
      taskId,
      messageIds,
      input,
      parentId,
      depth,
      status: "queued",
      turnId: null,
      submittedAt: null,
      result: null,
      error: null,
      createdAt: this.#now(),
      finishedAt: null,
    });
    this.#dispatches.set(item.id, item);
    this.#event(run.teamId, "dispatch.updated", item.id);
  }
  #registerEdge(
    run: TeamRun,
    memberId: string,
    parentId: string | null,
  ): number {
    const parent = parentId ? this.#dispatches.get(parentId) : undefined;
    if (parent && (parent.runId !== run.id || parent.status === "cancelled"))
      throw new Error("team_dispatch_expired");
    if (["cancelled", "completed"].includes(run.status))
      throw new Error("team_run_finished");
    const targets = new Set(parent?.fanoutMemberIds ?? []);
    targets.add(memberId);
    const depth = parent ? parent.depth + 1 : 0;
    if (parent)
      this.#dispatches.set(parent.id, {
        ...parent,
        fanoutMemberIds: [...targets],
      });
    if (targets.size > 4 || depth > 8) {
      this.#runs.set(run.id, {
        ...this.#runs.get(run.id)!,
        status: "paused_limit",
        reason: targets.size > 4 ? "fanout_limit" : "depth_limit",
        updatedAt: this.#now(),
      });
      this.#event(run.teamId, "run.updated", run.id);
    }
    return depth;
  }
  #validateDependencies(teamId: string, ids: string[], taskId?: string): void {
    if (new Set(ids).size !== ids.length)
      throw new Error("invalid_task_dependencies");
    const visit = (id: string, seen: Set<string>) => {
      if (id === taskId) throw new Error("team_task_dependency_cycle");
      if (seen.has(id)) return;
      seen.add(id);
      const task = this.#requiredTask(id);
      if (task.teamId !== teamId)
        throw new Error("team_task_dependency_other_team");
      for (const dependency of task.dependsOnIds) visit(dependency, seen);
    };
    for (const id of ids) visit(id, new Set());
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
      name: `${team.name} 路 ${member.name}`,
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
    if (this.#batch) return;
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, teams: this.list(), tasks: [...this.#tasks.values()], messages: [...this.#messages.values()], events: this.#events, eventSequence: this.#sequence, quotaReconciledTaskIds: [...this.#quotaReconciledTaskIds].sort(), runs: [...this.#runs.values()], dispatches: [...this.#dispatches.values()], operations: [...this.#operations.values()] }, null, 2)}\n`,
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
  executionContext?: string | undefined;
  acpCatalogId?: string | undefined;
  logicalTaskId?: string;
  runId?: string;
  onSubmitted?: (turnId: string) => void;
};
export interface TeamRunnerPort {
  admitTeamTask?(request: TeamExecution): ExecutionAdmission;
  teamBillingModel?(
    request: TeamExecution,
    recovery?: boolean,
  ): Promise<string>;
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
  acpCatalogId?: string | undefined;
  modelId?: string;
  thinkingEffort?: string;
  permissionMode?: "read_only" | "workspace_write" | "full_access";
};
export interface TeamSessionPort {
  openTeamSession(request: TeamSessionRequest): Promise<void>;
}

export class TeamOrchestrator {
  #stopped = false;
  #stopping: Promise<void> | undefined;
  #work: Promise<void> = Promise.resolve();
  #executions = new Map<string, Promise<void>>();
  #notifications = new Set<Promise<unknown>>();
  #ticking = false;
  #recovered = false;
  #recovering: Promise<void> | undefined;
  #wake: (() => void) | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
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
  stop(timeoutMs = 5_000): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#stopped = true;
    clearTimeout(this.#retryTimer);
    this.#wake?.();
    const cancellations = [...this.#executions.keys()].map((id) =>
      Promise.resolve().then(() => this.runner.cancelTeamTask?.(id)),
    );
    const drain = Promise.allSettled([
      this.#work,
      ...this.#executions.values(),
      ...cancellations,
    ]).then(() => Promise.allSettled([...this.#notifications]));
    this.#stopping = waitForShutdown(drain, timeoutMs);
    return this.#stopping;
  }

  tick(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#ticking) {
      this.#wake?.();
      return Promise.resolve();
    }
    this.#ticking = true;
    this.#work = this.#run().finally(() => {
      this.#wake = undefined;
      this.#ticking = false;
    });
    return this.#work;
  }

  async #run(): Promise<void> {
    await this.#recoverInterruptedTasks();
    while (!this.#stopped) {
      for (const queued of this.store.queuedDispatches()) {
        if (this.#stopped) break;
        let begun;
        try {
          begun = this.store.beginDispatch(queued.id);
        } catch {
          continue;
        }
        const execution = this.#execute(begun);
        this.#executions.set(queued.id, execution);
        void execution.then(
          () => this.#executions.delete(queued.id),
          () => this.#executions.delete(queued.id),
        );
      }
      if (this.#executions.size === 0) {
        this.store.pauseBlockedRuns();
        const next = this.store.nextWakeAt();
        if (next) {
          clearTimeout(this.#retryTimer);
          this.#retryTimer = setTimeout(
            () => void this.tick().catch(() => undefined),
            Math.max(1, new Date(next).getTime() - Date.now()),
          );
          this.#retryTimer.unref();
        }
        return;
      }
      const woke = new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      await Promise.race([...this.#executions.values(), woke]);
      this.#wake = undefined;
    }
  }

  async #recoverInterruptedTasks(): Promise<void> {
    if (this.#recovered) return;
    if (this.#recovering === undefined) {
      this.#recovering = (async () => {
        for (const request of this.store.interruptedExecutions()) {
          if (this.#stopped) return;
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

  async #execute(request: TeamExecution): Promise<void> {
    try {
      const result = await this.runner.executeTeamTask(request);
      this.store.finishDispatch(request.taskId, result);
    } catch (error) {
      if (error instanceof SessionBusyError)
        this.store.deferDispatch(request.taskId);
      else
        this.store.finishDispatch(request.taskId, {
          error: error instanceof Error ? error.message : "team_task_failed",
        });
    }
    if (request.logicalTaskId) {
      const task = this.store.task(request.logicalTaskId);
      if (task) this.#notifyTerminal(this.store.get(request.teamId)!, task);
    }
  }

  async controlRun(
    teamId: string,
    runId: string,
    action: "pause" | "resume" | "cancel",
  ) {
    const active = this.store
      .dispatches(runId)
      .filter((item) => item.status === "running");
    const run = this.store.controlRun(teamId, runId, action);
    if (action === "cancel")
      await Promise.allSettled(
        active.map((item) => this.runner.cancelTeamTask?.(item.id)),
      );
    if (action === "resume") void this.tick();
    this.#wake?.();
    return run;
  }

  // Delivers the terminal-state notification through the platform
  // Notifications module. Publish failures must never break the task, so the
  // promise is fire-and-forget.
  #notifyTerminal(team: Team, task: TeamTask): void {
    if (this.notifier === undefined) return;
    // A cancel can race execute; finishTask() then returns the cancelled task.
    if (task.status !== "succeeded" && task.status !== "failed") return;
    const notification = this.notifier
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
    this.#notifications.add(notification);
    void notification.finally(() => this.#notifications.delete(notification));
  }
  async cancel(teamId: string, taskId: string): Promise<TeamTask> {
    const active = this.store
      .dispatches()
      .filter((item) => item.taskId === taskId && item.status === "running");
    const task = this.store.cancelTask(teamId, taskId);
    try {
      await Promise.allSettled(
        active.map((item) => this.runner.cancelTeamTask?.(item.id)),
      );
    } finally {
      // The cancelled member is idle in the store even if the engine turn is
      // still settling, so wake the scheduling loop to claim queued work.
      this.#wake?.();
    }
    return task;
  }
}
