import { describe, expect, it } from "vitest";
import { afterEach, vi } from "vitest";
import { mcpService, toLegacyMcpServer } from "./ipcBridge.js";

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
});
