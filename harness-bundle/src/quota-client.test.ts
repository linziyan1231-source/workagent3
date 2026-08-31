import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PlatformQuotaClient,
  platformQuotaConfiguration,
} from "./quota-client.js";

const environment = {
  WORKAGENT_PLATFORM_URL: "http://127.0.0.1:8088",
  WORKAGENT_EMPLOYEE_SID: "S-1-5-21-test",
  WORKAGENT_PLATFORM_TOKEN: "runtime-registration-token",
};

afterEach(() => vi.unstubAllGlobals());

describe("platform quota configuration", () => {
  it("is optional only when every scoped capability value is absent", () => {
    expect(platformQuotaConfiguration({})).toBeUndefined();
    expect(() =>
      platformQuotaConfiguration({
        WORKAGENT_PLATFORM_URL: environment.WORKAGENT_PLATFORM_URL,
      }),
    ).toThrow("platform_quota_configuration_incomplete");
  });

  it("rejects non-loopback and credential-bearing URLs", () => {
    expect(() =>
      platformQuotaConfiguration({
        ...environment,
        WORKAGENT_PLATFORM_URL: "https://portal.example.com",
      }),
    ).toThrow("platform_quota_configuration_invalid");
    expect(() =>
      platformQuotaConfiguration({
        ...environment,
        WORKAGENT_PLATFORM_URL: "http://user:password@127.0.0.1:8088",
      }),
    ).toThrow("platform_quota_configuration_invalid");
  });
});

describe("PlatformQuotaClient", () => {
  it("authenticates and injects the configured SID into reserve and settle", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            runId: "run-1",
            sid: environment.WORKAGENT_EMPLOYEE_SID,
            modelId: "harness-default",
            period: "daily",
            periodKey: "2026-08-31",
            reservedUnits: 1200,
            actualUnits: null,
            status: "reserved",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const client = PlatformQuotaClient.fromEnvironment(environment)!;

    await client.reserve({
      runId: "run-1",
      modelId: "harness-default",
      estimatedUnits: 1200,
    });
    await client.settle({ runId: "run-1", actualUnits: 1100 });

    const reserve = fetch.mock.calls[0]!;
    const settle = fetch.mock.calls[1]!;
    expect(String(reserve[0])).toBe(
      "http://127.0.0.1:8088/internal/runtime/quota/reserve",
    );
    expect((reserve[1] as RequestInit).headers).toMatchObject({
      authorization: `Bearer ${environment.WORKAGENT_PLATFORM_TOKEN}`,
    });
    expect(JSON.parse(String((reserve[1] as RequestInit).body))).toMatchObject({
      sid: environment.WORKAGENT_EMPLOYEE_SID,
      runId: "run-1",
    });
    expect(JSON.parse(String((settle[1] as RequestInit).body))).toMatchObject({
      sid: environment.WORKAGENT_EMPLOYEE_SID,
      actualUnits: 1100,
    });
  });

  it("propagates the stable platform error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "quota_exceeded" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = PlatformQuotaClient.fromEnvironment(environment)!;
    await expect(
      client.reserve({
        runId: "run-1",
        modelId: "harness-default",
        estimatedUnits: 1200,
      }),
    ).rejects.toThrow("quota_exceeded");
  });
});
