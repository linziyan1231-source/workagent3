import { describe, expect, it } from "vitest";
import { projectHarnessMcpServers } from "./harness-mcp.js";

describe("Harness MCP projection", () => {
  it("projects a resolved stdio server into a scoped DSH MCP plugin", () => {
    expect(
      projectHarnessMcpServers(
        [
          {
            server: {
              id: "local_tools",
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
              createdAt: "2026-08-31T00:00:00.000Z",
              updatedAt: "2026-08-31T00:00:00.000Z",
            },
            environment: { TOKEN: "private" },
            headers: {},
            state: "ready",
          },
        ],
        "C:\\workspace",
      ),
    ).toEqual([
      {
        transport: "stdio",
        serverName: "local_tools",
        command: "C:\\managed\\server.exe",
        args: ["--stdio"],
        env: { TOKEN: "private" },
        cwd: "C:\\workspace",
        toolCallTimeoutMs: 60_000,
        failOnStartupError: true,
      },
    ]);
  });

  it("fails explicitly for legacy SSE", () => {
    expect(() =>
      projectHarnessMcpServers(
        [
          {
            server: {
              id: "legacy",
              name: "Legacy",
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
              health: "healthy",
              createdAt: "2026-08-31T00:00:00.000Z",
              updatedAt: "2026-08-31T00:00:00.000Z",
            },
            environment: {},
            headers: {},
            state: "ready",
          },
        ],
        "C:\\workspace",
      ),
    ).toThrow("unsupported_mcp_transport:harness:sse:legacy");
  });
});
