import { describe, expect, it } from "vitest";
import { projectMcpServers } from "./kimi.js";

describe("Kimi MCP projection", () => {
  it("projects stdio with SID-resolved environment variables", () => {
    expect(
      projectMcpServers([
        {
          server: {
            id: "local",
            name: "Local tools",
            source: "managed",
            enabled: true,
            transport: {
              kind: "stdio",
              command: "C:\\managed\\server.exe",
              args: ["--stdio"],
              environmentCredentialIds: { TOKEN: "credential-1" },
            },
            toolPolicy: "all",
            allowedTools: [],
            oauthState: "none",
            health: "healthy",
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
          environment: { TOKEN: "private" },
          headers: {},
          state: "ready",
        },
      ]),
    ).toEqual([
      {
        name: "Local tools",
        command: "C:\\managed\\server.exe",
        args: ["--stdio"],
        env: [{ name: "TOKEN", value: "private" }],
      },
    ]);
  });

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
