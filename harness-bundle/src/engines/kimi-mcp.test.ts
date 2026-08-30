import { describe, expect, it } from "vitest";
import { projectMcpServers } from "./kimi.js";

describe("Kimi MCP projection", () => {
  it("projects the shared catalog into native ACP session configuration", () => {
    expect(
      projectMcpServers([
        {
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

  it("fails closed until credential references can be consumed in the SID", () => {
    expect(() =>
      projectMcpServers([
        {
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
      ]),
    ).toThrow("mcp_credentials_unavailable:mcp-secret");
  });
});
