import { describe, expect, it } from "vitest";
import { toLegacyMcpServer } from "./ipcBridge.js";

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
});
