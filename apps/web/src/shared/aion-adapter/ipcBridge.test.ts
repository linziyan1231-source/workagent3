import { describe, expect, it } from "vitest";
import { afterEach, vi } from "vitest";
import {
  mcpService,
  toLegacyMcpServer,
  waitForMcpOAuthPopup,
} from "./ipcBridge.js";

afterEach(() => vi.unstubAllGlobals());

describe("production Renderer MCP adapter", () => {
  it("maps the runtime catalog without exposing credential references", () => {
    const legacy = toLegacyMcpServer({
      id: "mcp-1",
      name: "Search",
      source: "user",
      enabled: true,
      transport: {
        kind: "http",
        url: "https://example.com/mcp",
        headerCredentialIds: { Authorization: "credential-1" },
      },
      toolPolicy: "all",
      allowedTools: [],
      oauthState: "ready",
      health: "healthy",
      createdAt: "2026-08-30T10:00:00+08:00",
      updatedAt: "2026-08-30T10:00:00+08:00",
    });

    expect(legacy.transport).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: {},
    });
    expect(legacy.original_json).not.toContain("credential-1");
    expect(legacy.last_test_status).toBe("connected");
  });

  it("routes the original Renderer connection action through HTTP", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: "mcp_needs_auth",
              server: {
                id: "mcp-1",
                name: "Search",
                source: "user",
                enabled: true,
                transport: {
                  kind: "http",
                  url: "https://example.com/mcp",
                  headerCredentialIds: {},
                },
                toolPolicy: "all",
                allowedTools: [],
                oauthState: "needs_auth",
                health: "unavailable",
                createdAt: "2026-08-30T10:00:00+08:00",
                updatedAt: "2026-08-30T10:00:00+08:00",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const result = await mcpService.testMcpConnection.invoke({
      id: "mcp-1",
      name: "Search",
      enabled: true,
      transport: { type: "http", url: "https://example.com/mcp" },
      created_at: 1,
      updated_at: 1,
      builtin: false,
      original_json: "{}",
    });
    expect(result).toMatchObject({ success: false, needsAuth: true });
  });

  it("stores Renderer MCP headers in the credential broker first", async () => {
    const fetch = vi.fn(async (path: string, request?: RequestInit) => {
      if (path === "/api/runtime/v1/credentials")
        return new Response(
          JSON.stringify({
            id: "credential-1",
            kind: "mcp_header",
            state: "ready",
            label: "Search: Authorization",
            updatedAt: "2026-08-30T10:00:00Z",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      const mutation = JSON.parse(String(request?.body));
      expect(mutation.transport.headerCredentialIds).toEqual({
        Authorization: "credential-1",
      });
      expect(String(request?.body)).not.toContain("Bearer private");
      return new Response(
        JSON.stringify({
          id: "mcp-1",
          ...mutation,
          health: "unknown",
          createdAt: "2026-08-30T10:00:00Z",
          updatedAt: "2026-08-30T10:00:00Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetch);
    await mcpService.createServer.invoke({
      name: "Search",
      transport: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer private" },
      },
      original_json: "{}",
      builtin: false,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("accepts only the matching OAuth popup callback", async () => {
    const popup = { closed: false } as Window;
    const waiting = waitForMcpOAuthPopup(popup, "expected-state", 1000);
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: popup,
        data: {
          type: "workagent:mcp-oauth",
          state: "wrong-state",
          code: "wrong-code",
        },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: popup,
        data: {
          type: "workagent:mcp-oauth",
          state: "expected-state",
          code: "code-1",
          error: null,
        },
      }),
    );

    await expect(waiting).resolves.toMatchObject({ code: "code-1" });
  });
});
