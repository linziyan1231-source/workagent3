import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Team,
  TeamEvent,
  TeamMember,
  TeamTask,
} from "@workagent/contracts";
import { ApiError } from "../api/http.js";

const teamPort = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
  addMember: vi.fn(),
  updateMember: vi.fn(),
  removeMember: vi.fn(),
  tasks: vi.fn(),
  queueTask: vi.fn(),
  cancelTask: vi.fn(),
  messages: vi.fn(),
  sendMessage: vi.fn(),
  events: vi.fn(),
  eventsAll: vi.fn(),
  subscribe: vi.fn(),
  subscribeAll: vi.fn(),
  setSessionMode: vi.fn(),
}));
const presetPort = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../../features/team/teamPort.js", () => ({ teamPort }));
vi.mock("../../features/presets/presetPort.js", () => ({ presetPort }));

import { handleTeamEvent, teamBridge, toRendererTeam } from "./teamAdapter.js";

const member = (overrides: Partial<TeamMember> = {}): TeamMember => ({
  id: "member-1",
  name: "Lead",
  engine: "harness",
  presetId: "preset-1",
  role: "lead",
  status: "idle",
  sessionId: "session-member-1",
  createdAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

const team = (overrides: Partial<Team> = {}): Team => ({
  id: "team-1",
  version: 1,
  name: "Launch",
  workspaceId: "workspace-1",
  sessionMode: null,
  members: [member()],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

const task = (overrides: Partial<TeamTask> = {}): TeamTask => ({
  id: "team-task-1",
  teamId: "team-1",
  memberId: "member-1",
  title: "Review",
  input: "Review launch",
  status: "queued",
  sessionId: null,
  result: null,
  error: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

const teamEvent = (type: TeamEvent["type"], subjectId: string): TeamEvent => ({
  id: `event-${type}`,
  teamId: "team-1",
  sequence: 1,
  type,
  subjectId,
  occurredAt: "2026-09-01T00:00:00.000Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  presetPort.list.mockResolvedValue([
    { id: "preset-1", engine: "harness" },
    { id: "preset-2", engine: "codex" },
  ]);
});

describe("toRendererTeam", () => {
  it("maps members, lead and durable sessions onto the renderer contract", () => {
    const mapped = toRendererTeam(
      team({
        members: [
          member(),
          member({
            id: "member-2",
            name: "Reviewer",
            engine: "codex",
            presetId: "preset-2",
            role: "member",
            status: "running",
            sessionId: "session-member-2",
          }),
        ],
        sessionMode: "auto",
      }),
    );
    expect(mapped.id).toBe("team-1");
    expect(mapped.workspace).toBe("workspace-1");
    expect(mapped.workspace_mode).toBe("shared");
    expect(mapped.leader_assistant_id).toBe("member-1");
    expect(mapped.session_mode).toBe("auto");
    expect(mapped.created_at).toBe(Date.parse("2026-09-01T00:00:00.000Z"));
    expect(mapped.assistants).toEqual([
      {
        slot_id: "member-1",
        conversation_id: "session-member-1",
        role: "leader",
        assistant_backend: "aionrs",
        assistant_name: "Lead",
        status: "idle",
        assistant_id: "preset-1",
      },
      {
        slot_id: "member-2",
        conversation_id: "session-member-2",
        role: "teammate",
        assistant_backend: "codex",
        assistant_name: "Reviewer",
        status: "active",
        assistant_id: "preset-2",
      },
    ]);
    // Deprecated aliases mirror the primary fields for legacy renderer reads.
    expect(mapped.agents).toBe(mapped.assistants);
    expect(mapped.leader_agent_id).toBe("member-1");
  });

  it("omits session_mode when the backend has none", () => {
    expect(toRendererTeam(team())).not.toHaveProperty("session_mode");
  });
});

describe("teamBridge methods", () => {
  it("creates a team from renderer params via preset engine resolution", async () => {
    teamPort.create.mockResolvedValue(team());
    const result = await teamBridge.create.invoke({
      user_id: "user-1",
      name: "Launch",
      workspace: "workagent-workspace:workspace-1\\Launch",
      workspace_mode: "shared",
      assistants: [
        {
          role: "leader",
          assistant_name: "Lead",
          assistant_id: "preset-1",
          model: "default",
        },
      ],
    });
    expect(teamPort.create).toHaveBeenCalledWith({
      name: "Launch",
      workspaceId: "workspace-1",
      lead: { name: "Lead", engine: "harness", presetId: "preset-1" },
    });
    expect(result.id).toBe("team-1");
  });

  it("rejects creation without a leader assistant", async () => {
    await expect(
      teamBridge.create.invoke({
        user_id: "user-1",
        name: "Launch",
        workspace: "workspace-1",
        workspace_mode: "shared",
        assistants: [],
      }),
    ).rejects.toThrow("team_leader_required");
  });

  it("returns null for a deleted team and rethrows other failures", async () => {
    teamPort.get.mockRejectedValue(new ApiError(404, "team_not_found"));
    await expect(teamBridge.get.invoke({ id: "gone" })).resolves.toBeNull();
    teamPort.get.mockRejectedValue(new ApiError(500, "request_failed"));
    await expect(teamBridge.get.invoke({ id: "x" })).rejects.toThrow(
      "request_failed",
    );
  });

  it("renames through the versioned port contract", async () => {
    teamPort.get.mockResolvedValue(team({ version: 3 }));
    teamPort.rename.mockResolvedValue(team({ version: 4, name: "Renamed" }));
    await teamBridge.renameTeam.invoke({ id: "team-1", name: "Renamed" });
    expect(teamPort.rename).toHaveBeenCalledWith(
      team({ version: 3 }),
      "Renamed",
    );
  });

  it("maps the appended member back to a renderer assistant on addAgent", async () => {
    teamPort.addMember.mockResolvedValue(
      team({
        members: [
          member(),
          member({
            id: "member-2",
            name: "Reviewer",
            engine: "codex",
            role: "member",
          }),
        ],
      }),
    );
    const assistant = await teamBridge.addAgent.invoke({
      team_id: "team-1",
      assistant: {
        role: "teammate",
        assistant_name: "Reviewer",
        assistant_id: "preset-2",
      },
    });
    expect(teamPort.addMember).toHaveBeenCalledWith("team-1", {
      name: "Reviewer",
      engine: "codex",
      presetId: "preset-2",
    });
    expect(assistant).toMatchObject({
      slot_id: "member-2",
      role: "teammate",
      assistant_backend: "codex",
    });
  });

  it("queues lead tasks for team messages and acknowledges with the task id", async () => {
    teamPort.get.mockResolvedValue(team());
    teamPort.queueTask.mockResolvedValue(task());
    const ack = await teamBridge.sendMessage.invoke({
      team_id: "team-1",
      input: "Review the launch plan\nwith care",
      files: ["workspace/spec.md"],
    });
    expect(teamPort.queueTask).toHaveBeenCalledWith("team-1", {
      memberId: "member-1",
      title: "Review the launch plan",
      input:
        "Review the launch plan\nwith care\n\nWorkspace attachment paths:\n- workspace/spec.md",
    });
    expect(ack).toEqual({
      team_run_id: "team-task-1",
      team_id: "team-1",
      target_slot_id: "member-1",
      target_role: "lead",
      accepted_slot_id: "member-1",
      accepted_role: "lead",
      status: "accepted",
      message_id: "team-task-1",
    });
  });

  it("queues member tasks for direct agent messages", async () => {
    const reviewer = member({
      id: "member-2",
      role: "member",
      sessionId: "session-member-2",
    });
    teamPort.get.mockResolvedValue(team({ members: [member(), reviewer] }));
    teamPort.queueTask.mockResolvedValue(
      task({ id: "team-task-2", memberId: "member-2" }),
    );
    const ack = await teamBridge.sendMessageToAgent.invoke({
      team_id: "team-1",
      slot_id: "member-2",
      input: "Check risks",
    });
    expect(teamPort.queueTask).toHaveBeenCalledWith(
      "team-1",
      expect.objectContaining({ memberId: "member-2" }),
    );
    expect(ack.target_role).toBe("teammate");
    await expect(
      teamBridge.sendMessageToAgent.invoke({
        team_id: "team-1",
        slot_id: "missing",
        input: "hi",
      }),
    ).rejects.toThrow("team_member_not_found");
  });

  it("derives run state snapshots from real task data", async () => {
    teamPort.get.mockResolvedValue(team());
    teamPort.tasks.mockResolvedValue([]);
    await expect(
      teamBridge.getRunState.invoke({ team_id: "team-1" }),
    ).resolves.toEqual({ active_run: null });

    const running = task({
      status: "running",
      startedAt: "2026-09-01T00:00:00.000Z",
    });
    const queued = task({ id: "team-task-2", memberId: "member-2" });
    teamPort.tasks.mockResolvedValue([running, queued]);
    const snapshot = await teamBridge.getRunState.invoke({ team_id: "team-1" });
    expect(snapshot.active_run).toMatchObject({
      team_run_id: "team-task-1",
      target_slot_id: "member-1",
      status: "running",
      active_child_count: 1,
      pending_wake_count: 1,
    });
    expect(snapshot.active_run?.slot_work).toEqual([
      expect.objectContaining({
        slot_id: "member-1",
        active_turn_id: "team-task-1",
        pending_wake_count: 0,
      }),
      expect.objectContaining({ slot_id: "member-2", pending_wake_count: 1 }),
    ]);
  });

  it("cancels runs and slot work through task cancellation", async () => {
    teamPort.cancelTask.mockResolvedValue(task({ status: "cancelled" }));
    await teamBridge.cancelRun.invoke({
      team_id: "team-1",
      team_run_id: "team-task-1",
    });
    expect(teamPort.cancelTask).toHaveBeenCalledWith("team-1", "team-task-1");

    teamPort.tasks.mockResolvedValue([
      task({ id: "team-task-9", memberId: "member-2", status: "running" }),
    ]);
    await teamBridge.pauseSlotWork.invoke({
      team_id: "team-1",
      team_run_id: "team-task-1",
      slot_id: "member-2",
      reason: "user_stop",
    });
    expect(teamPort.cancelTask).toHaveBeenCalledWith("team-1", "team-task-9");

    teamPort.tasks.mockResolvedValue([]);
    await expect(
      teamBridge.cancelChildTurn.invoke({
        team_id: "team-1",
        team_run_id: "team-task-1",
        slot_id: "member-2",
      }),
    ).rejects.toThrow("team_slot_not_active");
  });

  it("stops every active task of the team", async () => {
    teamPort.tasks.mockResolvedValue([
      task({ id: "team-task-1", status: "running" }),
      task({ id: "team-task-2", status: "queued" }),
      task({ id: "team-task-3", status: "succeeded" }),
    ]);
    teamPort.cancelTask.mockResolvedValue(task({ status: "cancelled" }));
    await teamBridge.stop.invoke({ team_id: "team-1" });
    expect(teamPort.cancelTask.mock.calls).toEqual([
      ["team-1", "team-task-1"],
      ["team-1", "team-task-2"],
    ]);
  });

  it("validates the team on ensureSession and persists session mode", async () => {
    teamPort.get.mockResolvedValue(team({ version: 2 }));
    await teamBridge.ensureSession.invoke({ team_id: "team-1" });
    expect(teamPort.get).toHaveBeenCalledWith("team-1");

    teamPort.setSessionMode.mockResolvedValue(
      team({ version: 3, sessionMode: "auto" }),
    );
    await teamBridge.setSessionMode.invoke({
      team_id: "team-1",
      session_mode: "auto",
    });
    expect(teamPort.setSessionMode).toHaveBeenCalledWith(
      team({ version: 2 }),
      "auto",
    );
  });
});

describe("teamBridge SSE event translation", () => {
  it("translates team lifecycle events for list watchers", async () => {
    const created = vi.fn();
    const removed = vi.fn();
    const renamed = vi.fn();
    const listChanged = vi.fn();
    const offs = [
      teamBridge.created.on(created),
      teamBridge.removed.on(removed),
      teamBridge.renamed.on(renamed),
      teamBridge.listChanged.on(listChanged),
    ];
    teamPort.get.mockResolvedValue(team({ name: "Launch" }));

    await handleTeamEvent(teamEvent("team.created", "team-1"));
    expect(created).toHaveBeenCalledWith({
      team_id: "team-1",
      team_name: "Launch",
    });
    expect(listChanged).toHaveBeenCalledWith({
      team_id: "team-1",
      action: "created",
    });

    await handleTeamEvent(teamEvent("team.renamed", "team-1"));
    expect(renamed).toHaveBeenCalledWith({
      team_id: "team-1",
      team_name: "Launch",
    });

    await handleTeamEvent(teamEvent("team.removed", "team-1"));
    expect(removed).toHaveBeenCalledWith({ team_id: "team-1" });
    expect(listChanged).toHaveBeenCalledWith({
      team_id: "team-1",
      action: "removed",
    });
    for (const off of offs) off();
  });

  it("unsubscribes listeners through the returned function", async () => {
    const created = vi.fn();
    const off = teamBridge.created.on(created);
    teamPort.get.mockResolvedValue(team());
    await handleTeamEvent(teamEvent("team.created", "team-1"));
    off();
    await handleTeamEvent(teamEvent("team.created", "team-1"));
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("translates member lifecycle events with real member payloads", async () => {
    const spawned = vi.fn();
    const removedAgent = vi.fn();
    const renamedAgent = vi.fn();
    const offs = [
      teamBridge.agentSpawned.on(spawned),
      teamBridge.agentRemoved.on(removedAgent),
      teamBridge.agentRenamed.on(renamedAgent),
    ];
    teamPort.get.mockResolvedValue(team());

    await handleTeamEvent(teamEvent("member.added", "member-1"));
    expect(spawned).toHaveBeenCalledWith({
      team_id: "team-1",
      assistant: expect.objectContaining({
        slot_id: "member-1",
        conversation_id: "session-member-1",
        assistant_backend: "aionrs",
      }),
    });

    await handleTeamEvent(teamEvent("member.renamed", "member-1"));
    expect(renamedAgent).toHaveBeenCalledWith({
      team_id: "team-1",
      slot_id: "member-1",
      name: "Lead",
    });

    await handleTeamEvent(teamEvent("member.removed", "member-1"));
    expect(removedAgent).toHaveBeenCalledWith({
      team_id: "team-1",
      slot_id: "member-1",
    });
    for (const off of offs) off();
  });

  it("translates queued and started tasks into run and child-turn events", async () => {
    const accepted = vi.fn();
    const started = vi.fn();
    const childStarted = vi.fn();
    const statusChanged = vi.fn();
    const taskChanged = vi.fn();
    const offs = [
      teamBridge.runAccepted.on(accepted),
      teamBridge.runStarted.on(started),
      teamBridge.childTurnStarted.on(childStarted),
      teamBridge.agentStatusChanged.on(statusChanged),
      teamBridge.taskChanged.on(taskChanged),
    ];
    teamPort.get.mockResolvedValue(team());
    teamPort.tasks.mockResolvedValue([task()]);

    await handleTeamEvent(teamEvent("task.queued", "team-task-1"));
    expect(taskChanged).toHaveBeenCalledWith({
      team_id: "team-1",
      task_id: "team-task-1",
      action: "queued",
    });
    expect(accepted).toHaveBeenCalledWith(
      expect.objectContaining({
        team_run_id: "team-task-1",
        status: "accepted",
        pending_wake_count: 1,
      }),
    );

    teamPort.get.mockResolvedValue(
      team({ members: [member({ status: "running" })] }),
    );
    teamPort.tasks.mockResolvedValue([
      task({ status: "running", startedAt: "2026-09-01T00:00:00.000Z" }),
    ]);
    await handleTeamEvent(teamEvent("task.started", "team-task-1"));
    expect(childStarted).toHaveBeenCalledWith({
      team_id: "team-1",
      team_run_id: "team-task-1",
      slot_id: "member-1",
      role: "lead",
      conversation_id: "session-member-1",
      turn_id: "team-task-1",
      status: "running",
    });
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running", active_child_count: 1 }),
    );
    expect(statusChanged).toHaveBeenCalledWith({
      team_id: "team-1",
      slot_id: "member-1",
      status: "working",
    });
    for (const off of offs) off();
  });

  it("ends the run on the last terminal task and keeps it for parallel work", async () => {
    const completed = vi.fn();
    const failed = vi.fn();
    const cancelled = vi.fn();
    const updated = vi.fn();
    const childCompleted = vi.fn();
    const childCancelled = vi.fn();
    const offs = [
      teamBridge.runCompleted.on(completed),
      teamBridge.runFailed.on(failed),
      teamBridge.runCancelled.on(cancelled),
      teamBridge.runUpdated.on(updated),
      teamBridge.childTurnCompleted.on(childCompleted),
      teamBridge.childTurnCancelled.on(childCancelled),
    ];
    teamPort.get.mockResolvedValue(team());

    teamPort.tasks.mockResolvedValue([task({ status: "succeeded" })]);
    await handleTeamEvent(teamEvent("task.completed", "team-task-1"));
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({
        team_run_id: "team-task-1",
        status: "completed",
      }),
    );
    expect(childCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ slot_id: "member-1", status: "completed" }),
    );
    expect(updated).not.toHaveBeenCalled();

    // A second member still running: terminal event becomes a run update.
    teamPort.tasks.mockResolvedValue([
      task({ status: "succeeded" }),
      task({ id: "team-task-2", memberId: "member-2", status: "running" }),
    ]);
    await handleTeamEvent(teamEvent("task.completed", "team-task-1"));
    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({
        team_run_id: "team-task-2",
        status: "running",
      }),
    );
    expect(completed).toHaveBeenCalledTimes(1);

    teamPort.tasks.mockResolvedValue([task({ status: "failed", error: "x" })]);
    await handleTeamEvent(teamEvent("task.failed", "team-task-1"));
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
    expect(childCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );

    teamPort.tasks.mockResolvedValue([task({ status: "cancelled" })]);
    await handleTeamEvent(teamEvent("task.cancelled", "team-task-1"));
    expect(cancelled).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
    expect(childCancelled).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
    for (const off of offs) off();
  });

  it("translates mailbox delivery into teammate messages", async () => {
    const teammateMessage = vi.fn();
    const off = teamBridge.teammateMessage.on(teammateMessage);
    teamPort.get.mockResolvedValue(team());
    teamPort.messages.mockResolvedValue([
      {
        id: "mail-1",
        teamId: "team-1",
        fromMemberId: "member-1",
        toMemberId: null,
        body: "Plan is ready",
        createdAt: "2026-09-01T00:00:00.000Z",
        readAt: null,
      },
    ]);
    await handleTeamEvent(teamEvent("mail.received", "mail-1"));
    expect(teammateMessage).toHaveBeenCalledWith({
      conversation_id: "session-member-1",
      content: "Plan is ready",
      from_slot_id: "member-1",
      from_name: "Lead",
    });
    off();
  });

  it("nudges session watchers on generic team updates", async () => {
    const sessionChanged = vi.fn();
    const off = teamBridge.sessionChanged.on(sessionChanged);
    await handleTeamEvent(teamEvent("team.updated", "team-1"));
    expect(sessionChanged).toHaveBeenCalledWith({ team_id: "team-1" });
    off();
  });
});
