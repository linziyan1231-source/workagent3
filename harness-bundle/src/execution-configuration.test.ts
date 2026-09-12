import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PresetStore } from "./preset-store.js";
import { ModelAccessStore } from "./model-access-store.js";
import { resolveExecutionConfiguration } from "./execution-configuration.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
function fixture() {
  const home = mkdtempSync(
    join(tmpdir(), "workagent-effective-configuration-"),
  );
  roots.push(home);
  return new PresetStore(home, new ModelAccessStore(home));
}
describe("effective execution configuration", () => {
  it("uses frozen assistant instructions while keeping actual and billing models separate", () => {
    const presets = fixture();
    const assistant = presets.create({
      name: "Pinned",
      engine: "codex",
      modelId: "codex-native",
      systemPrompt: "First {{literal}}",
    });
    const binding = presets.resolve(assistant.id);
    presets.update(assistant.id, { systemPrompt: "Second" });
    const result = resolveExecutionConfiguration({
      engine: "codex",
      preset: binding,
      workspace: "C:/work",
      overrides: {
        modelId: "gpt-test",
        permissionMode: "read_only",
        thinkingEffort: "high",
      },
    });
    expect(result).toMatchObject({
      systemPrompt: "First {{literal}}",
      presetVersion: 1,
      billingModelId: "codex-native",
      engineModelId: "gpt-test",
      permissionMode: "read_only",
      approvalPolicy: "on_risk",
      thinkingEffort: "high",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(binding.resolvedSnapshot.systemPrompt).toBe("First {{literal}}");
  });
  it("applies preset policy unless an explicit permission selection replaces it", () => {
    const presets = fixture();
    const assistant = presets.create({
      name: "No prompts",
      engine: "codex",
      approvalPolicy: "never",
    });
    const input = {
      engine: "codex" as const,
      preset: presets.resolve(assistant.id),
      workspace: "C:/work",
    };
    expect(resolveExecutionConfiguration(input)).toMatchObject({
      permissionMode: "workspace_write",
      approvalPolicy: "never",
      engineModelId: undefined,
    });
    expect(
      resolveExecutionConfiguration({
        ...input,
        overrides: { permissionMode: "read_only" },
      }),
    ).toMatchObject({ permissionMode: "read_only", approvalPolicy: "on_risk" });
  });
  it.each(["harness", "codex", "kimi"] as const)(
    "rejects unenforceable %s tools/approval and a missing required workspace",
    (engine) => {
      const presets = fixture();
      const assistant = presets.create({
        name: "Restricted",
        engine,
        toolAllowlist: ["read_file"],
      });
      const resolve = () =>
        resolveExecutionConfiguration({
          engine,
          preset: presets.resolve(assistant.id),
          workspace: "",
        });
      expect(resolve).toThrow("unsupported_preset_tool_allowlist");
      presets.update(assistant.id, {
        toolAllowlist: [],
        approvalPolicy: "always_ask",
      });
      expect(resolve).toThrow("unsupported_preset_approval_policy:always_ask");
      presets.update(assistant.id, {
        approvalPolicy: "on_risk",
        workspacePolicy: "required",
      });
      expect(resolve).toThrow("preset_workspace_required");
    },
  );
});
