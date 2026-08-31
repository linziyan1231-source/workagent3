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
