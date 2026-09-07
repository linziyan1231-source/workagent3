import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ConversationQuota } from "./conversation-quota.js";
import type { AutomationQuotaPort } from "./quota-client.js";

const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "conversation-quota-"));
  const port = {
    reserve: vi.fn().mockResolvedValue({ status: "reserved" }),
    settle: vi.fn().mockResolvedValue(undefined),
  };
  return {
    home,
    port,
    quota: new ConversationQuota(home, port as AutomationQuotaPort),
  };
};

describe("conversation admission and recovery", () => {
  it("fails closed without quota and preserves the over-quota error", async () => {
    const { home, quota, port } = fixture();
    port.reserve.mockRejectedValue(new Error("quota_exceeded"));
    await expect(quota.begin("session", "gpt-test", "hello")).rejects.toThrow(
      "quota_exceeded",
    );
    expect(port.settle).toHaveBeenCalledOnce();
    await expect(
      new ConversationQuota(home, undefined).begin(
        "session",
        "gpt-test",
        "hello",
      ),
    ).rejects.toThrow("platform_quota_unconfigured");
  });

  it("releases each concurrent session and steer hold only with its terminal turn", async () => {
    const { quota, port } = fixture();
    const a = await quota.begin("a", "gpt-test", "hello");
    quota.started("a", "turn-a");
    const b = await quota.begin("b", "gpt-test", "hello");
    quota.started("b", "turn-b");
    const steer = await quota.begin("a", "gpt-test", "more", "turn-a");
    await quota.ended("a", "turn-a");
    expect(port.settle.mock.calls.map(([r]) => r.runId)).toEqual([a, steer]);
    await quota.ended("b", "turn-b");
    expect(port.settle).toHaveBeenLastCalledWith({ runId: b, actualUnits: 0 });
  });

  it("does not release the next Kimi prompt when steering cancels its predecessor", async () => {
    const { quota, port } = fixture();
    const old = await quota.begin("s", "kimi-test", "hello");
    quota.started("s", "old");
    const next = await quota.begin("s", "kimi-test", "revised");
    await quota.ended("s", "old");
    expect(port.settle).toHaveBeenCalledWith({ runId: old, actualUnits: 0 });
    expect(port.settle).not.toHaveBeenCalledWith({
      runId: next,
      actualUnits: 0,
    });
    quota.started("s", "next");
    await quota.ended("s", "next");
    expect(port.settle).toHaveBeenCalledWith({ runId: next, actualUnits: 0 });
  });

  it("recovers an interrupted reservation and retains failed settlements for restart", async () => {
    const { home, quota, port } = fixture();
    const runId = await quota.begin("s", "gpt-test", "hello");
    quota.started("s", "turn");
    port.settle.mockRejectedValueOnce(new Error("network down"));
    await expect(quota.ended("s", "turn")).rejects.toThrow("network down");
    expect(
      JSON.parse(
        readFileSync(join(home, "workagent/conversation-quota.json"), "utf8"),
      ),
    ).toHaveLength(1);
    const restarted = new ConversationQuota(home, port as AutomationQuotaPort);
    await restarted.ready;
    expect(port.settle).toHaveBeenLastCalledWith({ runId, actualUnits: 0 });
    expect(
      JSON.parse(
        readFileSync(join(home, "workagent/conversation-quota.json"), "utf8"),
      ),
    ).toEqual([]);
  });
});
