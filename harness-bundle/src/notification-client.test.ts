import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformNotificationClient } from "./notification-client.js";

const environment = {
  WORKAGENT_PLATFORM_URL: "http://127.0.0.1:8088",
  WORKAGENT_EMPLOYEE_SID: "S-1-5-21-test",
  WORKAGENT_PLATFORM_TOKEN: "runtime-registration-token",
};

afterEach(() => vi.unstubAllGlobals());

describe("PlatformNotificationClient", () => {
  it("is absent only when the platform connection is unconfigured", () => {
    expect(PlatformNotificationClient.fromEnvironment({})).toBeUndefined();
    expect(
      PlatformNotificationClient.fromEnvironment(environment),
    ).toBeInstanceOf(PlatformNotificationClient);
  });

  it("publishes to the loopback portal with the runtime credential", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const client = PlatformNotificationClient.fromEnvironment(environment)!;
    await client.publish({
      kind: "team",
      title: "Team task completed",
      message: 'Team "Launch" task "Draft" completed.',
      deepLink: "/team/team-1",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(
      "http://127.0.0.1:8088/internal/runtime/notifications",
    );
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer runtime-registration-token",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      sid: "S-1-5-21-test",
      kind: "team",
      title: "Team task completed",
      message: 'Team "Launch" task "Draft" completed.',
      deep_link: "/team/team-1",
    });
  });

  it("rejects on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 400 })),
    );
    const client = PlatformNotificationClient.fromEnvironment(environment)!;
    await expect(
      client.publish({ kind: "automation", title: "t", message: "m" }),
    ).rejects.toThrow("platform_notification_http_400");
  });
});
