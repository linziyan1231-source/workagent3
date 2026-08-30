import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpPort } from "./mcpPort.js";

const server = {
  id: "mcp-1",
  name: "Local tools",
  source: "user" as const,
  enabled: true,
  transport: {
    kind: "http" as const,
    url: "http://127.0.0.1:8123/mcp",
    headerCredentialIds: {},
  },
  toolPolicy: "all" as const,
  allowedTools: [],
  oauthState: "none" as const,
  health: "unknown" as const,
  createdAt: "2026-08-30T10:00:00+08:00",
  updatedAt: "2026-08-30T10:00:00+08:00",
};

afterEach(() => vi.unstubAllGlobals());

describe("MCP HTTP port", () => {
  it("loads the SID-private runtime catalog", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify([server]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(mcpPort.list()).resolves.toEqual([server]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/mcp-servers",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("encodes server ids for updates", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...server, enabled: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    await mcpPort.update("mcp/unsafe", { enabled: false });
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/mcp-servers/mcp%2Funsafe",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("runs the runtime-owned connection test", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            server: { ...server, health: "healthy" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(mcpPort.test("mcp/one")).resolves.toMatchObject({
      success: true,
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/mcp-servers/mcp%2Fone/test",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("routes OAuth start, completion, and logout through the runtime", async () => {
    const fetch = vi.fn(async (path: string, request?: RequestInit) => {
      if (String(path).endsWith("/oauth/start")) {
        expect(JSON.parse(String(request?.body))).toEqual({
          redirectUri: "http://127.0.0.1:8088/oauth/mcp/callback",
        });
        return new Response(
          JSON.stringify({
            authorizationUrl: "https://auth.example/authorize",
            flowId: "flow-1",
            state: "state-1",
            expiresAt: "2026-08-30T10:10:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(path).endsWith("/oauth/complete")) {
        expect(JSON.parse(String(request?.body))).toEqual({
          flowId: "flow-1",
          state: "state-1",
          code: "code-1",
        });
        return new Response(
          JSON.stringify({ ...server, oauthState: "ready" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      mcpPort.startOAuth("mcp/one", "http://127.0.0.1:8088/oauth/mcp/callback"),
    ).resolves.toMatchObject({ flowId: "flow-1" });
    await expect(
      mcpPort.completeOAuth("mcp/one", {
        flowId: "flow-1",
        state: "state-1",
        code: "code-1",
      }),
    ).resolves.toMatchObject({ oauthState: "ready" });
    await mcpPort.logoutOAuth("mcp/one");

    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "/api/runtime/v1/mcp-servers/mcp%2Fone/oauth",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
