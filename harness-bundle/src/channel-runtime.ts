import type { EngineModel } from "./engines/types.js";

export type ChannelConfig = {
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
    .filter((group) => group.engine === "codex" || group.engine === "kimi")
    .map((group) => ({
      id: `workagent-${group.engine}`,
      name: group.engine === "codex" ? "Codex" : "Kimi",
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
