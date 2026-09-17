import { describe, expect, it } from "vitest";
import { sessionToolsServer } from "../session-tools-mcp.js";
import {
  codexAccountStatus,
  codexPermissions,
  projectCodexMcpServers,
} from "./codex.js";

describe("Codex account status", () => {
  it("requires native login only when the provider requires OpenAI auth", () => {
    expect(
      codexAccountStatus({ account: null, requiresOpenaiAuth: true }),
    ).toMatchObject({ state: "needs_auth", authenticated: false });
    expect(
      codexAccountStatus({ account: null, requiresOpenaiAuth: false }),
    ).toMatchObject({ state: "ready", authenticated: true });
    expect(
      codexAccountStatus({
        account: { type: "chatgpt" },
        requiresOpenaiAuth: true,
      }),
    ).toMatchObject({ state: "ready", authenticated: true });
  });
});

describe("Codex MCP projection", () => {
  it("allows Codex startup when session tools cannot initialize", () => {
    const projected = projectCodexMcpServers([
      sessionToolsServer("session", "scope-token"),
    ]);
    expect(projected["workagent-session-tools"]!.required).toBe(false);
  });
  it("projects credentials and tool allowlists through thread config", () => {
    expect(
      projectCodexMcpServers([
        {
          server: {
            id: "docs",
            name: "Docs",
            source: "user",
            enabled: true,
            transport: {
              kind: "http",
              url: "https://example.com/mcp",
              headerCredentialIds: { Authorization: "credential-1" },
            },
            toolPolicy: "allowlist",
            allowedTools: ["search"],
            oauthState: "ready",
            health: "healthy",
            createdAt: "2026-08-31T00:00:00.000Z",
            updatedAt: "2026-08-31T00:00:00.000Z",
          },
          environment: {},
          headers: { Authorization: "Bearer private" },
          state: "ready",
        },
      ]),
    ).toEqual({
      docs: {
        url: "https://example.com/mcp",
        http_headers: { Authorization: "Bearer private" },
        required: false,
        enabled_tools: ["search"],
      },
    });
  });

  it("projects stdio and rejects legacy SSE explicitly", () => {
    const base = {
      name: "Local",
      source: "managed" as const,
      enabled: true,
      toolPolicy: "all" as const,
      allowedTools: [],
      oauthState: "none" as const,
      health: "healthy" as const,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    expect(
      projectCodexMcpServers([
        {
          server: {
            ...base,
            id: "local",
            transport: {
              kind: "stdio",
              command: "C:\\managed\\server.exe",
              args: ["--stdio"],
              environmentCredentialIds: { TOKEN: "credential-1" },
            },
          },
          environment: { TOKEN: "private" },
          headers: {},
          state: "ready",
        },
      ]),
    ).toEqual({
      local: {
        command: "C:\\managed\\server.exe",
        args: ["--stdio"],
        env: { TOKEN: "private" },
        required: false,
      },
    });
    expect(() =>
      projectCodexMcpServers([
        {
          server: {
            ...base,
            id: "legacy",
            transport: {
              kind: "sse",
              url: "https://example.com/events",
              headerCredentialIds: {},
            },
          },
          environment: {},
          headers: {},
          state: "ready",
        },
      ]),
    ).toThrow("unsupported_mcp_transport:codex:sse:legacy");
  });
});

describe("Codex permissions", () => {
  it("honours a never-ask preset without granting access outside its sandbox", () => {
    expect(codexPermissions("workspace_write", "never")).toEqual({
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    expect(codexPermissions("read_only", "never")).toEqual({
      approvalPolicy: "never",
      sandbox: "read-only",
    });
  });
  it("maps the composer permission choices to native sandbox settings", () => {
    expect(codexPermissions("read_only")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    expect(codexPermissions("workspace_write")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(codexPermissions("full_access")).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });
});
