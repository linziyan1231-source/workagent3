import type { EngineId, PresetBinding } from "@workagent/contracts";

export type PermissionMode = "read_only" | "workspace_write" | "full_access";
export type ExecutionOverrides = {
  modelId?: string;
  thinkingEffort?: string;
  permissionMode?: PermissionMode;
};

const billingDefaults = {
  harness: "harness-default",
  codex: "codex-native",
  kimi: "kimi-native",
} as const;

// Preset modelId belongs to the platform's accounting catalog. Engine model
// selections are provider-specific identifiers and never change the payer pool.
export const executionBillingModel = (
  engine: EngineId,
  presetModelId?: string | null,
) => presetModelId ?? billingDefaults[engine];

export class ExecutionConfigurationError extends Error {}

export function resolveExecutionConfiguration(input: {
  engine: EngineId;
  preset: PresetBinding;
  overrides?: ExecutionOverrides;
  workspace: string;
  workspaceAssigned?: boolean;
}) {
  const preset = input.preset.resolvedSnapshot;
  const overrides = input.overrides ?? {};
  if (preset.engine !== input.engine)
    throw new ExecutionConfigurationError("preset_engine_mismatch");
  if (
    preset.workspacePolicy === "required" &&
    (!input.workspace.trim() || input.workspaceAssigned === false)
  )
    throw new ExecutionConfigurationError("preset_workspace_required");
  // No current engine exposes the same complete tool-name universe. Do not
  // pretend an arbitrary persisted allowlist restricts its native tool runner.
  if (preset.toolAllowlist.length)
    throw new ExecutionConfigurationError("unsupported_preset_tool_allowlist");
  const permissionMode = overrides.permissionMode ?? "workspace_write";
  const approvalPolicy = overrides.permissionMode
    ? permissionMode === "full_access"
      ? "never"
      : "on_risk"
    : preset.approvalPolicy;
  if (approvalPolicy === "always_ask")
    throw new ExecutionConfigurationError(
      "unsupported_preset_approval_policy:always_ask",
    );
  if (
    approvalPolicy === "never" &&
    input.engine !== "codex" &&
    permissionMode !== "full_access"
  )
    throw new ExecutionConfigurationError(
      `unsupported_preset_approval_policy:${input.engine}:never`,
    );
  return Object.freeze({
    engine: input.engine,
    presetId: input.preset.presetId,
    presetVersion: input.preset.presetVersion,
    systemPrompt: preset.systemPrompt,
    billingModelId: executionBillingModel(input.engine, preset.modelId),
    engineModelId:
      overrides.modelId === billingDefaults[input.engine]
        ? undefined
        : overrides.modelId,
    thinkingEffort: overrides.thinkingEffort,
    permissionMode,
    approvalPolicy,
    workspace: input.workspace,
  });
}

export type EffectiveExecutionConfiguration = ReturnType<
  typeof resolveExecutionConfiguration
>;
