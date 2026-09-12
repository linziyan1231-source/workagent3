// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { personalTaskDefaults, resolveModelDefaults } from "./model-defaults.js";

beforeEach(() => {
  const values = new Map();
  vi.stubGlobal("localStorage", { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());
const group = {
  engine: "codex",
  models: [
    { id: "current", reasoning: [{ id: "low" }, { id: "high" }] },
    { id: "backup", reasoning: [{ id: "low" }], isDefault: true },
  ],
};

it("keeps personal assistant defaults separate from engine defaults and retires unavailable choices", () => {
  const saved = {
    codex: { modelId: "current", thinkingEffort: "high", permissionMode: "read_only" },
    "assistant:mine:codex": { modelId: "removed", thinkingEffort: "ultra", permissionMode: "obsolete" },
  };
  expect(resolveModelDefaults(group, saved)).toEqual({ modelId: "current", thinkingEffort: "high", permissionMode: "read_only" });
  expect(resolveModelDefaults(group, saved, { id: "mine", engine: "codex", source: "user", modelId: "backup" })).toEqual({ modelId: "backup", thinkingEffort: "low", permissionMode: "workspace_write" });
});

it("creates shared personal tasks from an enabled assistant and tolerates damaged saved preferences", async () => {
  localStorage.setItem("workagent.hero.agent", "disabled");
  localStorage.setItem("workagent.model-defaults.v1", "broken json");
  vi.stubGlobal("fetch", vi.fn(async (url) => new Response(JSON.stringify(String(url).endsWith("/presets") ? [
    { id: "disabled", enabled: false, engine: "kimi" },
    { id: "builtin-general", enabled: true, engine: "codex" },
  ] : [group]), { headers: { "content-type": "application/json" } })));
  expect(await personalTaskDefaults()).toEqual({ engine: "codex", presetId: "builtin-general", modelId: "backup", thinkingEffort: "low", permissionMode: "workspace_write" });
});
