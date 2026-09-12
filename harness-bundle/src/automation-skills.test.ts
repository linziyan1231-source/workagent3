import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { AutomationStore } from "./automation-store.js";
import { SkillCatalogStore } from "./capability-store.js";
import { WorkspaceStore } from "./workspace-store.js";
import { automationSkillPrompt, validatedSkillSuggestion } from "./automation-skills.js";
it("proposes only for fresh conversations, validates scoped suggestions, and executes the saved skill after binding", async () => {
  const home = mkdtempSync(join(tmpdir(), "wa-auto-skills-"));
  try {
    const store = new AutomationStore(home);
    const workspaces = new WorkspaceStore(join(home, "projects"), home);
    const skills = new SkillCatalogStore();
    const definition = store.create({ name: "Weekly report", enabled: true, schedule: { kind: "interval", everyMinutes: 60 }, presetId: "builtin-codex", engine: "codex", workspaceId: "default", input: "Create a report", notificationPolicy: "none" });
    const suggestion = automationSkillPrompt(definition, "run-1", skills);
    expect(suggestion.input).toContain("不要自动安装技能");
    expect(automationSkillPrompt({ ...definition, executionMode: "existing" }, "run-2", skills).input).toBe(definition.input);
    expect(await validatedSkillSuggestion(workspaces, "default", suggestion.path)).toBeUndefined();
    const document = "---\nname: weekly-report\ndescription: Prepare and verify a weekly report\n---\nScope: weekly reports.\nCheck the source dates.\n";
    workspaces.write("default", suggestion.path!, Buffer.from(document));
    expect(await validatedSkillSuggestion(workspaces, "default", suggestion.path)).toBe(suggestion.path);
    expect(await validatedSkillSuggestion(workspaces, "default", "../secret")).toBeUndefined();
    const root = join(home, "saved-skill");
    mkdirSync(join(root, "weekly-report"), { recursive: true });
    writeFileSync(join(root, "weekly-report", "SKILL.md"), document);
    skills.replace({ skills: [{ root, entry: { id: "saved-skill", name: "Weekly report", description: "Prepare report", version: "1", source: "user", enabled: true, relativePath: "saved-skill/weekly-report", requiredMcpServerIds: [], requiredCommands: [], health: "ready" } }] });
    const bound = store.update(definition.id, definition.version, { skillId: "saved-skill" });
    expect(automationSkillPrompt(bound, "run-2", skills).input).toContain("Check the source dates.");
    expect(automationSkillPrompt(bound, "run-2", skills).path).toBeUndefined();
    skills.replace({ skills: [{ root, entry: { id: "saved-skill", name: "Weekly report", description: "Prepare report", version: "1", source: "user", enabled: false, relativePath: "saved-skill/weekly-report", requiredMcpServerIds: [], requiredCommands: [], health: "ready" } }] });
    expect(automationSkillPrompt(bound, "run-3", skills).input).toContain("Check the source dates.");
    skills.replace({ skills: [] });
    expect(() => automationSkillPrompt(bound, "run-4", skills)).toThrow("automation_skill_unavailable");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
