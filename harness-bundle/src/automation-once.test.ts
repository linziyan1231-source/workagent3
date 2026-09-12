import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AutomationScheduler, AutomationStore } from "./automation-store.js";
import { SessionBusyError } from "./execution-admission.js";

const roots: string[] = [];
const definition = {
  name: "Once",
  enabled: true,
  schedule: { kind: "once" as const, at: "2026-09-13T09:00:00+08:00" },
  engine: "codex" as const,
  presetId: "builtin-codex",
  workspaceId: "default",
  input: "Prepare report",
  notificationPolicy: "none" as const,
};
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "workagent-once-"));
  roots.push(home);
  let now = new Date("2026-09-13T00:59:00Z");
  const clock = { now: () => now };
  return {
    home,
    clock,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    store: new AutomationStore(home, clock),
  };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("claims a once schedule atomically only once, including after downtime", () => {
  const { home, clock, advance, store } = fixture();
  const task = store.create(definition);
  advance(3600_000);
  const first = store.claimRunnable()[0]!;
  expect(store.get(task.id)).toMatchObject({ enabled: false, nextRunAt: null });
  expect(
    new AutomationStore(home, clock).claimRunnable().map((run) => run.id),
  ).toEqual([first.id]);
  store.begin(first.id);
  store.finish(first.id, { status: "succeeded", sessionId: "session" });
  expect(store.claimRunnable()).toEqual([]);
  expect(() =>
    store.update(task.id, store.get(task.id)!.version, { enabled: true }),
  ).toThrow("automation_once_time_in_past");
});

it("persists three busy retries and includes them in wakeups even after the once definition disables", async () => {
  const { home, clock, advance, store } = fixture();
  const task = store.create(definition);
  advance(60_000);
  const execute = vi.fn(async () => {
    throw new SessionBusyError("session-busy");
  });
  const scheduler = new AutomationScheduler(store, { execute });
  await scheduler.tick();
  expect(store.history(task.id)[0]).toMatchObject({
    status: "waiting",
    busyRetryCount: 1,
    attempt: 0,
    submittedAt: null,
  });
  expect(store.nextWakeAt()).toBe("2026-09-13T01:00:30.000Z");
  const reopened = new AutomationStore(home, clock);
  const resumed = new AutomationScheduler(reopened, { execute });
  await resumed.tick();
  expect(execute).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 3; i++) {
    advance(30_000);
    await resumed.tick();
  }
  expect(execute).toHaveBeenCalledTimes(4);
  expect(reopened.history(task.id)[0]).toMatchObject({
    status: "skipped_busy",
    busyRetryCount: 3,
    attempt: 0,
  });
  expect(reopened.nextWakeAt()).toBe(null);
  await scheduler.stop();
  await resumed.stop();
});

it("pause cancels unsent retries while preserving the original run snapshot", async () => {
  const { store, advance } = fixture();
  const task = store.create(definition);
  advance(60_000);
  const scheduler = new AutomationScheduler(store, {
    execute: async () => {
      throw new SessionBusyError("busy");
    },
  });
  await scheduler.tick();
  store.update(task.id, store.get(task.id)!.version, {
    input: "Changed future input",
    enabled: false,
  });
  expect(store.history(task.id)[0]).toMatchObject({
    status: "cancelled",
    definitionSnapshot: { input: "Prepare report" },
  });
  expect(store.nextWakeAt()).toBe(null);
  await scheduler.stop();
});

it("does not retry a submitted failure as busy", async () => {
  const { store, advance } = fixture();
  const task = store.create(definition);
  advance(60_000);
  const scheduler = new AutomationScheduler(store, {
    execute: async (request) => {
      request.onSubmitted?.("turn-1");
      throw new Error("provider_disconnected");
    },
  });
  await scheduler.tick();
  expect(store.history(task.id)[0]).toMatchObject({
    status: "failed",
    turnId: "turn-1",
    busyRetryCount: 0,
    error: "provider_disconnected",
  });
  await scheduler.stop();
});
