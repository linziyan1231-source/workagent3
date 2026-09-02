import { afterEach, describe, expect, it, vi } from "vitest";
import { quotaPort } from "./quotaPort.js";

afterEach(() => vi.unstubAllGlobals());

describe("Quota HTTP port", () => {
  it("loads usage only for models granted to the session SID", async () => {
    const fetch = vi.fn(async (path: string) => {
      if (path === "/api/models")
        return new Response(
          JSON.stringify([
            {
              id: "codex-native",
              providerId: "codex",
              displayName: "Codex",
              aliases: [],
              contextWindow: 128000,
              inputPricePerMillion: null,
              outputPricePerMillion: null,
              health: "healthy",
              authorization: {
                modelId: "codex-native",
                authorized: true,
              },
            },
            {
              id: "kimi-native",
              providerId: "kimi",
              displayName: "Kimi",
              aliases: [],
              contextWindow: 128000,
              inputPricePerMillion: null,
              outputPricePerMillion: null,
              health: "healthy",
              authorization: {
                modelId: "kimi-native",
                authorized: false,
                reason: "not_granted",
              },
            },
          ]),
          { status: 200 },
        );
      return new Response(
        JSON.stringify({
          limitUnits: 100,
          consumedUnits: 25,
          reservedUnits: 5,
          period: "daily",
          periodKey: "2026-08-31",
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetch);

    const result = await quotaPort.list();
    expect(result).toHaveLength(1);
    expect(result[0]?.usage?.consumedUnits).toBe(25);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("represents an unconfigured budget without inventing a limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "quota_not_configured" }), {
            status: 404,
          }),
      ),
    );
    await expect(quotaPort.usage("codex-native")).resolves.toBeNull();
  });

  it("loads authoritative gateway usage and tolerates an unwired quota module", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              dailyPeriodKey: "2026-09-02",
              dailyTokens: 77,
              weeklyPeriodKey: "2026-W36",
              weeklyTokens: 130,
              models: [{ model: "gpt-5.6-sol", totalTokens: 77, requests: 2 }],
            }),
            { status: 200 },
          ),
      ),
    );
    const usage = await quotaPort.gatewayUsage();
    expect(usage?.dailyTokens).toBe(77);
    expect(usage?.models[0]?.requests).toBe(2);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "quota_unavailable" }), {
            status: 503,
          }),
      ),
    );
    await expect(quotaPort.gatewayUsage()).resolves.toBeNull();
  });
});
