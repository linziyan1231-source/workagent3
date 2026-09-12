import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationScheduler, AutomationStore } from "./automation-store.js";
import { TeamOrchestrator, TeamStore } from "./team-store.js";
import { createTeamHandler } from "./team-api.js";

const roots: string[] = [];
const temporary = () => {
  const value = mkdtempSync(join(tmpdir(), "workagent-shutdown-"));
  roots.push(value);
  return value;
};
afterEach(() => {
  vi.useRealTimers();
  for (const value of roots.splice(0)) rmSync(value, { recursive: true });
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const definition = {
  name: "Reminder",
  enabled: false,
  schedule: { kind: "interval" as const, everyMinutes: 5 },
  presetId: "builtin-general",
  engine: "harness" as const,
  workspaceId: "workspace-1",
  input: "Draft the report",
  notificationPolicy: "always" as const,
};

function fixture(kind: "scheduler" | "team", directory = temporary()) {
  const started = deferred<void>();
  const execution = deferred<{ sessionId: string }>();
  const notification = deferred<void>();
  const execute = vi.fn(() => {
    started.resolve();
    return execution.promise;
  });
  const cancel = vi.fn(async () => {});
  const publish = vi.fn(() => notification.promise);
  if (kind === "scheduler") {
    const store = new AutomationStore(directory);
    const first = store.create(definition);
    const second = store.create({ ...definition, name: "Other reminder" });
    const ids = [store.runNow(first.id).id, store.runNow(second.id).id];
    const worker = new AutomationScheduler(
      store,
      { execute, cancel },
      { publish },
    );
    return {
      directory,
      started,
      execution,
      notification,
      execute,
      cancel,
      publish,
      worker,
      ids,
      states: () =>
        ids.map(
          (id) =>
            store
              .list()
              .flatMap((row) => store.history(row.id))
              .find((row) => row.id === id)?.status,
        ),
      restart: async () => {
        const reopened = new AutomationStore(directory);
        const reconcile = vi.fn(async () => {});
        const resume = vi.fn(async () => ({ sessionId: "resumed" }));
        const next = new AutomationScheduler(reopened, {
          execute: resume,
          reconcileInterrupted: reconcile,
        });
        await next.tick();
        await next.stop();
        return {
          executed: resume.mock.calls.length,
          reconciled: reconcile.mock.calls.length,
        };
      },
    };
  }
  const store = new TeamStore(directory);
  const team = store.create({
    name: "Team",
    workspaceId: "workspace-1",
    lead: { name: "Lead", engine: "harness", presetId: "builtin-general" },
  });
  const ids = ["First", "Second"].map(
    (title) =>
      store.queueTask(team.id, {
        title,
        memberId: team.members[0]!.id,
        input: "Draft",
      }).id,
  );
  const worker = new TeamOrchestrator(
    store,
    { executeTeamTask: execute, cancelTeamTask: cancel },
    { publish },
  );
  return {
    directory,
    started,
    execution,
    notification,
    execute,
    cancel,
    publish,
    worker,
    ids,
    states: () =>
      ids.map(
        (id) => store.tasks(team.id).find((row) => row.id === id)?.status,
      ),
    restart: async () => {
      const reopened = new TeamStore(directory);
      const reconcile = vi.fn(async () => {});
      const resume = vi.fn(async () => ({ sessionId: "resumed" }));
      const next = new TeamOrchestrator(reopened, {
        executeTeamTask: resume,
        reconcileInterruptedTeamTask: reconcile,
      });
      await next.tick();
      await next.stop();
      return {
        executed: resume.mock.calls.length,
        reconciled: reconcile.mock.calls.length,
      };
    },
  };
}

describe.each(["scheduler", "team"] as const)("%s shutdown", (kind) => {
  it("stops once, drains execution and notification, and preserves queued work for restart", async () => {
    const f = fixture(kind);
    const work = f.worker.tick();
    await f.started.promise;
    const stopping = f.worker.stop();
    expect(f.worker.stop()).toBe(stopping);
    f.worker.start();
    await f.worker.tick();
    let closed = false;
    void stopping.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.cancel).toHaveBeenCalledWith(f.ids[0]);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(closed).toBe(false);
    f.execution.resolve({ sessionId: "finished" });
    await work;
    expect(f.publish).toHaveBeenCalledTimes(1);
    expect(closed).toBe(false);
    f.notification.resolve();
    await stopping;
    expect(f.states()).toEqual([
      "succeeded",
      kind === "team" ? "queued" : "pending",
    ]);
    expect(await f.restart()).toEqual({ executed: 1, reconciled: 0 });
  });

  it("bounds shutdown while an unresponsive run stays journaled for reconciliation", async () => {
    vi.useFakeTimers();
    const f = fixture(kind);
    f.worker.start();
    await f.started.promise;
    const stopping = f.worker.stop(50);
    await vi.advanceTimersByTimeAsync(50);
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
    expect(f.states()).toEqual([
      "running",
      kind === "team" ? "queued" : "pending",
    ]);
    expect(await f.restart()).toEqual({ executed: 1, reconciled: 1 });
    expect(f.execute).toHaveBeenCalledTimes(1);
    // The unresolved old process is intentionally never resumed after restart.
  });

  it("stops before startup without claiming work or installing timers", async () => {
    vi.useFakeTimers();
    const f = fixture(kind);
    await f.worker.stop();
    f.worker.start();
    await f.worker.tick();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(await f.restart()).toEqual({ executed: 2, reconciled: 0 });
  });
});

it("closes team event streams and removes their timer and request listener on disposal", async () => {
  vi.useFakeTimers();
  const store = new TeamStore(temporary());
  const worker = new TeamOrchestrator(store, {
    executeTeamTask: async () => ({ sessionId: "unused" }),
  });
  const lifecycle = new AbortController();
  const request = Object.assign(new EventEmitter(), {
    method: "GET",
    url: "/v1/teams/events",
    headers: { authorization: "Bearer fixture", accept: "text/event-stream" },
  }) as IncomingMessage;
  const response = { writeHead: vi.fn(), write: vi.fn(), end: vi.fn() };
  await createTeamHandler(
    "fixture",
    store,
    worker,
    { openTeamSession: async () => {} },
    lifecycle.signal,
  )(request, response as unknown as ServerResponse);
  expect(vi.getTimerCount()).toBe(1);
  expect(request.listenerCount("close")).toBe(1);
  lifecycle.abort();
  lifecycle.abort();
  request.emit("close");
  expect(response.end).toHaveBeenCalledTimes(1);
  expect(request.listenerCount("close")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
