import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TeamOrchestrator,
  TeamStore,
  type TeamRunnerPort,
} from "./team-store.js";

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(join(tmpdir(), "workagent-team-"));
  roots.push(value);
  return value;
};
afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

const createTeam = (store: TeamStore) =>
  store.create({
    name: "Launch",
    workspaceId: "workspace-1",
    lead: { name: "Lead", engine: "harness", presetId: "preset-lead" },
  });

describe("TeamStore", () => {
  it("persists team members, mailbox, tasks, and replay events", () => {
    const home = root();
    const store = new TeamStore(home);
    let team = createTeam(store);
    team = store.addMember(team.id, {
      name: "Reviewer",
      engine: "codex",
      presetId: "preset-review",
    });
    const reviewer = team.members[1]!;
    const mail = store.sendMessage(team.id, {
      fromMemberId: team.members[0]!.id,
      toMemberId: reviewer.id,
      body: "Review the plan",
    });
    const task = store.queueTask(team.id, {
      memberId: reviewer.id,
      title: "Review",
      input: "Find launch risks",
    });
    const reopened = new TeamStore(home);
    expect(reopened.get(team.id)?.members).toHaveLength(2);
    expect(reopened.messages(team.id, reviewer.id)[0]?.id).toBe(mail.id);
    expect(reopened.tasks(team.id)[0]?.id).toBe(task.id);
    expect(
      reopened.events(team.id, 1).every((event) => event.sequence > 1),
    ).toBe(true);
  });

  it("recovers running work deterministically after restart", () => {
    const home = root();
    const store = new TeamStore(home);
    const team = createTeam(store);
    const task = store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Draft",
      input: "Draft launch",
    });
    store.beginTask(task.id);
    const reopened = new TeamStore(home);
    expect(reopened.task(task.id)).toMatchObject({
      status: "failed",
      error: "runtime_restarted",
    });
    expect(reopened.get(team.id)?.members[0]?.status).toBe("idle");
  });

  it("reconciles interrupted quota before resuming queued work", async () => {
    const home = root();
    const store = new TeamStore(home);
    const team = createTeam(store);
    const interrupted = store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Interrupted",
      input: "Interrupted work",
    });
    store.beginTask(interrupted.id);
    const queued = store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Queued",
      input: "Queued work",
    });
    const reopened = new TeamStore(home);
    let releaseReconciliation!: () => void;
    const reconcileInterruptedTeamTask = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseReconciliation = resolve;
        }),
    );
    const executeTeamTask = vi
      .fn()
      .mockResolvedValue({ sessionId: "queued-session" });
    const orchestrator = new TeamOrchestrator(reopened, {
      executeTeamTask,
      reconcileInterruptedTeamTask,
    });

    const tick = orchestrator.tick();
    await vi.waitFor(() =>
      expect(reconcileInterruptedTeamTask).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: interrupted.id }),
      ),
    );
    expect(executeTeamTask).not.toHaveBeenCalled();
    releaseReconciliation();
    await tick;

    expect(reopened.task(queued.id)?.status).toBe("succeeded");
    expect(executeTeamTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: queued.id }),
    );
    expect(new TeamStore(home).interruptedExecutions()).toEqual([]);
  });

  it("retries interrupted quota reconciliation before releasing the queue", async () => {
    const home = root();
    const store = new TeamStore(home);
    const team = createTeam(store);
    const interrupted = store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Interrupted",
      input: "Interrupted work",
    });
    store.beginTask(interrupted.id);
    const queued = store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Queued",
      input: "Queued work",
    });
    const reopened = new TeamStore(home);
    const reconcileInterruptedTeamTask = vi
      .fn()
      .mockRejectedValueOnce(new Error("quota_unavailable"))
      .mockResolvedValueOnce(undefined);
    const executeTeamTask = vi
      .fn()
      .mockResolvedValue({ sessionId: "queued-session" });
    const orchestrator = new TeamOrchestrator(reopened, {
      executeTeamTask,
      reconcileInterruptedTeamTask,
    });

    await expect(orchestrator.tick()).rejects.toThrow("quota_unavailable");
    expect(reopened.task(queued.id)?.status).toBe("queued");
    expect(executeTeamTask).not.toHaveBeenCalled();
    await orchestrator.tick();

    expect(reconcileInterruptedTeamTask).toHaveBeenCalledTimes(2);
    expect(reopened.task(queued.id)?.status).toBe("succeeded");
  });

  it("resumes durable queued work when the orchestrator starts", async () => {
    const home = root();
    const store = new TeamStore(home);
    const team = createTeam(store);
    const task = store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Draft",
      input: "Draft launch",
    });
    const reopened = new TeamStore(home);
    const orchestrator = new TeamOrchestrator(reopened, {
      executeTeamTask: vi.fn().mockResolvedValue({
        sessionId: "recovered-session",
        result: "recovered",
      }),
    });

    orchestrator.start();
    await vi.waitFor(() =>
      expect(reopened.task(task.id)?.status).toBe("succeeded"),
    );
    expect(reopened.task(task.id)).toMatchObject({
      sessionId: "recovered-session",
      result: "recovered",
    });
  });

  it("runs tasks through the public engine runner and supports cancellation", async () => {
    const store = new TeamStore(root());
    const team = createTeam(store);
    const executeTeamTask = vi.fn(async () => ({
      sessionId: "session-1",
      result: "done",
    }));
    const runner: TeamRunnerPort = {
      executeTeamTask,
      cancelTeamTask: vi.fn(async () => undefined),
    };
    const orchestrator = new TeamOrchestrator(store, runner);
    const task = store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Draft",
      input: "Draft launch",
    });
    await orchestrator.tick();
    expect(executeTeamTask).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: "harness",
        presetId: "preset-lead",
        workspaceId: "workspace-1",
      }),
    );
    expect(store.task(task.id)).toMatchObject({
      status: "succeeded",
      sessionId: "session-1",
      result: "done",
    });
    const queued = store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Second",
      input: "Second task",
    });
    await orchestrator.cancel(team.id, queued.id);
    expect(store.task(queued.id)?.status).toBe("cancelled");
  });

  it("schedules the next queued task in the same tick after cancelling an in-flight task", async () => {
    const store = new TeamStore(root());
    const team = createTeam(store);
    const releases = new Map<
      string,
      (result: { sessionId: string; result?: string }) => void
    >();
    const executeTeamTask = vi.fn(
      (request: Parameters<TeamRunnerPort["executeTeamTask"]>[0]) =>
        new Promise<{ sessionId: string; result?: string }>((resolve) => {
          releases.set(request.taskId, resolve);
        }),
    );
    // The engine acknowledges the cancel but the in-flight execution settles
    // late; the scheduler must not stay blocked behind it.
    const cancelTeamTask = vi.fn(async () => undefined);
    const orchestrator = new TeamOrchestrator(store, {
      executeTeamTask,
      cancelTeamTask,
    });
    const first = store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Draft",
      input: "Draft launch",
    });
    const second = store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Revise",
      input: "Apply review",
    });
    const tick = orchestrator.tick();
    await vi.waitFor(() => expect(executeTeamTask).toHaveBeenCalledTimes(1));
    expect(store.task(first.id)?.status).toBe("running");
    expect(store.task(second.id)?.status).toBe("queued");

    await orchestrator.cancel(team.id, first.id);

    await vi.waitFor(() => expect(executeTeamTask).toHaveBeenCalledTimes(2));
    expect(cancelTeamTask).toHaveBeenCalledWith(first.id);
    expect(store.task(first.id)?.status).toBe("cancelled");
    expect(store.task(second.id)?.status).toBe("running");

    releases.get(second.id)?.({ sessionId: "session-2", result: "revised" });
    releases.get(first.id)?.({ sessionId: "session-1" });
    await tick;
    expect(store.task(first.id)?.status).toBe("cancelled");
    expect(store.task(second.id)?.status).toBe("succeeded");
  });

  it("dispatches a task queued after cancel while the cancelled execution is still unsettled", async () => {
    // Mirrors the HTTP route shape: the task route queues and then calls
    // void orchestrator.tick(). The cancelled engine turn may never settle,
    // so a tick that only short-circuits on #ticking would leave the loop
    // asleep behind the stale execution and the new task queued forever.
    const store = new TeamStore(root());
    const team = createTeam(store);
    const releases = new Map<
      string,
      (result: { sessionId: string; result?: string }) => void
    >();
    const executeTeamTask = vi.fn(
      (request: Parameters<TeamRunnerPort["executeTeamTask"]>[0]) =>
        new Promise<{ sessionId: string; result?: string }>((resolve) => {
          releases.set(request.taskId, resolve);
        }),
    );
    const cancelTeamTask = vi.fn(async () => undefined);
    const orchestrator = new TeamOrchestrator(store, {
      executeTeamTask,
      cancelTeamTask,
    });
    const first = store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Long",
      input: "Long running work",
    });
    const tick = orchestrator.tick();
    await vi.waitFor(() => expect(executeTeamTask).toHaveBeenCalledTimes(1));
    expect(store.task(first.id)?.status).toBe("running");

    await orchestrator.cancel(team.id, first.id);
    expect(store.task(first.id)?.status).toBe("cancelled");

    // Let a macrotask pass so the loop is definitely parked again behind the
    // still-unsettled first execution before the second task is queued —
    // this is the real HTTP timing, where the cancel and the next queue are
    // separate requests.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Marker",
      input: "Marker work",
    });
    void orchestrator.tick();

    await vi.waitFor(() => expect(executeTeamTask).toHaveBeenCalledTimes(2));
    expect(store.task(second.id)?.status).toBe("running");

    releases.get(second.id)?.({ sessionId: "session-2", result: "done" });
    releases.get(first.id)?.({ sessionId: "session-1" });
    await tick;
    expect(store.task(second.id)?.status).toBe("succeeded");
  });

  it("runs separate members in parallel and drains tasks queued while active", async () => {
    const store = new TeamStore(root());
    let team = createTeam(store);
    team = store.addMember(team.id, {
      name: "Reviewer",
      engine: "codex",
      presetId: "preset-review",
    });
    const releases = new Map<
      string,
      (result: { sessionId: string; result: string }) => void
    >();
    const executeTeamTask = vi.fn(
      (request: Parameters<TeamRunnerPort["executeTeamTask"]>[0]) =>
        new Promise<{ sessionId: string; result: string }>((resolve) => {
          releases.set(request.taskId, resolve);
        }),
    );
    const orchestrator = new TeamOrchestrator(store, { executeTeamTask });
    const leadTask = store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Draft",
      input: "Draft launch",
    });
    const reviewTask = store.queueTask(team.id, {
      memberId: team.members[1]!.id,
      title: "Review",
      input: "Review launch",
    });

    const tick = orchestrator.tick();
    await vi.waitFor(() => expect(executeTeamTask).toHaveBeenCalledTimes(2));
    expect(store.task(leadTask.id)?.status).toBe("running");
    expect(store.task(reviewTask.id)?.status).toBe("running");

    const followup = store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Revise",
      input: "Apply review",
    });
    await orchestrator.tick();
    releases.get(leadTask.id)?.({ sessionId: "lead-session", result: "draft" });
    releases.get(reviewTask.id)?.({
      sessionId: "review-session",
      result: "review",
    });
    await vi.waitFor(() => expect(executeTeamTask).toHaveBeenCalledTimes(3));
    releases.get(followup.id)?.({
      sessionId: "followup-session",
      result: "revised",
    });
    await tick;

    expect(store.tasks(team.id).map((task) => task.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(executeTeamTask.mock.calls[0]?.[0].engine).toBe("harness");
    expect(executeTeamTask.mock.calls[1]?.[0].engine).toBe("codex");
  });

  it("protects lead and active members from removal", () => {
    const store = new TeamStore(root());
    let team = createTeam(store);
    expect(() => store.removeMember(team.id, team.members[0]!.id)).toThrow(
      "team_lead_cannot_be_removed",
    );
    team = store.addMember(team.id, {
      name: "Worker",
      engine: "kimi",
      presetId: "preset-worker",
    });
    const task = store.queueTask(team.id, {
      memberId: team.members[1]!.id,
      title: "Work",
      input: "Do work",
    });
    expect(() => store.removeMember(team.id, team.members[1]!.id)).toThrow(
      "team_member_busy",
    );
    store.cancelTask(team.id, task.id);
    expect(
      store.removeMember(team.id, team.members[1]!.id).members,
    ).toHaveLength(1);
  });

  it("assigns a durable session id to every member", () => {
    const home = root();
    const store = new TeamStore(home);
    let team = createTeam(store);
    const lead = team.members[0]!;
    expect(lead.sessionId).toMatch(/^session-/);
    team = store.addMember(team.id, {
      name: "Reviewer",
      engine: "codex",
      presetId: "preset-review",
    });
    const reviewer = team.members[1]!;
    expect(reviewer.sessionId).toMatch(/^session-/);
    expect(reviewer.sessionId).not.toBe(lead.sessionId);
    const reopened = new TeamStore(home);
    expect(
      reopened.get(team.id)?.members.map((member) => member.sessionId),
    ).toEqual([lead.sessionId, reviewer.sessionId]);
  });

  it("emits explicit lifecycle events on a globally ordered stream", () => {
    const home = root();
    const store = new TeamStore(home);
    let team = createTeam(store);
    team = store.addMember(team.id, {
      name: "Reviewer",
      engine: "codex",
      presetId: "preset-review",
    });
    const reviewer = team.members[1]!;
    team = store.update(team.id, team.version, { name: "Launch v2" });
    store.updateMember(team.id, reviewer.id, { name: "Reviewer v2" });
    team = store.update(team.id, team.version + 1, { sessionMode: "auto" });
    expect(team.sessionMode).toBe("auto");

    const types = store.allEvents().map((event) => event.type);
    expect(types).toEqual([
      "team.created",
      "member.added",
      "team.renamed",
      "member.renamed",
      "team.updated",
    ]);
    const sequences = store.allEvents().map((event) => event.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);

    store.removeMember(team.id, reviewer.id);
    store.delete(team.id);
    // Deletion purges the team's history; only the removal marker remains so
    // global-stream consumers can observe it.
    expect(store.allEvents().map((event) => event.type)).toEqual([
      "team.removed",
    ]);
    expect(() => store.events(team.id)).toThrow("team_not_found");

    const reopened = new TeamStore(home);
    expect(reopened.allEvents().at(-1)?.type).toBe("team.removed");
    const afterDelete = reopened.allEvents().at(-1)!.sequence;
    reopened.create({
      name: "Next",
      workspaceId: "workspace-1",
      lead: { name: "Lead", engine: "kimi", presetId: "preset-lead" },
    });
    expect(reopened.allEvents().at(-1)!.sequence).toBeGreaterThan(afterDelete);
  });

  it("publishes terminal task notifications with the team history deep link", async () => {
    const home = root();
    const store = new TeamStore(home);
    const team = createTeam(store);
    const publish = vi.fn().mockResolvedValue(undefined);
    const executeTeamTask = vi
      .fn()
      .mockResolvedValue({ sessionId: "session-1", result: "done" });
    const orchestrator = new TeamOrchestrator(
      store,
      { executeTeamTask },
      { publish },
    );

    store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Draft",
      input: "Draft launch",
    });
    await orchestrator.tick();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "team",
        title: "Team task completed",
        deepLink: `/team/${team.id}`,
      }),
    );

    executeTeamTask.mockRejectedValueOnce(new Error("engine_crashed"));
    store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Risk",
      input: "Find risks",
    });
    await orchestrator.tick();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "team",
        title: "Team task failed",
        message: expect.stringContaining("engine_crashed"),
        deepLink: `/team/${team.id}`,
      }),
    );
  });

  it("keeps the task result when notification publishing fails", async () => {
    const home = root();
    const store = new TeamStore(home);
    const team = createTeam(store);
    const publish = vi.fn().mockRejectedValue(new Error("portal_down"));
    const orchestrator = new TeamOrchestrator(
      store,
      { executeTeamTask: async () => ({ sessionId: "session-1" }) },
      { publish },
    );
    const task = store.queueTask(team.id, {
      memberId: team.members[0]!.id,
      title: "Draft",
      input: "Draft launch",
    });
    await orchestrator.tick();
    expect(store.task(task.id)?.status).toBe("succeeded");
  });
});
