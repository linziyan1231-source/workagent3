import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AutomationScheduler,
  AutomationStore,
  nextScheduleTime,
} from "./automation-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

const root = () => {
  const value = mkdtempSync(join(tmpdir(), "workagent-automation-"));
  roots.push(value);
  return value;
};

const mutation = {
  name: "Daily brief",
  enabled: true,
  schedule: { kind: "interval" as const, everyMinutes: 5 },
  presetId: "builtin-general",
  engine: "harness" as const,
  workspaceId: "workspace-default",
  input: "Prepare the brief",
  notificationPolicy: "on_failure" as const,
};

describe("AutomationStore", () => {
  it("persists definitions and uses a stable scheduled run ID", () => {
    const data = root();
    let now = new Date("2026-08-31T00:00:00.000Z");
    const clock = { now: () => now };
    const store = new AutomationStore(data, clock);
    const definition = store.create(mutation);
    now = new Date("2026-08-31T00:05:00.000Z");
    const first = store.claimRunnable();
    const second = store.claimRunnable();
    expect(first).toHaveLength(1);
    expect(second.map((run) => run.id)).toEqual([first[0]?.id]);

    const reopened = new AutomationStore(data, clock);
    expect(reopened.get(definition.id)?.nextRunAt).toBe(
      "2026-08-31T00:10:00.000Z",
    );
    expect(reopened.claimRunnable()[0]?.id).toBe(first[0]?.id);
  });

  it("fails an interrupted run on restart without executing it twice", () => {
    const data = root();
    let now = new Date("2026-08-31T00:00:00.000Z");
    const clock = { now: () => now };
    const store = new AutomationStore(data, clock);
    store.create(mutation);
    now = new Date("2026-08-31T00:05:00.000Z");
    const run = store.begin(store.claimRunnable()[0]!.id);

    const reopened = new AutomationStore(data, clock);
    expect(reopened.claimRunnable()).toEqual([]);
    const recovered = reopened.history(run.automationId)[0];
    expect(recovered).toMatchObject({
      id: run.id,
      status: "failed",
      attempt: 1,
      error: "runtime_restarted",
    });
    expect(recovered?.finishedAt).not.toBeNull();
  });

  it("reconciles interrupted quota before executing pending work", async () => {
    const data = root();
    const store = new AutomationStore(data);
    const definition = store.create(mutation);
    const interrupted = store.runNow(definition.id);
    store.begin(interrupted.id);
    const pending = store.runNow(definition.id);
    const reopened = new AutomationStore(data);
    let releaseReconciliation!: () => void;
    const reconcileInterrupted = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseReconciliation = resolve;
        }),
    );
    const execute = vi.fn().mockResolvedValue({ sessionId: "pending-session" });
    const scheduler = new AutomationScheduler(reopened, {
      execute,
      reconcileInterrupted,
    });

    const tick = scheduler.tick();
    await vi.waitFor(() =>
      expect(reconcileInterrupted).toHaveBeenCalledWith(
        expect.objectContaining({ automationRunId: interrupted.id }),
      ),
    );
    expect(execute).not.toHaveBeenCalled();
    releaseReconciliation();
    await tick;

    expect(reopened.history(definition.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pending.id, status: "succeeded" }),
      ]),
    );
    expect(new AutomationStore(data).interruptedExecutions()).toEqual([]);
  });

  it("retries automation quota reconciliation before running pending work", async () => {
    const data = root();
    const store = new AutomationStore(data);
    const definition = store.create(mutation);
    const interrupted = store.runNow(definition.id);
    store.begin(interrupted.id);
    const pending = store.runNow(definition.id);
    const reopened = new AutomationStore(data);
    const reconcileInterrupted = vi
      .fn()
      .mockRejectedValueOnce(new Error("quota_unavailable"))
      .mockResolvedValueOnce(undefined);
    const execute = vi.fn().mockResolvedValue({ sessionId: "pending-session" });
    const scheduler = new AutomationScheduler(reopened, {
      execute,
      reconcileInterrupted,
    });

    await expect(scheduler.tick()).rejects.toThrow("quota_unavailable");
    expect(reopened.history(definition.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pending.id, status: "pending" }),
      ]),
    );
    await scheduler.tick();

    expect(reconcileInterrupted).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalled();
  });

  it("coalesces missed intervals into one run instead of replaying each miss", () => {
    const data = root();
    let now = new Date("2026-08-31T00:00:00.000Z");
    const store = new AutomationStore(data, { now: () => now });
    const definition = store.create(mutation);
    now = new Date("2026-08-31T00:20:00.000Z");
    expect(store.claimRunnable()).toHaveLength(1);
    expect(store.get(definition.id)?.nextRunAt).toBe(
      "2026-08-31T00:25:00.000Z",
    );
    expect(store.history(definition.id)).toHaveLength(1);
  });

  it("does not shift the next run when only metadata changes", () => {
    const data = root();
    let now = new Date("2026-08-31T00:00:00.000Z");
    const store = new AutomationStore(data, { now: () => now });
    const definition = store.create(mutation);
    now = new Date("2026-08-31T00:02:00.000Z");
    const updated = store.update(definition.id, 1, { name: "Renamed" });
    expect(updated.nextRunAt).toBe("2026-08-31T00:05:00.000Z");
  });

  it("keeps an immutable definition snapshot for an already queued run", () => {
    const data = root();
    const store = new AutomationStore(data, {
      now: () => new Date("2026-08-31T00:00:00.000Z"),
    });
    const definition = store.create(mutation);
    const run = store.runNow(definition.id);
    store.update(definition.id, 1, { input: "Changed later" });
    expect(run.definitionSnapshot.input).toBe("Prepare the brief");
    expect(store.claimRunnable()[0]?.definitionSnapshot.input).toBe(
      "Prepare the brief",
    );
  });

  it("fails closed when the persisted document is invalid", () => {
    const data = root();
    const directory = join(data, "workagent");
    new AutomationStore(data).create(mutation);
    writeFileSync(join(directory, "automations.json"), "{}\n");
    expect(() => new AutomationStore(data)).toThrow();
  });

  it("lets a cancellation win over a late finish in either outcome", () => {
    const data = root();
    const store = new AutomationStore(data);
    const definition = store.create(mutation);
    const run = store.begin(store.runNow(definition.id).id);
    store.cancel(definition.id, run.id);

    // finish() on a cancelled run is an idempotent no-op: the cancellation
    // stays, for both a late success and a late failure.
    const succeeded = store.finish(run.id, {
      status: "succeeded",
      sessionId: "session-late",
    });
    expect(succeeded.status).toBe("cancelled");
    const failed = store.finish(run.id, {
      status: "failed",
      error: "late_failure",
    });
    expect(failed.status).toBe("cancelled");
    expect(store.getRun(run.id)).toMatchObject({
      status: "cancelled",
      sessionId: null,
      result: null,
      error: null,
    });
  });

  it("rejects cancel and repeated finish once a run reached a terminal state", () => {
    const data = root();
    const store = new AutomationStore(data);
    const definition = store.create(mutation);
    const run = store.begin(store.runNow(definition.id).id);
    store.finish(run.id, { status: "succeeded", sessionId: "session-done" });

    // First completion wins: a later cancel or finish is refused.
    expect(() => store.cancel(definition.id, run.id)).toThrow(
      "automation_run_not_cancellable",
    );
    expect(() =>
      store.finish(run.id, { status: "succeeded", sessionId: "again" }),
    ).toThrow("automation_run_not_running");
    expect(store.getRun(run.id)?.status).toBe("succeeded");

    // Cancelling twice is refused as well.
    const other = store.begin(store.runNow(definition.id).id);
    store.cancel(definition.id, other.id);
    expect(() => store.cancel(definition.id, other.id)).toThrow(
      "automation_run_not_cancellable",
    );
    expect(store.getRun(other.id)?.status).toBe("cancelled");
  });
});

describe("AutomationScheduler", () => {
  it("records runner success and stable correlation ID", async () => {
    const data = root();
    let now = new Date("2026-08-31T00:00:00.000Z");
    const store = new AutomationStore(data, { now: () => now });
    const definition = store.create(mutation);
    now = new Date("2026-08-31T00:05:00.000Z");
    const execute = vi.fn(async ({ automationRunId }) => ({
      sessionId: `session-for-${automationRunId}`,
    }));
    await new AutomationScheduler(store, { execute }).tick();

    const run = store.history(definition.id)[0];
    expect(run?.status).toBe("succeeded");
    expect(run?.sessionId).toContain(run!.id);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ automationRunId: run?.id }),
    );
  });

  it("preserves cancellation when an in-flight runner returns later", async () => {
    const data = root();
    const store = new AutomationStore(data);
    const definition = store.create({ ...mutation, enabled: false });
    const pending = store.runNow(definition.id);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new AutomationScheduler(store, {
      execute: async () => {
        await waiting;
        return { sessionId: "session-late" };
      },
    });
    const ticking = scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await scheduler.cancel(definition.id, pending.id);
    release();
    await ticking;
    expect(store.getRun(pending.id)?.status).toBe("cancelled");
  });

  it("publishes terminal notifications according to notificationPolicy", async () => {
    const data = root();
    const store = new AutomationStore(data);
    const onFailure = store.create(mutation);
    const always = store.create({
      ...mutation,
      name: "Hourly sync",
      notificationPolicy: "always" as const,
    });
    const silent = store.create({
      ...mutation,
      name: "Quiet",
      notificationPolicy: "none" as const,
    });
    const publish = vi.fn().mockResolvedValue(undefined);
    const execute = vi.fn().mockResolvedValue({ sessionId: "session-1" });
    const scheduler = new AutomationScheduler(store, { execute }, { publish });

    store.runNow(onFailure.id);
    store.runNow(always.id);
    store.runNow(silent.id);
    await scheduler.tick();
    // on_failure skips a success, none stays silent, always publishes with the
    // run-history deep link.
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "automation",
        title: "Automation completed",
        deepLink: `/scheduled/${always.id}`,
      }),
    );

    execute.mockRejectedValueOnce(new Error("quota_exceeded"));
    store.runNow(onFailure.id);
    await scheduler.tick();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "automation",
        title: "Automation failed",
        message: expect.stringContaining("quota_exceeded"),
        deepLink: `/scheduled/${onFailure.id}`,
      }),
    );
  });

  it("keeps the run result when notification publishing fails", async () => {
    const data = root();
    const store = new AutomationStore(data);
    const definition = store.create({
      ...mutation,
      notificationPolicy: "always" as const,
    });
    const publish = vi.fn().mockRejectedValue(new Error("portal_down"));
    const scheduler = new AutomationScheduler(
      store,
      { execute: async () => ({ sessionId: "session-1" }) },
      { publish },
    );
    store.runNow(definition.id);
    await scheduler.tick();
    expect(store.history(definition.id)[0]?.status).toBe("succeeded");
  });

  it("keeps scheduling remaining runs when one run fails to finalize", async () => {
    const data = root();
    const store = new AutomationStore(data);
    const stuck = store.create({ ...mutation, name: "Stuck" });
    const healthy = store.create({ ...mutation, name: "Healthy" });
    const stuckRun = store.runNow(stuck.id);
    const healthyRun = store.runNow(healthy.id);
    const execute = vi.fn(
      async ({ automationRunId }: { automationRunId: string }) => {
        if (automationRunId === stuckRun.id) {
          // A double completion races the scheduler's own finish(), so both
          // finish attempts throw; the loop must still reach the next run.
          store.finish(stuckRun.id, {
            status: "succeeded",
            sessionId: "session-external",
          });
        }
        return { sessionId: `session-for-${automationRunId}` };
      },
    );
    await new AutomationScheduler(store, { execute }).tick();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(store.getRun(healthyRun.id)?.status).toBe("succeeded");
  });

  it("preserves cancellation when an in-flight runner fails later", async () => {
    const data = root();
    const store = new AutomationStore(data);
    const definition = store.create({ ...mutation, enabled: false });
    const pending = store.runNow(definition.id);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new AutomationScheduler(store, {
      execute: async () => {
        await waiting;
        throw new Error("runner_exploded");
      },
    });
    const ticking = scheduler.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await scheduler.cancel(definition.id, pending.id);
    release();
    await ticking;
    // The late failure loses to the cancellation.
    expect(store.getRun(pending.id)?.status).toBe("cancelled");
  });
});

it("calculates a weekly schedule in its declared timezone", () => {
  expect(
    nextScheduleTime(
      {
        kind: "weekly",
        daysOfWeek: [1],
        hour: 9,
        minute: 30,
        timezone: "Asia/Shanghai",
      },
      new Date("2026-08-30T23:00:00.000Z"),
    ).toISOString(),
  ).toBe("2026-08-31T01:30:00.000Z");
});

it("calculates an arbitrary cron schedule in its declared timezone", () => {
  expect(
    nextScheduleTime(
      {
        kind: "cron",
        expression: "15 9 * * MON-FRI",
        timezone: "Asia/Shanghai",
      },
      new Date("2026-08-30T23:00:00.000Z"),
    ).toISOString(),
  ).toBe("2026-08-31T01:15:00.000Z");
});
