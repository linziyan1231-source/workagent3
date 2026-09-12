import type { EngineModel } from "./engines/types.js";
import { readFileSync, lstatSync } from "node:fs";
import { join, basename } from "node:path";
import type { ResolvedSkill } from "./skill-projection.js";

export function channelAssistantContext(
  prompt: string,
  skills: readonly ResolvedSkill[],
) {
  return [
    prompt.trim(),
    ...skills.map((skill) => {
      if (skill.entry.referenceDirectory)
        return `可用技能 ${skill.entry.name}：${skill.entry.description}。需要时先读取 ${join(skill.entry.referenceDirectory, "SKILL.md")}，再按其说明使用同目录资源。`;
      const parts = skill.entry.relativePath.replaceAll("\\", "/").split("/");
      if (parts[0] === basename(skill.root)) parts.shift();
      if (
        parts.some(
          (part) =>
            !part || part === "." || part === ".." || part.includes(":"),
        )
      )
        throw new Error("channel_skill_unavailable");
      if (parts.at(-1) !== "SKILL.md") parts.push("SKILL.md");
      let path = skill.root;
      for (const part of parts) {
        path = join(path, part);
        if (lstatSync(path).isSymbolicLink())
          throw new Error("channel_skill_unavailable");
      }
      const file = lstatSync(path);
      if (!file.isFile() || file.size > 128 * 1024)
        throw new Error("channel_skill_unavailable");
      return `已绑定技能 ${skill.entry.name}（${path}）。按以下流程执行；操作仍需遵守当前授权和权限。\n${readFileSync(path, "utf8")}`;
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type ChannelConfig = {
  presetId?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  cwd?: string;
  permissionPreset?: string;
};

export const channelEngine = (provider?: string) =>
  provider === "workagent-codex"
    ? "codex"
    : provider === "workagent-kimi"
      ? "kimi"
      : provider === "workagent-harness"
        ? "harness"
        : undefined;

export function channelPermission(preset?: string) {
  switch (preset) {
    case "read-only":
      return "read_only";
    case "workspace-write":
      return "workspace_write";
    case "danger-full-access":
      return "full_access";
    default:
      throw new Error("消息渠道请选择只读、工作区写入或完全访问权限");
  }
}

export function channelModelCatalog(
  groups: Array<{ engine: string; models: EngineModel[] }>,
) {
  return groups
    .filter((group) => ["codex", "kimi", "harness"].includes(group.engine))
    .map((group) => ({
      id: `workagent-${group.engine}`,
      name:
        group.engine === "codex"
          ? "Codex"
          : group.engine === "kimi"
            ? "Kimi"
            : "通用引擎",
      models: group.models.map((model) => ({
        id: model.id,
        name: model.name,
        ...(model.reasoning.length
          ? {
              reasoning: {
                efforts: model.reasoning,
                defaultEffort: model.defaultReasoning,
              },
            }
          : {}),
      })),
    }));
}

export type ChannelEvent = { type: string; data: Record<string, unknown> };

// Reuse the IM plugin's streaming and final-message delivery for native engines.
export function channelEvent(
  event: Record<string, unknown>,
): ChannelEvent | undefined {
  switch (event.type) {
    case "assistant.delta":
      return {
        type: "assistant/chunk",
        data: { chunk: { type: "text-delta", text: event.delta } },
      };
    case "assistant.completed":
      return {
        type: "assistant/message",
        data: { message: { content: [{ type: "text", text: event.content }] } },
      };
    case "turn.failed":
      return {
        type: "turn/end",
        data: { reason: { kind: "error", error: { message: event.message } } },
      };
    case "turn.cancelled":
      return {
        type: "turn/end",
        data: { reason: { kind: "error", error: { message: "会话已取消" } } },
      };
    case "turn.completed":
      return { type: "turn/end", data: { reason: { kind: "completed" } } };
    default:
      return undefined;
  }
}
