import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelAccessStore } from "./model-access-store.js";
import { PresetStore } from "./preset-store.js";
import { McpCatalogStore, SkillCatalogStore } from "./capability-store.js";

describe("SID-private preset store", () => {
  it("persists independent avatars for builtins and copied assistants", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-avatar-"));
    const open = () => new PresetStore(home, new ModelAccessStore(home));
    const store = open();
    const image = "data:image/webp;base64," + "A".repeat(4000);
    store.update("builtin-codex", { avatar: image });
    store.update("builtin-kimi", { avatar: "emoji:🦊" });
    store.update("builtin-codex", { enabled: false });
    const reloaded = open();
    expect(reloaded.get("builtin-codex")?.avatar).toBe(image);
    expect(reloaded.get("builtin-codex")?.enabled).toBe(false);
    expect(reloaded.get("builtin-kimi")?.avatar).toBe("emoji:🦊");
    const copied = reloaded.copy("builtin-kimi", "研究员");
    expect(copied.avatar).toBe("emoji:🦊");
    reloaded.update(copied.id, { avatar: "emoji:📚" });
    reloaded.update("builtin-kimi", { avatar: null });
    expect(open().get(copied.id)?.avatar).toBe("emoji:📚");
    expect(open().get("builtin-kimi")?.avatar).toBeNull();
    expect(() =>
      reloaded.update(copied.id, { avatar: "a".repeat(65_537) }),
    ).toThrow();
  });
  it("defaults DSH off, migrates old defaults, and preserves explicit switches after restart", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-presets-"));
    const store = new PresetStore(home, new ModelAccessStore(home));
    expect(store.get("builtin-general")?.enabled).toBe(false);
    expect(store.get("builtin-codex")?.enabled).toBe(true);
    expect(store.get("builtin-kimi")?.enabled).toBe(true);
    // Previous releases stored all built-ins enabled and exposed no switch.
    writeFileSync(
      join(home, "workagent", "presets.json"),
      JSON.stringify(
        store.list().map((preset) => ({ ...preset, enabled: true })),
      ),
    );
    const migrated = new PresetStore(home, new ModelAccessStore(home));
    expect(() => migrated.resolve("builtin-general")).toThrow(
      "preset_disabled",
    );
    migrated.update("builtin-general", { enabled: true });
    const binding = migrated.resolve("builtin-codex");
    migrated.update("builtin-codex", { enabled: false });
    migrated.update("builtin-kimi", { enabled: false });
    const reloaded = new PresetStore(home, new ModelAccessStore(home));
    expect(reloaded.resolve("builtin-general").resolvedSnapshot.enabled).toBe(
      true,
    );
    expect(() => reloaded.resolve("builtin-codex")).toThrow("preset_disabled");
    expect(reloaded.get("builtin-kimi")?.enabled).toBe(false);
    expect(binding.resolvedSnapshot.enabled).toBe(true);
    expect(() =>
      reloaded.update("builtin-codex", { enabled: true, name: "Changed" }),
    ).toThrow("builtin_preset_immutable");
    expect(() => reloaded.delete("builtin-codex")).toThrow(
      "builtin_preset_immutable",
    );
  });

  it("imports a legacy Preset projection idempotently", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-presets-"));
    const store = new PresetStore(
      home,
      new ModelAccessStore(home),
      new SkillCatalogStore(),
      new McpCatalogStore(),
    );
    const projection = {
      schemaVersion: 1 as const,
      sid: "S-1-5-21-1",
      capturedAt: "2026-09-01T00:00:00.000Z",
      presets: [
        {
          oldId: "assistant/one",
          name: "Legacy assistant",
          description: "Migrated",
          avatar: null,
          engine: "harness" as const,
          modelId: null,
          systemPrompt: "Keep the original rules.",
          enabled: true,
          skillIds: [],
          mcpServerIds: [],
          skillBindingIds: ["legacy-skill-binding"],
          mcpBindingIds: ["legacy-mcp-binding"],
          approvalPolicy: "on_risk" as const,
          migrationIssues: [],
        },
      ],
    };

    const importedResults = store.importLegacy(projection).results;
    expect(importedResults[0]).toMatchObject({
      sourceId: "assistant/one",
      status: "ready",
    });
    expect(importedResults.map((result) => result.kind)).toEqual([
      "preset",
      "skill_binding",
      "mcp_binding",
    ]);
    const target = store
      .list()
      .find((preset) => preset.name === "Legacy assistant")!;
    expect(target).toMatchObject({
      enabled: true,
      version: 1,
      systemPrompt: "Keep the original rules.",
    });
    store.importLegacy(projection);
    expect(store.get(target.id)?.version).toBe(1);
  });

  it("keeps an unauthorized migrated Preset disabled until recovery", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-presets-"));
    const mcp = new McpCatalogStore();
    const server = {
      id: "legacy-mcp",
      name: "Legacy MCP",
      source: "user",
      enabled: true,
      transport: {
        kind: "http",
        url: "https://example.test/mcp",
        headerCredentialIds: {},
      },
      toolPolicy: "all",
      allowedTools: [],
      oauthState: "needs_auth",
      health: "unknown",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    } as const;
    mcp.replace({
      servers: [{ server, environment: {}, headers: {}, state: "needs_auth" }],
    });
    const store = new PresetStore(
      home,
      new ModelAccessStore(home),
      new SkillCatalogStore(),
      mcp,
    );
    const projection = {
      schemaVersion: 1 as const,
      sid: "S-1-5-21-1",
      capturedAt: "2026-09-01T00:00:00.000Z",
      presets: [
        {
          oldId: "assistant",
          name: "Needs auth",
          description: "",
          avatar: null,
          engine: "harness" as const,
          modelId: null,
          systemPrompt: "",
          enabled: true,
          skillIds: [],
          mcpServerIds: [server.id],
          approvalPolicy: "on_risk" as const,
          migrationIssues: [],
        },
      ],
    };

    expect(store.importLegacy(projection).results[0]?.status).toBe(
      "needs_auth",
    );
    const target = store.list().find((preset) => preset.name === "Needs auth")!;
    expect(target.enabled).toBe(false);
    mcp.replace({
      servers: [
        {
          server: { ...server, oauthState: "none", health: "healthy" },
          environment: {},
          headers: {},
          state: "ready",
        },
      ],
    });
    expect(store.importLegacy(projection).results[0]?.status).toBe("ready");
    expect(store.get(target.id)).toMatchObject({ enabled: true, version: 2 });
  });

  it("keeps immutable versions and resolves a stable session snapshot", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-presets-"));
    const store = new PresetStore(home, new ModelAccessStore(home));
    const created = store.create({ name: "Coder", engine: "codex" });
    const firstBinding = store.resolve(created.id);

    const updated = store.update(created.id, { systemPrompt: "Be concise." });
    const secondBinding = store.resolve(created.id);

    expect(updated.version).toBe(2);
    expect(firstBinding.presetVersion).toBe(1);
    expect(firstBinding.resolvedSnapshot.systemPrompt).toBe("");
    expect(secondBinding.presetVersion).toBe(2);
    expect(secondBinding.resolvedSnapshot.systemPrompt).toBe("Be concise.");

    const reloaded = new PresetStore(home, new ModelAccessStore(home));
    expect(reloaded.get(created.id)?.version).toBe(2);
  });

  it("reports invalid model and engine bindings instead of dropping them", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-presets-"));
    const store = new PresetStore(home, new ModelAccessStore(home));

    expect(() =>
      store.create({
        name: "Wrong model",
        engine: "codex",
        modelId: "kimi-native",
      }),
    ).toThrow("invalid_model_binding:engine_mismatch");
    expect(() =>
      store.create({
        name: "Missing model",
        engine: "codex",
        modelId: "not-a-model",
      }),
    ).toThrow("invalid_model_binding:model_not_found");
  });

  it("does not allow built-in presets to be mutated", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-presets-"));
    const store = new PresetStore(home, new ModelAccessStore(home));
    expect(() => store.update("builtin-general", { name: "Changed" })).toThrow(
      "builtin_preset_immutable",
    );
  });

  it("reports missing capability bindings instead of silently dropping them", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-presets-"));
    const store = new PresetStore(
      home,
      new ModelAccessStore(home),
      new SkillCatalogStore(),
      new McpCatalogStore(),
    );
    expect(() =>
      store.create({
        name: "Missing MCP",
        engine: "kimi",
        mcpServerIds: ["missing"],
      }),
    ).toThrow("invalid_mcp_binding:missing:not_found");
  });

  it("rejects a skill whose SID command dependency is unavailable", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-presets-"));
    const skills = new SkillCatalogStore();
    const root =
      process.platform === "win32" ? "C:\\private\\office" : "/private/office";
    skills.replace({
      skills: [
        {
          entry: {
            id: "office",
            name: "Office",
            description: "Office documents",
            version: "1",
            source: "managed",
            enabled: true,
            relativePath: "office/office",
            requiredMcpServerIds: [],
            requiredCommands: ["officecli"],
            health: "unavailable",
            unavailableReason: "command_not_found:officecli",
          },
          root,
        },
      ],
    });
    const store = new PresetStore(
      home,
      new ModelAccessStore(home),
      skills,
      new McpCatalogStore(),
    );
    expect(() =>
      store.create({ name: "Office", engine: "harness", skillIds: ["office"] }),
    ).toThrow("invalid_skill_binding:office:command_not_found:officecli");
  });

  it("freezes resolved MCP definitions in the session binding", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-presets-"));
    const mcp = new McpCatalogStore();
    const server = {
      id: "mcp-original",
      name: "Original name",
      source: "user",
      enabled: true,
      transport: {
        kind: "http",
        url: "http://127.0.0.1:8123/mcp",
        headerCredentialIds: {},
      },
      toolPolicy: "all",
      allowedTools: [],
      oauthState: "none",
      health: "healthy",
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    } as const;
    mcp.replace({
      servers: [{ server, environment: {}, headers: {}, state: "ready" }],
    });
    const store = new PresetStore(
      home,
      new ModelAccessStore(home),
      new SkillCatalogStore(),
      mcp,
    );
    const preset = store.create({
      name: "MCP preset",
      engine: "kimi",
      mcpServerIds: [server.id],
    });
    const binding = store.resolve(preset.id);

    mcp.replace({
      servers: [
        {
          server: { ...server, name: "Changed name" },
          environment: {},
          headers: {},
          state: "ready",
        },
      ],
    });

    expect(binding.resolvedSnapshot.resolvedMcpServers?.[0]?.name).toBe(
      "Original name",
    );
  });
});
