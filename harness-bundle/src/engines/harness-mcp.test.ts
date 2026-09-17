import { describe, expect, it, vi } from "vitest";
import { apply } from "@deepseek-ai/dsh-mcp-client";
import type { Context } from "@deepseek-ai/cordis";
import { projectHarnessMcpServers } from "./harness-mcp.js";

describe("Harness MCP projection", () => {
  it("finishes setup when an MCP process exits during initialization", async () => {
    const dispose: Array<() => unknown> = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = {
      root: {}, logger,
      effect: (start: () => (() => unknown)) => { dispose.push(start()); },
    } as unknown as Context;
    try {
      await expect(apply(ctx, {
        transport: "stdio", serverName: "broken", command: process.execPath,
        args: ["-e", "process.exit(1)"], env: {}, cwd: process.cwd(),
        failOnStartupError: false, toolCallTimeoutMs: 1000,
        reconnect: { enabled: false },
      })).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    } finally {
      for (const close of dispose.reverse()) await close();
    }
  });
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
        failOnStartupError: false,
      },
    ]);
  });

  it("projects Streamable HTTP with SID-resolved headers", () => {
    expect(
      projectHarnessMcpServers(
        [
          {
            server: {
              id: "remote_docs",
              name: "Remote docs",
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
              createdAt: "2026-09-01T00:00:00.000Z",
              updatedAt: "2026-09-01T00:00:00.000Z",
            },
            environment: {},
            headers: { Authorization: "Bearer private" },
            state: "ready",
          },
        ],
        "C:\\workspace",
      ),
    ).toEqual([
      {
        transport: "streamable-http",
        serverName: "remote_docs",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer private" },
        toolCallTimeoutMs: 60_000,
        failOnStartupError: false,
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
