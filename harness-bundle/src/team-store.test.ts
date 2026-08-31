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
});
