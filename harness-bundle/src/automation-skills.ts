import { lstatSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { AutomationDefinition } from "@workagent/contracts";
import type { SkillCatalogStore } from "./capability-store.js";
import type { WorkspaceStore } from "./workspace-store.js";

export function automationSkillPrompt(definition: AutomationDefinition, runId: string, skills: SkillCatalogStore) {
  if (definition.skillId) {
    const skill = skills.resolveSkill(definition.skillId);
    if (!skill?.entry.enabled) throw new Error("automation_skill_unavailable");
    const parts = skill.entry.relativePath.replaceAll("\\", "/").split("/");
    if (parts[0] === basename(skill.root)) parts.shift();
    if (parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) throw new Error("automation_skill_unavailable");
    if (parts.at(-1) !== "SKILL.md") parts.push("SKILL.md");
    let path = skill.root;
    for (const part of parts) { path = join(path, part); if (lstatSync(path).isSymbolicLink()) throw new Error("automation_skill_unavailable"); }
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 128 * 1024) throw new Error("automation_skill_unavailable");
    return { input: `${definition.input}\n\n本任务已绑定用户保存的技能 ${skill.entry.name}。按以下流程执行；技能中的操作仍需遵守当前任务授权和权限。技能文件位置：${path}\n\n${readFileSync(path, "utf8")}` };
  }
  if (definition.executionMode !== "new_conversation") return { input: definition.input };
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("invalid_automation_run");
  const path = `.workagent/skill-suggestions/${runId}/SKILL.md`;
  return { path, input: `${definition.input}\n\n完成任务后，如果形成了可复用且经过本次验证的流程，请在项目相对路径 ${path} 写一份独立可读的 SKILL.md 建议。包含 YAML frontmatter 的 name（小写英文和短横线）、description，以及适用范围、输入、执行步骤和结果检查。不要包含密码、令牌、个人数据、具体账号或本次临时路径。不要自动安装技能；用户会预览后决定是否保存。没有可靠可复用流程时无需生成。` };
}

export async function validatedSkillSuggestion(workspaces: WorkspaceStore, workspaceId: string, path?: string) {
  if (!path) return undefined;
  try {
    const file = await workspaces.readStream(workspaceId, path);
    try {
      if (file.size > 128 * 1024) return undefined;
      let text = "";
      for await (const chunk of file.stream) { text += String(chunk); if (Buffer.byteLength(text) > 128 * 1024) return undefined; }
      return /^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(text) && /^name:\s*\S+/m.test(text) && /^description:\s*\S+/m.test(text) ? path : undefined;
    } finally { file.stream.destroy(); }
  } catch { return undefined; }
}
