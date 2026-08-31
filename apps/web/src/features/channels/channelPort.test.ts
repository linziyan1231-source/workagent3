import { afterEach, expect, it, vi } from "vitest";
import { channelPort } from "./channelPort.js";

afterEach(() => vi.unstubAllGlobals());

it("maps the SID-scoped gateway contract to the formal Renderer channel model", async () => {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const path = String(input);
    const value = path.endsWith("/connectors")
      ? [
          {
            id: "weixin",
            display_name: "WeChat",
            configured: true,
            enabled: true,
            account_id: "bot-1",
            has_token: true,
            state: { running: true },
          },
        ]
      : [
          {
            id: 7,
            connector_id: "weixin",
            external_user_id: "wx-user",
            display_name: "Alice",
            status: "approved",
            created_at: "2026-08-31T02:00:00Z",
            updated_at: "2026-08-31T03:00:00Z",
          },
        ];
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  await expect(channelPort.statuses()).resolves.toEqual([
    expect.objectContaining({
      type: "weixin",
      connected: true,
      activeUsers: 1,
      botUsername: "bot-1",
      hasToken: true,
    }),
  ]);
  await expect(channelPort.authorized()).resolves.toEqual([
    expect.objectContaining({
      id: "7",
      platformType: "weixin",
      platformUserId: "wx-user",
    }),
  ]);
});
