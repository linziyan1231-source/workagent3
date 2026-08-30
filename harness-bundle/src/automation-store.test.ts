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

  it("recovers an interrupted run as the same pending run", () => {
    const data = root();
    let now = new Date("2026-08-31T00:00:00.000Z");
    const clock = { now: () => now };
    const store = new AutomationStore(data, clock);
    store.create(mutation);
    now = new Date("2026-08-31T00:05:00.000Z");
    const run = store.begin(store.claimRunnable()[0]!.id);

    const reopened = new AutomationStore(data, clock);
    const recovered = reopened.claimRunnable()[0];
    expect(recovered?.id).toBe(run.id);
    expect(recovered?.status).toBe("pending");
    expect(recovered?.attempt).toBe(1);
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

  it("fails closed when the persisted document is invalid", () => {
    const data = root();
    const directory = join(data, "workagent");
    new AutomationStore(data).create(mutation);
    writeFileSync(join(directory, "automations.json"), "{}\n");
    expect(() => new AutomationStore(data)).toThrow();
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
