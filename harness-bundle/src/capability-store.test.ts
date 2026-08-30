import { describe, expect, it } from "vitest";
import { McpCatalogStore } from "./capability-store.js";

const server = {
  id: "mcp-1",
  name: "Reference",
  source: "user" as const,
  enabled: true,
  transport: {
    kind: "http" as const,
    url: "https://example.com/mcp",
    headerCredentialIds: { Authorization: "credential-1" },
  },
  toolPolicy: "all" as const,
  allowedTools: [],
  oauthState: "ready" as const,
  health: "healthy" as const,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

describe("UserHost-owned MCP projection", () => {
  it("keeps resolved credentials out of the public catalog", () => {
    const store = new McpCatalogStore();
    store.replace({
      servers: [
        {
          server,
          environment: {},
          headers: { Authorization: "private" },
          state: "ready",
        },
      ],
    });
    expect(store.getServer("mcp-1")).toEqual(server);
    expect(JSON.stringify(store.listServers())).not.toContain("private");
    expect(store.resolveServer("mcp-1")?.headers.Authorization).toBe("private");
  });

  it("replaces atomically and rejects mismatched credential keys", () => {
    const store = new McpCatalogStore();
    store.replace({ servers: [] });
    expect(() =>
      store.replace({
        servers: [{ server, environment: {}, headers: {}, state: "ready" }],
      }),
    ).toThrow("resolved MCP headers do not match credential references");
    expect(store.listServers()).toEqual([]);
  });
});
