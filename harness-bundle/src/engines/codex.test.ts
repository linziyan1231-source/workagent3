import { describe, expect, it } from "vitest";
import { codexAccountStatus, projectCodexMcpServers } from "./codex.js";

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
        required: true,
        enabled_tools: ["search"],
      },
    });
  });
});
