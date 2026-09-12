import type {
  ClientSideConnection,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { nativeEngineEnvironment } from "./environment.js";
import { kimiSkillDirectories } from "./skills.js";
import type { BridgeSession } from "./types.js";

const kimiModel = (modelId: string | undefined): string | undefined =>
  modelId === "kimi-native" ? undefined : modelId;

function configSelect(
  config: SessionConfigOption[] | undefined | null,
  category: string,
) {
  const item = config?.find(
    (option) => option.category === category || option.id === category,
  );
  if (!item || item.type !== "select") return undefined;
  return {
    id: item.id,
    currentValue: item.currentValue,
    options: item.options.flatMap((option) =>
      "options" in option ? option.options : [option],
    ),
  };
}

export function kimiModelOptions(
  models:
    | {
        currentModelId: string;
        availableModels: Array<{ modelId: string; name: string }>;
      }
    | null
    | undefined,
  configOptions?: SessionConfigOption[],
): import("./types.js").EngineModel[] {
  const modelOption = configSelect(configOptions, "model");
  if (modelOption) {
    const thought = configSelect(configOptions, "thought_level");
    return modelOption.options.map((model) => ({
      id: model.value,
      name: model.name,
      isDefault: model.value === modelOption.currentValue,
      reasoning: (thought?.options ?? []).map((option) => ({
        id: option.value,
        name: option.name,
      })),
      ...(thought ? { defaultReasoning: thought.currentValue } : {}),
    }));
  }
  const result = new Map<string, import("./types.js").EngineModel>();
  for (const model of models?.availableModels ?? []) {
    const thinking = model.modelId.endsWith(",thinking");
    const id = thinking ? model.modelId.slice(0, -9) : model.modelId;
    const row = result.get(id) ?? {
      id,
      name: model.name.replace(/ \(thinking\)$/, ""),
      isDefault: false,
      reasoning: [],
    };
    row.reasoning.push({
      id: thinking ? "thinking" : "off",
      name: thinking ? "开启思考" : "关闭思考",
    });
    if (model.modelId === models?.currentModelId) {
      row.isDefault = true;
      row.defaultReasoning = thinking ? "thinking" : "off";
    }
    result.set(id, row);
  }
  return [...result.values()];
}

export async function kimiSessionModelOptions(
  connection: ClientSideConnection,
  sessionId: string,
  models: Parameters<typeof kimiModelOptions>[0],
  configOptions?: SessionConfigOption[],
) {
  const result = kimiModelOptions(models, configOptions);
  const selector = configSelect(configOptions, "model");
  if (!selector || result.length < 2) return result;
  // Thinking options belong to the selected model, not the whole engine.
  for (const model of result) {
    if (model.isDefault) continue;
    const selected = await connection.setSessionConfigOption({
      sessionId,
      configId: selector.id,
      value: model.id,
    });
    const capabilities = kimiModelOptions(
      undefined,
      selected.configOptions,
    ).find((row) => row.id === model.id)!;
    model.reasoning = capabilities.reasoning;
    if (capabilities.defaultReasoning === undefined)
      delete model.defaultReasoning;
    else model.defaultReasoning = capabilities.defaultReasoning;
  }
  return result;
}

export const applyKimiOptions = async (
  connection: ClientSideConnection,
  sessionId: string,
  options: import("./types.js").EngineSessionOptions | undefined,
  modes:
    | {
        availableModes: Array<{ id: string; name: string }>;
        currentModeId: string;
      }
    | null
    | undefined,
  configOptions?: SessionConfigOption[],
): Promise<void> => {
  if (configSelect(configOptions, "model")) {
    for (const [category, value] of [
      ["model", kimiModel(options?.modelId)],
      ["thought_level", options?.thinkingEffort],
      [
        "mode",
        options?.permissionMode &&
          {
            read_only: "plan",
            workspace_write: "auto",
            full_access: "yolo",
          }[options.permissionMode],
      ],
    ] as const) {
      const option = configSelect(configOptions, category);
      if (category === "mode" && options?.requirePermission && !option)
        throw new Error("engine_permission_unavailable");
      if (option && value !== undefined && value !== option.currentValue) {
        try {
          const result = await connection.setSessionConfigOption({
            sessionId,
            configId: option.id,
            value,
          });
          configOptions = result.configOptions;
        } catch (error) {
          // Kimi 0.41 can advertise "default" after restoring a persisted
          // plan session. Reapplying plan then reports this already-set state.
          const details = (error as { data?: { details?: unknown } })?.data
            ?.details;
          if (
            category !== "mode" ||
            value !== "plan" ||
            details !== "Already in plan mode"
          )
            throw error;
        }
      }
    }
    return;
  }
  const selected = kimiModel(options?.modelId);
  const modelId =
    selected && options?.thinkingEffort === "thinking"
      ? `${selected},thinking`
      : selected;
  if (modelId !== undefined)
    await connection.unstable_setSessionModel({ sessionId, modelId });
  if (
    options?.permissionMode === undefined ||
    modes === undefined ||
    modes === null
  ) {
    if (options?.requirePermission)
      throw new Error("engine_permission_unavailable");
    return;
  }
  const terms = {
    read_only: ["plan", "readonly"],
    workspace_write: ["acceptedit", "acceptedits", "workspacewrite", "auto"],
    full_access: [
      "yolo",
      "yolonosandbox",
      "dangerfullaccess",
      "nosandbox",
      "bypass",
      "full",
      "fullaccess",
    ],
  }[options.permissionMode];
  const target = modes.availableModes.find((mode) => {
    return [mode.id, mode.name].some((value) =>
      terms.includes(value.toLowerCase().replace(/[^a-z]/g, "")),
    );
  });
  if (target === undefined && options.requirePermission)
    throw new Error("engine_permission_unavailable");
  if (target !== undefined && target.id !== modes.currentModeId)
    await connection.setSessionMode({ sessionId, modeId: target.id });
};

// ACP agents report in-agent session failures as JSON-RPC RequestError
// values with generic messages ("Internal error"); re-code them so callers
// see the engine context and the team API maps the failure to 503 instead of
// a bare 400.
export const kimiSessionFailure = (
  operation: string,
  error: unknown,
): Error => {
  const message = error instanceof Error ? error.message : String(error);
  const data =
    error instanceof Error ? (error as { data?: unknown }).data : undefined;
  const detail =
    data === undefined ? message : `${message} ${JSON.stringify(data)}`;
  return new Error(`engine_session_failed:kimi:${operation}: ${detail}`);
};

export function kimiPermission(result: {
  configOptions?: SessionConfigOption[] | null;
  modes?: { currentModeId: string } | null;
}): BridgeSession["permissionMode"] {
  const mode =
    configSelect(result.configOptions, "mode")?.currentValue ??
    result.modes?.currentModeId;
  return (
    {
      default: "manual_approval",
      plan: "read_only",
      auto: "workspace_write",
      yolo: "full_access",
    } as const
  )[mode as "default" | "plan" | "auto" | "yolo"];
}

export {
  AcpSession as KimiSession,
  projectMcpServers,
} from "./acp-transport.js";
import { AcpBridge } from "./acp-transport.js";

export class KimiBridge extends AcpBridge {
  constructor(
    binary = process.env.WORKAGENT_KIMI_BIN ?? "kimi",
    skillDirectories?: readonly string[],
  ) {
    super(
      {
        id: "kimi",
        command: binary,
        args: ["acp"],
        environment: () => {
          if (process.env.KIMI_CODE_HOME === undefined)
            throw new Error(
              "KIMI_CODE_HOME is required for the native Kimi engine",
            );
          return nativeEngineEnvironment(process.env, "KIMI_CODE_HOME");
        },
        applyOptions: applyKimiOptions,
        permission: kimiPermission,
        models: kimiSessionModelOptions,
        sessionFailure: kimiSessionFailure,
        skillDirectories: kimiSkillDirectories,
      },
      skillDirectories,
    );
  }
}
