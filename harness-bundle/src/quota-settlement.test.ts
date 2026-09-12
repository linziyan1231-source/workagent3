import { mkdirSync, mkdtempSync, readFileSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonalQuotaSettlements } from "./quota-settlement.js";

const temporary = () =>
  mkdtempSync(join(tmpdir(), "workagent-personal-quota-recovery-"));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());

describe("personal quota completion journal", () => {
  it("durably discards a definitively rejected admission even when recovery is queued or already in flight", async () => {
    const home = temporary();
    const gate = deferred();
    const settle = vi.fn(() => gate.promise);
    const journal = new PersonalQuotaSettlements(home, {
      reserve: vi.fn(),
      settle,
    });
    const queued = journal.settle("rejected-before-recovery", 0);
    journal.discard("rejected-before-recovery");
    await queued;
    expect(settle).not.toHaveBeenCalled();
    const active = journal.settle("rejected-in-flight", 0);
    await Promise.resolve();
    expect(settle).toHaveBeenCalledWith({
      runId: "rejected-in-flight",
      actualUnits: 0,
    });
    journal.discard("rejected-in-flight");
    journal.discard("rejected-in-flight");
    gate.resolve();
    await active;
    const restarted = new PersonalQuotaSettlements(home, {
      reserve: vi.fn(),
      settle,
    });
    expect(restarted.get("rejected-before-recovery")).toBeUndefined();
    expect(restarted.get("rejected-in-flight")).toBeUndefined();
  });

  it("retains the discard target in memory when its deletion cannot be persisted", () => {
    const home = temporary();
    const journal = new PersonalQuotaSettlements(home, {
      reserve: vi.fn(),
      settle: vi.fn(),
    });
    journal.track("rejected", 0);
    const temporaryPath = join(
      home,
      "workagent",
      `personal-quota-settlements.json.${process.pid}.tmp`,
    );
    mkdirSync(temporaryPath);
    try {
      expect(() => journal.discard("rejected")).toThrow();
      expect(journal.get("rejected")).toBe(0);
      expect(
        new PersonalQuotaSettlements(home, {
          reserve: vi.fn(),
          settle: vi.fn(),
        }).get("rejected"),
      ).toBe(0);
    } finally {
      rmdirSync(temporaryPath);
    }
    journal.discard("rejected");
    expect(journal.get("rejected")).toBeUndefined();
  });
  it("recovers successful, failed and cancelled completions after response loss without changing their amounts", async () => {
    const home = temporary();
    const settle = vi.fn(async () => {
      throw new Error("response_lost");
    });
    const journal = new PersonalQuotaSettlements(home, {
      reserve: vi.fn(),
      settle,
    });
    for (const [id, units] of [
      ["success", 1234],
      ["failure", 0],
      ["cancelled", 0],
    ] as const)
      await expect(journal.settle(id, units)).rejects.toThrow("response_lost");
    journal.track("success", 0);
    expect(journal.get("success")).toBe(1234);
    const requests = vi.fn(async () => {});
    const restarted = new PersonalQuotaSettlements(home, {
      reserve: vi.fn(),
      settle: requests,
    });
    const stop = restarted.startRecovery();
    await vi.waitFor(() => expect(requests).toHaveBeenCalledTimes(3));
    await stop();
    expect(requests.mock.calls).toEqual([
      [{ runId: "success", actualUnits: 1234 }],
      [{ runId: "failure", actualUnits: 0 }],
      [{ runId: "cancelled", actualUnits: 0 }],
    ]);
    expect(
      new PersonalQuotaSettlements(home, {
        reserve: vi.fn(),
        settle: requests,
      }).get("success"),
    ).toBeUndefined();
  });

  it("persists before HTTP and deduplicates concurrent settlement with the first completed amount", async () => {
    const home = temporary();
    const gate = deferred();
    const settle = vi.fn(() => {
      expect(
        new PersonalQuotaSettlements(home, {
          reserve: vi.fn(),
          settle: vi.fn(),
        }).get("run"),
      ).toBe(1200);
      return gate.promise;
    });
    const journal = new PersonalQuotaSettlements(home, {
      reserve: vi.fn(),
      settle,
    });
    const first = journal.settle("run", 1200);
    expect(journal.settle("run", 0)).toBe(first);
    await Promise.resolve();
    expect(settle).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;
    expect(journal.get("run")).toBeUndefined();
  });

  it("retains a completion when cleanup cannot be saved and safely replays the successful HTTP settlement", async () => {
    const home = temporary();
    const gate = deferred();
    const settle = vi.fn(() => gate.promise);
    const journal = new PersonalQuotaSettlements(home, {
      reserve: vi.fn(),
      settle,
    });
    const work = journal.settle("run", 91);
    const temporaryPath = join(
      home,
      "workagent",
      `personal-quota-settlements.json.${process.pid}.tmp`,
    );
    mkdirSync(temporaryPath);
    gate.resolve();
    await expect(work).rejects.toThrow();
    expect(journal.get("run")).toBe(91);
    rmdirSync(temporaryPath);
    await journal.settle("run", 0);
    expect(settle).toHaveBeenNthCalledWith(2, {
      runId: "run",
      actualUnits: 91,
    });
    expect(journal.get("run")).toBeUndefined();
  });

  it("does not issue HTTP or commit in memory when the initial completion write fails", async () => {
    const home = temporary();
    const temporaryPath = join(
      home,
      "workagent",
      `personal-quota-settlements.json.${process.pid}.tmp`,
    );
    mkdirSync(temporaryPath, { recursive: true });
    const settle = vi.fn();
    const journal = new PersonalQuotaSettlements(home, {
      reserve: vi.fn(),
      settle,
    });
    await expect(journal.settle("run", 90)).rejects.toThrow();
    expect(journal.get("run")).toBeUndefined();
    expect(settle).not.toHaveBeenCalled();
    rmdirSync(temporaryPath);
  });

  it("stops new retries while draining the current request and keeps remaining completions for restart", async () => {
    vi.useFakeTimers();
    const home = temporary();
    const gate = deferred();
    const settle = vi.fn(() => gate.promise);
    const journal = new PersonalQuotaSettlements(home, {
      reserve: vi.fn(),
      settle,
    });
    journal.track("first", 20);
    journal.track("second", 40);
    const stop = journal.startRecovery();
    await Promise.resolve();
    const stopping = stop();
    expect(stop()).toBe(stopping);
    gate.resolve();
    await stopping;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(journal.get("second")).toBe(40);
    const rows = JSON.parse(
      readFileSync(
        join(home, "workagent", "personal-quota-settlements.json"),
        "utf8",
      ),
    );
    expect(rows.entries).toEqual([{ runId: "second", actualUnits: 40 }]);
  });

  it("bounds a hung request during shutdown and preserves its amount", async () => {
    vi.useFakeTimers();
    const home = temporary();
    const journal = new PersonalQuotaSettlements(home, {
      reserve: vi.fn(),
      settle: vi.fn(() => new Promise<void>(() => {})),
    });
    journal.track("hung", 30);
    const stop = journal.startRecovery();
    const stopping = stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopping;
    expect(vi.getTimerCount()).toBe(0);
    expect(
      new PersonalQuotaSettlements(home, {
        reserve: vi.fn(),
        settle: vi.fn(),
      }).get("hung"),
    ).toBe(30);
  });
});
