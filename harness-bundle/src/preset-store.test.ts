import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelAccessStore } from "./model-access-store.js";
import { PresetStore } from "./preset-store.js";
import { McpCatalogStore, SkillCatalogStore } from "./capability-store.js";

describe("SID-private preset store", () => {
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
      new SkillCatalogStore(home),
      new McpCatalogStore(home),
    );
    expect(() =>
      store.create({
        name: "Missing MCP",
        engine: "kimi",
        mcpServerIds: ["missing"],
      }),
    ).toThrow("invalid_mcp_binding:missing:not_found");
  });

  it("freezes resolved MCP definitions in the session binding", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-presets-"));
    const mcp = new McpCatalogStore(home);
    const server = mcp.create({
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
    });
    const store = new PresetStore(
      home,
      new ModelAccessStore(home),
      new SkillCatalogStore(home),
      mcp,
    );
    const preset = store.create({
      name: "MCP preset",
      engine: "kimi",
      mcpServerIds: [server.id],
    });
    const binding = store.resolve(preset.id);

    mcp.update(server.id, { name: "Changed name" });

    expect(binding.resolvedSnapshot.resolvedMcpServers?.[0]?.name).toBe(
      "Original name",
    );
  });
});
