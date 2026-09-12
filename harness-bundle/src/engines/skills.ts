import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BridgeSession, EngineSessionOptions } from "./types.js";

// Native agents receive a catalog, not the complete contents of every skill.
export function withSkillCatalog(
  session: BridgeSession,
  options?: EngineSessionOptions,
): BridgeSession {
  const skills = options?.skills ?? [];
  if (!skills.length && !options?.systemPrompt?.trim()) return session;
  const context =
    (options?.systemPrompt?.trim()
      ? `助手说明：\n${options.systemPrompt.trim()}\n\n`
      : "") +
    (skills.length
      ? "以下是本会话已启用的员工全局技能。任务适用时先读取对应 SKILL.md，再按其说明使用资源；项目内同名技能优先。\n" +
        skills
          .map(({ entry, root }) =>
            JSON.stringify({
              name: entry.name,
              description: entry.description,
              path: entry.referenceDirectory
                ? join(entry.referenceDirectory, "SKILL.md")
                : join(
                    root,
                    ...entry.relativePath.split("/").slice(1),
                    "SKILL.md",
                  ),
            }),
          )
          .join("\n") +
        "\n\n"
      : "");
  let pending = true;
  return {
    nativeId: session.nativeId,
    get connected() {
      return session.connected;
    },
    ...(session.permissionMode
      ? { permissionMode: session.permissionMode }
      : {}),
    ...(session.compact ? { compact: () => session.compact!() } : {}),
    cancel: () => session.cancel(),
    close: () => session.close(),
    async send(content, images) {
      const result = await session.send(
        (pending ? context : "") + content,
        images,
      );
      pending = false;
      return result;
    },
    steer: (content, images) => session.steer(content, images),
  };
}

export function kimiSkillDirectories(
  workspace: string,
  options: EngineSessionOptions,
): string[] {
  // Kimi's override replaces discovery, so explicitly retain this project's
  // generic root and its first existing brand root in their normal order.
  const project = [join(workspace, ".agents", "skills")];
  const brand = [".kimi", ".claude", ".codex"]
    .map((name) => join(workspace, name, "skills"))
    .find(existsSync);
  if (brand) project.push(brand);
  const roots = [
    ...project.filter(existsSync),
    ...(options.skills ?? []).map((skill) => skill.root),
  ];
  const empty = join(process.env.KIMI_CODE_HOME!, "workagent-empty-skills");
  if (!roots.length) {
    mkdirSync(empty, { recursive: true });
    roots.push(empty);
  }
  return [...new Set(roots)];
}
