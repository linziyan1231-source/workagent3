import type {
  IAddTeamAssistantParams,
  ICreateTeamParams,
  TeamAssistantInput,
} from "@/common/adapter/teamMapper";
import type {
  ITeamAgentRemovedEvent,
  ITeamAgentRenamedEvent,
  ITeamAgentSpawnedEvent,
  ITeamAgentStatusEvent,
  ITeamChildTurnEvent,
  ITeamCreatedEvent,
  ITeamListChangedEvent,
  ITeamMcpStatusEvent,
  ITeamRemovedEvent,
  ITeamRenamedEvent,
  ITeamRunAck,
  ITeamRunEvent,
  ITeamRunStateResponse,
  ITeamSessionChangedEvent,
  ITeamSlotWork,
  ITeamTaskChangedEvent,
  ITeamTeammateMessageEvent,
  TeamAssistant,
  TeamRunStatus,
  TeamRunTargetRole,
  TeammateStatus,
  TTeam,
} from "@/common/types/team/teamTypes";
import type {
  EngineId,
  Team,
  TeamEvent,
  TeamMember,
  TeamTask,
} from "@workagent/contracts";
import { presetPort } from "../../features/presets/presetPort.js";
import { teamPort } from "../../features/team/teamPort.js";
import { ApiError } from "../api/http.js";
import { runtimeWorkspaceId } from "./common.js";

// ── Backend → Renderer contract translation ─────────────────────────────

const toTeammateStatus = (status: TeamMember["status"]): TeammateStatus =>
  status === "running" ? "active" : status === "error" ? "failed" : "idle";

/** Backend runtime status vocabulary expected by the formal Renderer. */
const toBackendStatus = (status: TeamMember["status"]): string =>
  status === "running" ? "working" : status === "error" ? "error" : "idle";

const toRunRole = (role: TeamMember["role"]): TeamRunTargetRole =>
  role === "lead" ? "lead" : "teammate";

export const toRendererTeamAssistant = (member: TeamMember): TeamAssistant => ({
  slot_id: member.id,
  conversation_id: member.sessionId ?? "",
  role: member.role === "lead" ? "leader" : "teammate",
  assistant_backend: member.engine === "harness" ? "aionrs" : member.engine,
  assistant_name: member.name,
  status: toTeammateStatus(member.status),
  assistant_id: member.presetId,
});

export const toRendererTeam = (team: Team): TTeam => {
  const assistants = team.members.map(toRendererTeamAssistant);
  const leadId =
    team.members.find((member) => member.role === "lead")?.id ?? "";
  return {
    id: team.id,
    user_id: "",
    name: team.name,
    workspace: team.workspaceId,
    workspace_mode: "shared",
    leader_assistant_id: leadId,
    assistants,
    leader_agent_id: leadId,
    agents: assistants,
    ...(team.sessionMode === null ? {} : { session_mode: team.sessionMode }),
    created_at: Date.parse(team.createdAt),
    updated_at: Date.parse(team.updatedAt),
  };
};

const memberRole = (team: Team, memberId: string): TeamRunTargetRole =>
  toRunRole(
    team.members.find((member) => member.id === memberId)?.role ?? "member",
  );

const isActiveTask = (task: TeamTask) =>
  task.status === "queued" || task.status === "running";

export const toRunEvent = (
  team: Team,
  tasks: TeamTask[],
  trigger: { task: TeamTask; status: TeamRunStatus },
): ITeamRunEvent => {
  const active = tasks.filter(isActiveTask);
  const runningByMember = new Map<string, TeamTask>();
  const queuedCountByMember = new Map<string, number>();
  for (const task of active) {
    if (task.status === "running") runningByMember.set(task.memberId, task);
    else
      queuedCountByMember.set(
        task.memberId,
        (queuedCountByMember.get(task.memberId) ?? 0) + 1,
      );
  }
  const slotIds = new Set([
    ...runningByMember.keys(),
    ...queuedCountByMember.keys(),
  ]);
  const slot_work: ITeamSlotWork[] = [...slotIds].map((slotId) => {
    const running = runningByMember.get(slotId);
    return {
      slot_id: slotId,
      role: memberRole(team, slotId),
      pending_wake_count: queuedCountByMember.get(slotId) ?? 0,
      starting_child_count: 0,
      ...(running === undefined
        ? {}
        : {
            active_turn_id: running.id,
            ...(running.startedAt === null
              ? {}
              : {
                  active_turn_started_at_ms: Date.parse(running.startedAt),
                  active_turn_elapsed_ms:
                    Date.now() - Date.parse(running.startedAt),
                }),
          }),
    };
  });
  let queuedTotal = 0;
  for (const count of queuedCountByMember.values()) queuedTotal += count;
  return {
    team_id: team.id,
    team_run_id: trigger.task.id,
    target_slot_id: trigger.task.memberId,
    target_role: memberRole(team, trigger.task.memberId),
    status: trigger.status,
    active_child_count: runningByMember.size,
    pending_wake_count: queuedTotal,
    starting_child_count: 0,
    slot_work,
  };
};

const toChildTurnEvent = (
  team: Team,
  task: TeamTask,
  status: TeamRunStatus,
): ITeamChildTurnEvent => ({
  team_id: team.id,
  team_run_id: task.id,
  slot_id: task.memberId,
  role: memberRole(team, task.memberId),
  conversation_id:
    team.members.find((member) => member.id === task.memberId)?.sessionId ?? "",
  turn_id: task.id,
  status,
});

// ── Event channels ──────────────────────────────────────────────────────

type ChannelMap = {
  agentStatusChanged: ITeamAgentStatusEvent;
  agentSpawned: ITeamAgentSpawnedEvent;
  agentRemoved: ITeamAgentRemovedEvent;
  agentRenamed: ITeamAgentRenamedEvent;
  listChanged: ITeamListChangedEvent;
  created: ITeamCreatedEvent;
  removed: ITeamRemovedEvent;
  renamed: ITeamRenamedEvent;
  teammateMessage: ITeamTeammateMessageEvent;
  mcpStatus: ITeamMcpStatusEvent;
  taskChanged: ITeamTaskChangedEvent;
  sessionChanged: ITeamSessionChangedEvent;
  runAccepted: ITeamRunEvent;
  runStarted: ITeamRunEvent;
  runUpdated: ITeamRunEvent;
  runCompleted: ITeamRunEvent;
  runCancelled: ITeamRunEvent;
  runFailed: ITeamRunEvent;
  childTurnStarted: ITeamChildTurnEvent;
  childTurnCompleted: ITeamChildTurnEvent;
  childTurnCancelled: ITeamChildTurnEvent;
};

const listeners: {
  [K in keyof ChannelMap]: Set<(event: ChannelMap[K]) => void>;
} = {
  agentStatusChanged: new Set(),
  agentSpawned: new Set(),
  agentRemoved: new Set(),
  agentRenamed: new Set(),
  listChanged: new Set(),
  created: new Set(),
  removed: new Set(),
  renamed: new Set(),
  teammateMessage: new Set(),
  mcpStatus: new Set(),
  taskChanged: new Set(),
  sessionChanged: new Set(),
  runAccepted: new Set(),
  runStarted: new Set(),
  runUpdated: new Set(),
  runCompleted: new Set(),
  runCancelled: new Set(),
  runFailed: new Set(),
  childTurnStarted: new Set(),
  childTurnCompleted: new Set(),
  childTurnCancelled: new Set(),
};

const emit = <K extends keyof ChannelMap>(
  channel: K,
  event: ChannelMap[K],
): void => {
  for (const listener of listeners[channel]) listener(event);
};

const on =
  <K extends keyof ChannelMap>(channel: K) =>
  (listener: (event: ChannelMap[K]) => void) => {
    listeners[channel].add(listener);
    ensureTeamEventSubscription();
    return () => listeners[channel].delete(listener);
  };

// ── SSE TeamEvent → Renderer event translation ──────────────────────────

const taskEventAction = (type: TeamEvent["type"]): string =>
  type.replace("task.", "");

const handleTaskEvent = async (event: TeamEvent): Promise<void> => {
  const [team, tasks] = await Promise.all([
    teamPort.get(event.teamId),
    teamPort.tasks(event.teamId),
  ]);
  const task = tasks.find((value) => value.id === event.subjectId);
  if (task === undefined) return;
  const member = team.members.find((value) => value.id === task.memberId);
  emit("taskChanged", {
    team_id: event.teamId,
    task_id: task.id,
    action: taskEventAction(event.type),
  });
  if (member !== undefined)
    emit("agentStatusChanged", {
      team_id: event.teamId,
      slot_id: member.id,
      status: toBackendStatus(member.status),
    });
  if (event.type === "task.queued") {
    emit("runAccepted", toRunEvent(team, tasks, { task, status: "accepted" }));
    return;
  }
  if (event.type === "task.started") {
    emit("childTurnStarted", toChildTurnEvent(team, task, "running"));
    emit("runStarted", toRunEvent(team, tasks, { task, status: "running" }));
    return;
  }
  if (event.type === "task.completed" || event.type === "task.failed") {
    const status = event.type === "task.completed" ? "completed" : "failed";
    emit("childTurnCompleted", toChildTurnEvent(team, task, status));
  } else {
    emit("childTurnCancelled", toChildTurnEvent(team, task, "cancelled"));
  }
  // A terminal task only ends the run view when nothing else is active;
  // parallel member work keeps the run alive as an update.
  const remaining = tasks.filter(
    (value) => value.id !== task.id && isActiveTask(value),
  );
  if (remaining.length > 0) {
    const primary =
      remaining.find((value) => value.status === "running") ?? remaining[0]!;
    emit(
      "runUpdated",
      toRunEvent(team, tasks, { task: primary, status: "running" }),
    );
    return;
  }
  const terminalStatus: TeamRunStatus =
    event.type === "task.completed"
      ? "completed"
      : event.type === "task.failed"
        ? "failed"
        : "cancelled";
  const terminal = toRunEvent(team, tasks, { task, status: terminalStatus });
  if (terminalStatus === "completed") emit("runCompleted", terminal);
  else if (terminalStatus === "failed") emit("runFailed", terminal);
  else emit("runCancelled", terminal);
};

export const handleTeamEvent = async (event: TeamEvent): Promise<void> => {
  switch (event.type) {
    case "team.created": {
      const team = await teamPort.get(event.teamId).catch(() => undefined);
      emit("created", { team_id: event.teamId, team_name: team?.name ?? "" });
      emit("listChanged", { team_id: event.teamId, action: "created" });
      return;
    }
    case "team.renamed": {
      const team = await teamPort.get(event.teamId).catch(() => undefined);
      emit("renamed", { team_id: event.teamId, team_name: team?.name ?? "" });
      emit("listChanged", { team_id: event.teamId, action: "renamed" });
      return;
    }
    case "team.removed":
      emit("removed", { team_id: event.teamId });
      emit("listChanged", { team_id: event.teamId, action: "removed" });
      return;
    case "member.added": {
      const team = await teamPort.get(event.teamId).catch(() => undefined);
      const member = team?.members.find(
        (value) => value.id === event.subjectId,
      );
      if (team !== undefined && member !== undefined)
        emit("agentSpawned", {
          team_id: event.teamId,
          assistant: toRendererTeamAssistant(member),
        });
      emit("listChanged", { team_id: event.teamId, action: "agent_added" });
      return;
    }
    case "member.removed":
      emit("agentRemoved", { team_id: event.teamId, slot_id: event.subjectId });
      emit("listChanged", { team_id: event.teamId, action: "agent_removed" });
      return;
    case "member.renamed": {
      const team = await teamPort.get(event.teamId).catch(() => undefined);
      const member = team?.members.find(
        (value) => value.id === event.subjectId,
      );
      if (member !== undefined)
        emit("agentRenamed", {
          team_id: event.teamId,
          slot_id: member.id,
          name: member.name,
        });
      return;
    }
    case "task.queued":
    case "task.started":
    case "task.completed":
    case "task.failed":
    case "task.cancelled":
      await handleTaskEvent(event);
      return;
    case "mail.received": {
      const [team, messages] = await Promise.all([
        teamPort.get(event.teamId),
        teamPort.messages(event.teamId),
      ]);
      const message = messages.find((value) => value.id === event.subjectId);
      if (message === undefined) return;
      const from =
        message.fromMemberId === null
          ? undefined
          : team.members.find((value) => value.id === message.fromMemberId);
      emit("teammateMessage", {
        conversation_id: from?.sessionId ?? "",
        content: message.body,
        from_slot_id: message.fromMemberId ?? "",
        from_name: from?.name ?? "",
      });
      return;
    }
    case "team.updated":
      emit("sessionChanged", { team_id: event.teamId });
      return;
  }
};

let teamEventSubscriptionStarted = false;
const ensureTeamEventSubscription = (): void => {
  if (
    teamEventSubscriptionStarted ||
    typeof globalThis.EventSource === "undefined"
  )
    return;
  teamEventSubscriptionStarted = true;
  void (async () => {
    try {
      // Skip the persisted history: only events sequenced after the current
      // tail are streamed into the live subscription.
      const after = (await teamPort.eventsAll()).reduce(
        (max, event) => Math.max(max, event.sequence),
        0,
      );
      teamPort.subscribeAll(after, (event) => {
        void handleTeamEvent(event);
      });
    } catch {
      teamEventSubscriptionStarted = false;
    }
  })();
};

// ── Invoke surface ──────────────────────────────────────────────────────

const resolveAssistantEngine = async (
  assistant: TeamAssistantInput,
): Promise<EngineId> => {
  const preset = (await presetPort.list()).find(
    (value) => value.id === assistant.assistant_id,
  );
  if (preset === undefined) throw new Error("team_assistant_not_found");
  return preset.engine;
};

const taskTitle = (input: string): string => {
  const title = input.trim().split("\n")[0]?.slice(0, 200) ?? "";
  return title === "" ? "Team task" : title;
};

const withFiles = (input: string, files?: string[]): string =>
  files === undefined || files.length === 0
    ? input
    : `${input}\n\nWorkspace attachment paths:\n${files.map((file) => `- ${file}`).join("\n")}`;

const queueAndAck = async (
  teamId: string,
  member: TeamMember,
  input: string,
  files?: string[],
): Promise<ITeamRunAck> => {
  const task = await teamPort.queueTask(teamId, {
    memberId: member.id,
    title: taskTitle(input),
    input: withFiles(input, files),
  });
  const role = toRunRole(member.role);
  return {
    team_run_id: task.id,
    team_id: teamId,
    target_slot_id: member.id,
    target_role: role,
    accepted_slot_id: member.id,
    accepted_role: role,
    status: "accepted",
    message_id: task.id,
  };
};

const activeTaskOfSlot = async (
  teamId: string,
  slotId: string,
): Promise<TeamTask | undefined> => {
  const tasks = await teamPort.tasks(teamId);
  return (
    tasks.find(
      (task) => task.memberId === slotId && task.status === "running",
    ) ??
    tasks.find((task) => task.memberId === slotId && task.status === "queued")
  );
};

export const teamBridge = {
  create: {
    invoke: async (params: ICreateTeamParams): Promise<TTeam> => {
      const lead =
        params.assistants.find((assistant) => assistant.role === "leader") ??
        params.assistants[0];
      if (lead?.assistant_id === undefined)
        throw new Error("team_leader_required");
      const engine = await resolveAssistantEngine(lead);
      return toRendererTeam(
        await teamPort.create({
          name: params.name,
          workspaceId: runtimeWorkspaceId(params.workspace),
          lead: {
            name: lead.assistant_name,
            engine,
            presetId: lead.assistant_id,
          },
        }),
      );
    },
  },
  list: {
    invoke: async (_params: { user_id: string }): Promise<TTeam[]> =>
      (await teamPort.list()).map(toRendererTeam),
  },
  get: {
    invoke: async ({ id }: { id: string }): Promise<TTeam | null> => {
      try {
        return toRendererTeam(await teamPort.get(id));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  },
  remove: {
    invoke: async ({ id }: { id: string }): Promise<void> =>
      teamPort.remove(id),
  },
  renameTeam: {
    invoke: async ({
      id,
      name,
    }: {
      id: string;
      name: string;
    }): Promise<void> => {
      await teamPort.rename(await teamPort.get(id), name);
    },
  },
  addAgent: {
    invoke: async ({
      team_id,
      assistant,
    }: IAddTeamAssistantParams): Promise<TeamAssistant> => {
      if (assistant.assistant_id === undefined)
        throw new Error("team_assistant_not_found");
      const engine = await resolveAssistantEngine(assistant);
      const team = await teamPort.addMember(team_id, {
        name: assistant.assistant_name,
        engine,
        presetId: assistant.assistant_id,
      });
      return toRendererTeamAssistant(team.members[team.members.length - 1]!);
    },
  },
  removeAgent: {
    invoke: async ({
      team_id,
      slot_id,
    }: {
      team_id: string;
      slot_id: string;
    }): Promise<void> => {
      await teamPort.removeMember(team_id, slot_id);
    },
  },
  renameAgent: {
    invoke: async ({
      team_id,
      slot_id,
      new_name,
    }: {
      team_id: string;
      slot_id: string;
      new_name: string;
    }): Promise<void> => {
      await teamPort.updateMember(team_id, slot_id, { name: new_name });
    },
  },
  sendMessage: {
    invoke: async ({
      team_id,
      input,
      files,
    }: {
      team_id: string;
      input: string;
      files?: string[];
    }): Promise<ITeamRunAck> => {
      const team = await teamPort.get(team_id);
      return queueAndAck(
        team_id,
        team.members.find((member) => member.role === "lead")!,
        input,
        files,
      );
    },
  },
  sendMessageToAgent: {
    invoke: async ({
      team_id,
      slot_id,
      input,
      files,
    }: {
      team_id: string;
      slot_id: string;
      input: string;
      files?: string[];
    }): Promise<ITeamRunAck> => {
      const team = await teamPort.get(team_id);
      const member = team.members.find((value) => value.id === slot_id);
      if (member === undefined) throw new Error("team_member_not_found");
      return queueAndAck(team_id, member, input, files);
    },
  },
  getRunState: {
    invoke: async ({
      team_id,
    }: {
      team_id: string;
    }): Promise<ITeamRunStateResponse> => {
      const [team, tasks] = await Promise.all([
        teamPort.get(team_id),
        teamPort.tasks(team_id),
      ]);
      const active = tasks.filter(isActiveTask);
      const primary =
        active.find((task) => task.status === "running") ?? active[0];
      if (primary === undefined) return { active_run: null };
      return {
        active_run: toRunEvent(team, tasks, {
          task: primary,
          status: active.some((task) => task.status === "running")
            ? "running"
            : "accepted",
        }),
      };
    },
  },
  cancelRun: {
    invoke: async ({
      team_id,
      team_run_id,
    }: {
      team_id: string;
      team_run_id: string;
      target_slot_id?: string;
      reason?: string;
    }): Promise<void> => {
      await teamPort.cancelTask(team_id, team_run_id);
    },
  },
  cancelChildTurn: {
    invoke: async ({
      team_id,
      slot_id,
    }: {
      team_id: string;
      team_run_id: string;
      slot_id: string;
      reason?: string;
    }): Promise<void> => {
      const task = await activeTaskOfSlot(team_id, slot_id);
      if (task === undefined) throw new Error("team_slot_not_active");
      await teamPort.cancelTask(team_id, task.id);
    },
  },
  pauseSlotWork: {
    invoke: async ({
      team_id,
      slot_id,
    }: {
      team_id: string;
      team_run_id: string;
      slot_id: string;
      reason?: string;
    }): Promise<void> => {
      const task = await activeTaskOfSlot(team_id, slot_id);
      if (task === undefined) throw new Error("team_slot_not_active");
      await teamPort.cancelTask(team_id, task.id);
    },
  },
  stop: {
    invoke: async ({ team_id }: { team_id: string }): Promise<void> => {
      for (const task of (await teamPort.tasks(team_id)).filter(isActiveTask))
        await teamPort.cancelTask(team_id, task.id);
    },
  },
  ensureSession: {
    invoke: async ({ team_id }: { team_id: string }): Promise<void> => {
      await teamPort.get(team_id);
    },
  },
  activeLease: { invoke: async () => undefined },
  setSessionMode: {
    invoke: async ({
      team_id,
      session_mode,
    }: {
      team_id: string;
      session_mode: string;
    }): Promise<void> => {
      await teamPort.setSessionMode(await teamPort.get(team_id), session_mode);
    },
  },
  agentStatusChanged: { on: on("agentStatusChanged") },
  agentSpawned: { on: on("agentSpawned") },
  agentRemoved: { on: on("agentRemoved") },
  agentRenamed: { on: on("agentRenamed") },
  listChanged: { on: on("listChanged") },
  created: { on: on("created") },
  removed: { on: on("removed") },
  renamed: { on: on("renamed") },
  teammateMessage: { on: on("teammateMessage") },
  mcpStatus: { on: on("mcpStatus") },
  taskChanged: { on: on("taskChanged") },
  sessionChanged: { on: on("sessionChanged") },
  runAccepted: { on: on("runAccepted") },
  runStarted: { on: on("runStarted") },
  runUpdated: { on: on("runUpdated") },
  runCompleted: { on: on("runCompleted") },
  runCancelled: { on: on("runCancelled") },
  runFailed: { on: on("runFailed") },
  childTurnStarted: { on: on("childTurnStarted") },
  childTurnCompleted: { on: on("childTurnCompleted") },
  childTurnCancelled: { on: on("childTurnCancelled") },
};
