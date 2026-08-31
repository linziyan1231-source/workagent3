import { describe, expect, it } from "vitest";
import { McpCatalogStore, SkillCatalogStore } from "./capability-store.js";

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

describe("UserHost-owned skill projection", () => {
  const entry = {
    id: "drawing-review",
    name: "Drawing Review",
    description: "Reviews drawings",
    version: "1.0.0",
    source: "user" as const,
    enabled: true,
    relativePath: "drawing-review/drawing-review",
    requiredMcpServerIds: [],
    requiredCommands: [],
    health: "ready" as const,
  };

  it("keeps private roots out of the public catalog", () => {
    const store = new SkillCatalogStore();
    const root =
      process.platform === "win32" ? "C:\\private\\skills" : "/private/skills";
    store.replace({ skills: [{ entry, root }] });
    expect(store.getSkill(entry.id)).toEqual(entry);
    expect(JSON.stringify(store.listSkills())).not.toContain("private/skills");
    expect(store.resolveSkill(entry.id)?.root).toBe(root);
  });

  it("replaces atomically and rejects relative roots", () => {
    const store = new SkillCatalogStore();
    store.replace({ skills: [] });
    expect(() =>
      store.replace({ skills: [{ entry, root: "relative/skills" }] }),
    ).toThrow("invalid_skill_projection_root");
    expect(store.listSkills()).toEqual([]);
  });
});
