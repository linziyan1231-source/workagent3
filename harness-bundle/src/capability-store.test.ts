import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { McpCatalogStore } from "./capability-store.js";

describe("SID-private MCP catalog", () => {
  it("persists an explicit empty-tool policy without ambiguous semantics", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-mcp-"));
    const store = new McpCatalogStore(home);
    const server = store.create({
      name: "Local tools",
      source: "user",
      enabled: true,
      transport: {
        kind: "http",
        url: "http://127.0.0.1:8123/mcp",
        headerCredentialIds: {},
      },
      toolPolicy: "none",
      allowedTools: [],
      oauthState: "none",
    });
    expect(new McpCatalogStore(home).getServer(server.id)?.toolPolicy).toBe(
      "none",
    );
  });

  it("rejects insecure remote endpoints and ambiguous allowlists", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-mcp-"));
    const store = new McpCatalogStore(home);
    expect(() =>
      store.create({
        name: "Remote",
        source: "user",
        enabled: true,
        transport: {
          kind: "sse",
          url: "http://example.com/events",
          headerCredentialIds: {},
        },
        toolPolicy: "all",
        allowedTools: [],
        oauthState: "none",
      }),
    ).toThrow("mcp_endpoint_requires_https");
    expect(() =>
      store.create({
        name: "Empty list",
        source: "user",
        enabled: true,
        transport: {
          kind: "http",
          url: "https://example.com/mcp",
          headerCredentialIds: {},
        },
        toolPolicy: "allowlist",
        allowedTools: [],
        oauthState: "none",
      }),
    ).toThrow("allowlist requires at least one tool");
  });
});
