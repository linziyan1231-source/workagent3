import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { McpCatalogStore, SkillCatalogStore } from "./capability-store.js";
import { PresetStore } from "./preset-store.js";
import { ModelAccessStore } from "./model-access-store.js";
import { codexCapabilityConfig } from "./engines/codex.js";
import { kimiSkillDirectories, withSkillCatalog } from "./engines/skills.js";
import type { ResolvedMcpServer } from "./mcp-projection.js";
import type { ResolvedSkill } from "./skill-projection.js";

const roots: string[] = [];
const temporary = () => {
  const root = mkdtempSync(join(tmpdir(), "wa3-global-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const mcp = (
  id: string,
  kind: "stdio" | "http" | "sse" = "http",
): ResolvedMcpServer => ({
  server: {
    id,
    name: id,
    source: "user",
    enabled: true,
    transport:
      kind === "stdio"
        ? {
            kind,
            command: process.execPath,
            args: [],
            environmentCredentialIds: {},
            globalSource: "codex/config:" + id,
            nativeName: id,
          }
        : {
            kind,
            url: "https://example.test/mcp",
            headerCredentialIds: {},
            globalSource: "codex/config:" + id,
            nativeName: id,
          },
    toolPolicy: "all",
    allowedTools: [],
    oauthState: "none",
    health: "healthy",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  },
  environment: {},
  headers: {},
  state: "ready",
});
const skill = (root: string): ResolvedSkill => ({
  root,
  entry: {
    id: "shared",
    name: "shared",
    description: "Use a supporting resource",
    version: "1",
    source: "user",
    enabled: true,
    relativePath: "shared/shared",
    referenceDirectory: join(root, "original"),
    requiredMcpServerIds: [],
    requiredCommands: [],
    health: "ready",
  },
});

it("adds only enabled compatible global capabilities to new sessions", () => {
  const home = temporary(),
    skills = new SkillCatalogStore(),
    servers = new McpCatalogStore();
  const shared = skill(home),
    remote = mcp("remote"),
    sse = mcp("events", "sse"),
    offline = { ...mcp("offline"), state: "unavailable" };
  const local = mcp("explicit-only");
  delete local.server.transport.globalSource;
  skills.replace({ skills: [shared] });
  servers.replace({
    servers: [remote, sse, offline, local],
    nativeNames: ["remote"],
  });
  const presets = new PresetStore(
    home,
    new ModelAccessStore(home),
    skills,
    servers,
  );
  const before = presets.resolve("builtin-codex");
  expect(before.resolvedSnapshot.skillIds).toEqual(["shared"]);
  expect(before.resolvedSnapshot.mcpServerIds).toEqual(["remote"]);
  expect(presets.resolve("builtin-kimi").resolvedSnapshot.mcpServerIds).toEqual(
    ["events", "remote"],
  );
  shared.entry.enabled = false;
  remote.server.enabled = false;
  remote.state = "unavailable";
  skills.replace({ skills: [shared] });
  servers.replace({ servers: [remote] });
  expect(presets.resolve("builtin-codex").resolvedSnapshot.skillIds).toEqual(
    [],
  );
  expect(
    presets.resolve("builtin-codex").resolvedSnapshot.mcpServerIds,
  ).toEqual([]);
  expect(before.resolvedSnapshot.skillIds).toEqual(["shared"]);
  expect(before.resolvedSnapshot.mcpServerIds).toEqual(["remote"]);
});

it("suppresses disabled native entries and uses one canonical MCP name", () => {
  const server = mcp("docs");
  server.server.id = "platform-id";
  const config = codexCapabilityConfig({
    mcpServers: [server],
    nativeMcpNames: ["docs", "removed"],
    nativeMcpConfig: {
      docs: { url: "https://example.test/mcp", enabled: false },
      removed: { url: "https://removed.test/mcp", enabled: false },
    },
  });
  expect(Object.keys(config.mcp_servers)).toEqual(["docs", "removed"]);
  expect(config.mcp_servers.docs).toMatchObject({
    enabled: true,
    required: false,
  });
  expect(config.mcp_servers.removed).toEqual({
    url: "https://removed.test/mcp",
    enabled: false,
  });
});

it("does not overwrite project MCP entries with global settings", () => {
  const root = temporary();
  mkdirSync(join(root, ".codex"));
  mkdirSync(join(root, ".git"));
  writeFileSync(
    join(root, ".codex", "config.toml"),
    '[mcp_servers."docs"]\nurl="https://project.test/mcp"\n',
  );
  const config = codexCapabilityConfig(
    { mcpServers: [mcp("docs")], nativeMcpNames: ["docs"] },
    root,
  );
  expect(config.mcp_servers).toEqual({});
});

it("keeps project skills while filtering native Kimi global roots", () => {
  const root = temporary();
  vi.stubEnv("KIMI_CODE_HOME", root);
  mkdirSync(join(root, ".agents", "skills"), { recursive: true });
  mkdirSync(join(root, ".kimi", "skills"), { recursive: true });
  const shared = skill(join(root, "enabled"));
  expect(
    kimiSkillDirectories(root, { skills: [shared], mcpServers: [] }),
  ).toEqual([
    join(root, ".agents", "skills"),
    join(root, ".kimi", "skills"),
    shared.root,
  ]);
  expect(
    kimiSkillDirectories(root, { skills: [], mcpServers: [] }),
  ).not.toContain(shared.root);
  const disabled = codexCapabilityConfig({
    skills: [],
    catalogSkills: [shared],
    mcpServers: [],
  });
  expect(disabled.skills?.config).toEqual([
    {
      path: join(shared.entry.referenceDirectory!, "SKILL.md"),
      enabled: false,
    },
  ]);
});

it("exposes skill paths lazily and does not prepend every skill document", async () => {
  const send = vi.fn(async (_content: string) => "turn");
  const shared = skill(temporary());
  const session = withSkillCatalog(
    {
      nativeId: "native",
      connected: true,
      send,
      steer: send,
      cancel: async () => {},
      close: async () => {},
    },
    { mcpServers: [], skills: [shared] },
  );
  await session.send("first");
  await session.send("second");
  expect(send.mock.calls[0]?.[0]).toContain("SKILL.md");
  expect(send.mock.calls[1]?.[0]).toBe("second");
});

it("delivers assistant instructions even when there are no shared skills", async () => {
  const send = vi.fn(async (_content: string) => "turn");
  const session = withSkillCatalog(
    {
      nativeId: "native",
      connected: true,
      send,
      steer: send,
      cancel: async () => {},
      close: async () => {},
    },
    {
      mcpServers: [],
      skills: [],
      systemPrompt: "Use the bundled butler.js overview helper",
    },
  );
  await session.send("Check settings");
  await session.send("Next question");
  expect(send.mock.calls[0]?.[0]).toContain("butler.js overview");
  expect(send.mock.calls[1]?.[0]).toBe("Next question");
});
