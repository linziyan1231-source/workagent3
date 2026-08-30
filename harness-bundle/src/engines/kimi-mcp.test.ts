import { describe, expect, it } from "vitest";
import { projectMcpServers } from "./kimi.js";

describe("Kimi MCP projection", () => {
  it("projects the shared catalog into native ACP session configuration", () => {
    expect(
      projectMcpServers([
        {
          server: {
            id: "mcp-1",
            name: "Reference",
            source: "user",
            enabled: true,
            transport: {
              kind: "sse",
              url: "https://example.com/events",
              headerCredentialIds: {},
            },
            toolPolicy: "all",
            allowedTools: [],
            oauthState: "none",
            health: "unknown",
            createdAt: "2026-08-30T10:00:00.000Z",
            updatedAt: "2026-08-30T10:00:00.000Z",
          },
          environment: {},
          headers: {},
          state: "ready",
        },
      ]),
    ).toEqual([
      {
        type: "sse",
        name: "Reference",
        url: "https://example.com/events",
        headers: [],
      },
    ]);
  });

  it("resolves SID-private credential references for ACP", () => {
    expect(
      projectMcpServers([
        {
          server: {
            id: "mcp-secret",
            name: "Protected",
            source: "user",
            enabled: true,
            transport: {
              kind: "http",
              url: "https://example.com/mcp",
              headerCredentialIds: { Authorization: "credential-1" },
            },
            toolPolicy: "none",
            allowedTools: [],
            oauthState: "ready",
            health: "unknown",
            createdAt: "2026-08-30T10:00:00.000Z",
            updatedAt: "2026-08-30T10:00:00.000Z",
          },
          environment: {},
          headers: { Authorization: "Bearer private" },
          state: "ready",
        },
      ]),
    ).toEqual([
      {
        type: "http",
        name: "Protected",
        url: "https://example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer private" }],
      },
    ]);
  });
});
