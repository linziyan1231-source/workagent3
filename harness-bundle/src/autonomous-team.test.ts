import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  TeamOrchestrator,
  TeamStore,
  type TeamExecution,
} from "./team-store.js";

const roots: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "workagent-autonomous-team-"));
  roots.push(home);
  const store = new TeamStore(home);
  const team = store.create({
    name: "Review",
    workspaceId: "default",
    lead: { name: "Lead", engine: "codex", presetId: "builtin-codex" },
  });
  return { home, store, team };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("recruits, dispatches dependent tasks, wakes the lead and finishes with a summary", async () => {
  const { store, team } = fixture();
  const lead = team.members[0]!;
  const run = store.startRun(team.id, "Produce a reviewed plan");
  const calls: TeamExecution[] = [];
  const orchestrator = new TeamOrchestrator(store, {
    executeTeamTask: async (request) => {
      calls.push(request);
      request.onSubmitted?.(`turn-${request.taskId}`);
      if (calls.length === 1) {
        const updated = store.recruit(team.id, request.taskId, {
          name: "Reviewer",
          engine: "kimi",
          presetId: "builtin-kimi",
        });
        const worker = updated.members[1]!;
        const first = store.queueTask(
          team.id,
          { memberId: worker.id, title: "Read", input: "Read source" },
          request.taskId,
        );
        store.queueTask(
          team.id,
          {
            memberId: worker.id,
            title: "Review",
            input: "Review source",
            dependsOnIds: [first.id],
          },
          request.taskId,
        );
        return { sessionId: request.sessionId, result: "Assigned" };
      }
      return {
        sessionId: request.sessionId,
        result:
          request.memberId === lead.id ? "Reviewed plan" : "Evidence collected",
      };
    },
  });
  await orchestrator.tick();
  expect(store.tasks(team.id).map((task) => task.status)).toEqual([
    "succeeded",
    "succeeded",
  ]);
  expect(
    calls.every((request) => request.taskId.startsWith("team-dispatch-")),
  ).toBe(true);
  expect(new Set(calls.map((request) => request.taskId)).size).toBe(
    calls.length,
  );
  expect(store.runs(team.id).find((item) => item.id === run.id)).toMatchObject({
    status: "completed",
    result: "Reviewed plan",
  });
  expect(
    store.messages(team.id).every((message) => message.readAt !== null),
  ).toBe(true);
  await orchestrator.stop();
});

it("persists operation results and rejects conflicting retries without partial writes", () => {
  const { home, store, team } = fixture();
  const add = () =>
    store.addMember(team.id, {
      name: "Worker",
      engine: "kimi",
      presetId: "builtin-kimi",
    });
  const result = store.operation("add-worker", { name: "Worker" }, add);
  const reopened = new TeamStore(home);
  expect(
    reopened.operation("add-worker", { name: "Worker" }, () => {
      throw new Error("must not execute");
    }),
  ).toEqual(result);
  expect(() =>
    reopened.operation("add-worker", { name: "Other" }, add),
  ).toThrow("operation_id_conflict");
  expect(() =>
    reopened.operation("rollback", {}, () => {
      reopened.addMember(team.id, {
        name: "Temporary",
        engine: "codex",
        presetId: "x",
      });
      throw new Error("failed");
    }),
  ).toThrow("failed");
  expect(
    new TeamStore(home).get(team.id)?.members.map((member) => member.name),
  ).toEqual(["Lead", "Worker"]);
});

it("pauses an autonomous message loop and resumes only with a new budget segment", async () => {
  const { store, team } = fixture();
  const run = store.startRun(team.id, "Bound the work");
  const orchestrator = new TeamOrchestrator(store, {
    executeTeamTask: async (request) => {
      store.sendMessage(
        team.id,
        {
          fromMemberId: request.memberId,
          toMemberId: request.memberId,
          body: "More work",
        },
        request.taskId,
      );
      return { sessionId: request.sessionId };
    },
  });
  await orchestrator.tick();
  expect(store.runs(team.id)[0]).toMatchObject({
    status: "paused_limit",
    reason: "depth_limit",
    dispatchCount: 9,
  });
  expect(store.queuedDispatches()).toEqual([]);
  store.controlRun(team.id, run.id, "resume");
  expect(store.runs(team.id)[0]).toMatchObject({
    status: "running",
    segment: 2,
    dispatchCount: 0,
  });
  expect(store.queuedDispatches()[0]?.depth).toBe(0);
  await orchestrator.stop();
});

it("does not replay an ambiguous submitted dispatch after restart", async () => {
  const { store, home, team } = fixture();
  const run = store.startRun(team.id, "Write the report");
  const dispatch = store.queuedDispatches()[0]!;
  store.beginDispatch(dispatch.id);
  store.submittedDispatch(dispatch.id, "original-turn");
  store.sendMessage(team.id, {
    fromMemberId: null,
    toMemberId: team.members[0]!.id,
    body: "Pending followup",
  });
  const reopened = new TeamStore(home);
  const executeTeamTask = vi.fn(async (request: TeamExecution) => ({
    sessionId: request.sessionId,
    result: "Recovered",
  }));
  const reconcile = vi.fn(async () => {});
  const orchestrator = new TeamOrchestrator(reopened, {
    executeTeamTask,
    reconcileInterruptedTeamTask: reconcile,
  });
  await orchestrator.tick();
  expect(executeTeamTask).not.toHaveBeenCalled();
  expect(reconcile).toHaveBeenCalledWith(
    expect.objectContaining({ taskId: dispatch.id }),
  );
  expect(reopened.runs(team.id)[0]?.status).toBe("interrupted");
  await orchestrator.controlRun(team.id, run.id, "resume");
  await vi.waitFor(() => expect(executeTeamTask).toHaveBeenCalled());
  expect(
    executeTeamTask.mock.calls.every(
      ([request]) => request.taskId !== dispatch.id,
    ),
  ).toBe(true);
  await orchestrator.stop();
});

it("validates dependency cycles and leaves failed dependencies blocked", () => {
  const { store, team } = fixture();
  const first = store.queueTask(team.id, {
    memberId: team.members[0]!.id,
    title: "First",
    input: "First",
  });
  const second = store.queueTask(team.id, {
    memberId: team.members[0]!.id,
    title: "Second",
    input: "Second",
    dependsOnIds: [first.id],
  });
  expect(() =>
    store.updateTask(team.id, first.id, first.version, {
      dependsOnIds: [second.id],
    }),
  ).toThrow("team_task_dependency_cycle");
  store.beginTask(first.id);
  store.finishTask(first.id, { status: "failed", error: "needs_user" });
  expect(() => store.beginTask(second.id)).toThrow("team_task_blocked");
  expect(store.task(second.id)?.status).toBe("queued");
});

it("cancellation preserves completed work and prevents late results from waking the team", async () => {
  const { store, team } = fixture();
  const run = store.startRun(team.id, "Work");
  const dispatch = store.queuedDispatches()[0]!;
  store.beginDispatch(dispatch.id);
  store.controlRun(team.id, run.id, "cancel");
  store.finishDispatch(dispatch.id, {
    sessionId: team.members[0]!.sessionId!,
    result: "Late result",
  });
  expect(store.runs(team.id)[0]?.status).toBe("cancelled");
  expect(store.queuedDispatches()).toEqual([]);
  expect(store.messages(team.id)).toEqual([]);
});

it("counts fanout even when new messages merge into existing durable mailboxes", () => {
  const { store, home, team } = fixture();
  const run = store.startRun(team.id, "Coordinate existing inboxes");
  const parent = store.queuedDispatches()[0]!;
  store.beginDispatch(parent.id);
  for (let index = 0; index < 5; index++) {
    const updated = store.addMember(team.id, {
      name: `Worker ${index}`,
      engine: "codex",
      presetId: "builtin-codex",
    });
    const member = updated.members.at(-1)!;
    store.sendMessage(team.id, {
      fromMemberId: null,
      toMemberId: member.id,
      body: "Existing message",
    });
    store.sendMessage(
      team.id,
      {
        fromMemberId: parent.memberId,
        toMemberId: member.id,
        body: "Additional work",
      },
      parent.id,
    );
  }
  expect(store.runs(team.id)[0]).toMatchObject({
    status: "paused_limit",
    reason: "fanout_limit",
  });
  expect(
    store.dispatches(run.id).find((item) => item.id === parent.id)
      ?.fanoutMemberIds,
  ).toHaveLength(5);
  expect(
    store.dispatches(run.id).filter((item) => item.status === "queued"),
  ).toHaveLength(5);
  expect(
    new TeamStore(home)
      .dispatches(run.id)
      .filter((item) => item.messageIds.length === 2),
  ).toHaveLength(5);
});

it("pauses blocked dependency work and gives the lead a recovery turn on resume", async () => {
  const { store, team } = fixture();
  const first = store.queueTask(team.id, {
    memberId: team.members[0]!.id,
    title: "Read",
    input: "Read",
  });
  store.queueTask(team.id, {
    memberId: team.members[0]!.id,
    title: "Write",
    input: "Write",
    dependsOnIds: [first.id],
  });
  const orchestrator = new TeamOrchestrator(store, {
    executeTeamTask: async () => {
      throw new Error("missing_source");
    },
  });
  await orchestrator.tick();
  const run = store.runs(team.id)[0]!;
  expect(run).toMatchObject({ status: "paused", reason: "dependency_failed" });
  store.controlRun(team.id, run.id, "resume");
  expect(
    store
      .queuedDispatches()
      .some(
        (item) => item.taskId === null && item.input.includes("不要盲目重复"),
      ),
  ).toBe(true);
  await orchestrator.stop();
});

it("bounds recruitment and prevents deleting queued mailbox recipients", () => {
  const { store, team } = fixture();
  const run = store.startRun(team.id, "Recruit");
  const parent = store.queuedDispatches()[0]!;
  store.beginDispatch(parent.id);
  for (let index = 0; index < 8; index++)
    store.recruit(team.id, parent.id, {
      name: `Member ${index}`,
      engine: "codex",
      presetId: "builtin-codex",
    });
  expect(store.runs(team.id)[0]).toMatchObject({
    status: "paused_limit",
    reason: "recruit_limit",
    recruitedCount: 8,
  });
  const worker = store.get(team.id)!.members[1]!;
  store.sendMessage(team.id, {
    fromMemberId: null,
    toMemberId: worker.id,
    body: "Pending",
  });
  expect(() => store.removeMember(team.id, worker.id)).toThrow(
    "team_member_busy",
  );
  expect(() => store.delete(team.id)).toThrow("team_has_active_task");
  store.controlRun(team.id, run.id, "cancel");
  store.delete(team.id);
  expect(store.dispatches()).toEqual([]);
});
