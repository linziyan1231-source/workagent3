import type {
  AutomationDefinition,
  AutomationMutation,
  AutomationRun,
  AutomationSchedule,
  PresetDefinition,
} from "@workagent/contracts";
import { automationPort } from "../../features/automation/automationPort.js";
import { presetPort } from "../../features/presets/presetPort.js";
import { workspacePort } from "../../features/workspace/workspacePort.js";
import { runtimeWorkspaceId } from "./common.js";

export type RendererCronSchedule =
  | { kind: "at"; atMs: number; description: string }
  | { kind: "every"; everyMs: number; description: string }
  | { kind: "cron"; expr: string; tz?: string; description: string };

export type RendererCronAgentConfig = {
  name: string;
  is_preset?: boolean;
  assistant_id?: string;
  mode?: string;
  model_id?: string;
  model?: { provider_id: string; model: string; use_model?: string };
  config_options?: Record<string, string>;
  workspace?: string;
  skill_ids?: string[];
  mcp_ids?: string[];
  weixin_reminder_enabled?: boolean;
};

export type RendererCronJob = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: RendererCronSchedule;
  target: {
    payload: { kind: "message"; text: string };
    execution_mode?: "existing" | "new_conversation";
  };
  metadata: {
    conversation_id: string;
    conversation_title?: string;
    agent_type: string;
    created_by: "user" | "agent";
    created_at: number;
    updated_at: number;
    agent_config?: RendererCronAgentConfig;
  };
  state: {
    next_run_at_ms?: number;
    last_run_at_ms?: number;
    last_status?: "ok" | "error" | "skipped" | "missed";
    last_error?: string;
    run_count: number;
    retry_count: number;
    max_retries: number;
  };
};

export type CreateRendererCronJob = {
  name: string;
  description?: string;
  schedule: RendererCronSchedule;
  prompt?: string;
  message?: string;
  conversation_id: string;
  conversation_title?: string;
  created_by: "user" | "agent";
  execution_mode?: "existing" | "new_conversation";
  agent_config?: RendererCronAgentConfig;
};

export type UpdateRendererCronJob = {
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: RendererCronSchedule;
  target?: {
    payload?: { kind: "message"; text: string };
    execution_mode?: "existing" | "new_conversation";
  };
  metadata?: {
    conversation_title?: string;
    agent_config?: RendererCronAgentConfig;
  };
  state?: { max_retries?: number };
};

type CronEventMap = {
  created: RendererCronJob;
  updated: RendererCronJob;
  removed: { job_id: string };
  executed: {
    job_id: string;
    status: "ok" | "error" | "skipped" | "missed";
    error?: string;
  };
};

const eventListeners = {
  created: new Set<(event: CronEventMap["created"]) => void>(),
  updated: new Set<(event: CronEventMap["updated"]) => void>(),
  removed: new Set<(event: CronEventMap["removed"]) => void>(),
  executed: new Set<(event: CronEventMap["executed"]) => void>(),
};

const event = <Kind extends keyof CronEventMap>(kind: Kind) => ({
  on(listener: (value: CronEventMap[Kind]) => void) {
    eventListeners[kind].add(listener as never);
    return () => eventListeners[kind].delete(listener as never);
  },
  emit(value: CronEventMap[Kind]) {
    for (const listener of eventListeners[kind]) listener(value as never);
  },
});

const command = <Input, Output>(invoke: (input: Input) => Promise<Output>) => ({
  provider: () => {},
  invoke,
});

const dayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export const toRendererCronSchedule = (
  schedule: AutomationSchedule,
): RendererCronSchedule => {
  if (schedule.kind === "cron") {
    return {
      kind: "cron",
      expr: schedule.expression,
      tz: schedule.timezone,
      description: schedule.expression || "Manual",
    };
  }
  if (schedule.kind === "weekly") {
    const days = schedule.daysOfWeek.map((day) => dayNames[day]).join(",");
    const expression = `${schedule.minute} ${schedule.hour} * * ${days}`;
    return {
      kind: "cron",
      expr: expression,
      tz: schedule.timezone,
      description: expression,
    };
  }
  if (schedule.everyMinutes === 60) {
    return {
      kind: "cron",
      expr: "0 * * * *",
      description: "Every hour",
    };
  }
  return {
    kind: "every",
    everyMs: schedule.everyMinutes * 60_000,
    description: `Every ${schedule.everyMinutes} minutes`,
  };
};

export const toAutomationSchedule = (
  schedule: RendererCronSchedule,
): AutomationSchedule => {
  if (schedule.kind === "at")
    throw new Error("unsupported_automation_schedule:at");
  if (schedule.kind === "every") {
    const everyMinutes = schedule.everyMs / 60_000;
    if (!Number.isInteger(everyMinutes) || everyMinutes < 1)
      throw new Error("automation_interval_must_use_whole_minutes");
    return { kind: "interval", everyMinutes };
  }
  return {
    kind: "cron",
    expression: schedule.expr.trim(),
    timezone:
      schedule.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
};

const runStatus = (
  run: AutomationRun | undefined,
): RendererCronJob["state"]["last_status"] => {
  if (!run) return undefined;
  if (run.status === "succeeded") return "ok";
  if (run.status === "failed") return "error";
  if (run.status === "cancelled") return "skipped";
  return undefined;
};

const presetConfig = (
  definition: AutomationDefinition,
  preset: PresetDefinition | undefined,
): RendererCronAgentConfig => ({
  name: preset?.name ?? definition.presetId,
  assistant_id: definition.presetId,
  is_preset: true,
  mode: definition.engine,
  ...(preset?.modelId ? { model_id: preset.modelId } : {}),
  workspace: definition.workspaceId,
  skill_ids: preset?.skillIds ?? [],
  mcp_ids: preset?.mcpServerIds ?? [],
});

const toRendererCronJob = (
  definition: AutomationDefinition,
  runs: AutomationRun[],
  preset: PresetDefinition | undefined,
): RendererCronJob => {
  const latest = runs[0];
  const status = runStatus(latest);
  return {
    id: definition.id,
    name: definition.name,
    enabled: definition.enabled,
    schedule: toRendererCronSchedule(definition.schedule),
    target: {
      payload: { kind: "message", text: definition.input },
      execution_mode: definition.executionMode,
    },
    metadata: {
      conversation_id: definition.conversationId ?? "",
      agent_type: definition.engine,
      created_by: "user",
      created_at: Date.parse(definition.createdAt),
      updated_at: Date.parse(definition.updatedAt),
      agent_config: presetConfig(definition, preset),
    },
    state: {
      ...(definition.nextRunAt
        ? { next_run_at_ms: Date.parse(definition.nextRunAt) }
        : {}),
      ...(definition.lastRunAt
        ? { last_run_at_ms: Date.parse(definition.lastRunAt) }
        : {}),
      ...(status ? { last_status: status } : {}),
      ...(latest?.error ? { last_error: latest.error } : {}),
      run_count: runs.length,
      retry_count: latest ? Math.max(0, latest.attempt - 1) : 0,
      max_retries: 0,
    },
  };
};

const loadContext = async () => {
  const [definitions, presets] = await Promise.all([
    automationPort.list(),
    presetPort.list(),
  ]);
  return { definitions, presets };
};

const renderDefinition = async (
  definition: AutomationDefinition,
  presets?: PresetDefinition[],
) =>
  toRendererCronJob(
    definition,
    await automationPort.history(definition.id),
    (presets ?? (await presetPort.list())).find(
      (preset) => preset.id === definition.presetId,
    ),
  );

const resolvePreset = async (config?: RendererCronAgentConfig) => {
  const presets = await presetPort.list();
  const configuredId = config?.assistant_id;
  const preset =
    presets.find((item) => item.id === configuredId) ??
    presets.find((item) => item.name === config?.name) ??
    presets.find((item) => item.id === "builtin-general") ??
    presets.find((item) => item.enabled);
  if (!preset) throw new Error("automation_preset_not_found");
  return preset;
};

const resolveWorkspaceId = async (configured?: string) => {
  const workspaces = await workspacePort.list();
  // The renderer workspace picker returns pseudo-paths
  // (workagent-workspace:<id>\<name>); reduce them to the workspace id before
  // matching (same rule as teamAdapter).
  const configuredId = configured ? runtimeWorkspaceId(configured) : undefined;
  const selected = configuredId
    ? workspaces.find(
        (workspace) =>
          workspace.id === configuredId || workspace.name === configuredId,
      )
    : undefined;
  const workspace =
    selected ??
    workspaces.find((item) => item.name.toLowerCase() === "default") ??
    workspaces[0];
  if (!workspace) throw new Error("automation_workspace_not_found");
  return workspace.id;
};

const mutationFromCreate = async (
  input: CreateRendererCronJob,
): Promise<AutomationMutation> => {
  const [preset, workspaceId] = await Promise.all([
    resolvePreset(input.agent_config),
    resolveWorkspaceId(input.agent_config?.workspace),
  ]);
  const schedule = toAutomationSchedule(input.schedule);
  const executionMode = input.execution_mode ?? "new_conversation";
  const conversationId =
    executionMode === "existing" ? input.conversation_id.trim() : null;
  if (executionMode === "existing" && !conversationId)
    throw new Error("automation_conversation_required");
  return {
    name: input.name,
    enabled: schedule.kind !== "cron" || schedule.expression !== "",
    schedule,
    presetId: preset.id,
    engine: preset.engine,
    workspaceId,
    input: input.prompt ?? input.message ?? "",
    notificationPolicy: input.agent_config?.weixin_reminder_enabled
      ? "always"
      : "on_failure",
    executionMode,
    conversationId,
  };
};

const terminal = new Set(["succeeded", "failed", "cancelled"]);

const waitForRun = async (automationId: string, runId: string) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const run = (await automationPort.history(automationId)).find(
      (item) => item.id === runId,
    );
    if (run && terminal.has(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
};

const onJobCreated = event("created");
const onJobUpdated = event("updated");
const onJobRemoved = event("removed");
const onJobExecuted = event("executed");

const listRendererJobs = async (): Promise<RendererCronJob[]> => {
  const { definitions, presets } = await loadContext();
  return Promise.all(
    definitions.map((item) => renderDefinition(item, presets)),
  );
};

export const cronBridge = {
  listJobs: command<void, RendererCronJob[]>(listRendererJobs),
  listJobsByConversation: command<
    { conversation_id: string },
    RendererCronJob[]
  >(async ({ conversation_id }) =>
    (await listRendererJobs()).filter(
      (job) => job.metadata.conversation_id === conversation_id,
    ),
  ),
  getJob: command<{ job_id: string }, RendererCronJob | null>(
    async ({ job_id }) => {
      const definition = (await automationPort.list()).find(
        (item) => item.id === job_id,
      );
      return definition ? renderDefinition(definition) : null;
    },
  ),
  addJob: command<CreateRendererCronJob, RendererCronJob>(async (input) => {
    const created = await automationPort.create(
      await mutationFromCreate(input),
    );
    const rendered = await renderDefinition(created);
    onJobCreated.emit(rendered);
    return rendered;
  }),
  updateJob: command<
    { job_id: string; updates: UpdateRendererCronJob },
    RendererCronJob
  >(async ({ job_id, updates }) => {
    const definition = (await automationPort.list()).find(
      (item) => item.id === job_id,
    );
    if (!definition) throw new Error("automation_not_found");
    const mutation: Partial<AutomationMutation> = {};
    if (updates.name !== undefined) mutation.name = updates.name;
    if (updates.enabled !== undefined) mutation.enabled = updates.enabled;
    if (updates.schedule !== undefined) {
      mutation.schedule = toAutomationSchedule(updates.schedule);
      if (
        mutation.schedule.kind === "cron" &&
        mutation.schedule.expression === ""
      )
        mutation.enabled = false;
    }
    if (updates.target?.payload?.text !== undefined)
      mutation.input = updates.target.payload.text;
    if (updates.target?.execution_mode !== undefined) {
      mutation.executionMode = updates.target.execution_mode;
      mutation.conversationId =
        updates.target.execution_mode === "existing"
          ? definition.conversationId
          : null;
      if (mutation.executionMode === "existing" && !mutation.conversationId)
        throw new Error("automation_conversation_required");
    }
    if (updates.metadata?.agent_config) {
      const preset = await resolvePreset(updates.metadata.agent_config);
      mutation.presetId = preset.id;
      mutation.engine = preset.engine;
      mutation.workspaceId = updates.metadata.agent_config.workspace
        ? await resolveWorkspaceId(updates.metadata.agent_config.workspace)
        : definition.workspaceId;
      mutation.notificationPolicy = updates.metadata.agent_config
        .weixin_reminder_enabled
        ? "always"
        : definition.notificationPolicy;
    }
    const updated = await automationPort.update(definition, mutation);
    const rendered = await renderDefinition(updated);
    onJobUpdated.emit(rendered);
    return rendered;
  }),
  removeJob: command<{ job_id: string }, void>(async ({ job_id }) => {
    await automationPort.remove(job_id);
    onJobRemoved.emit({ job_id });
  }),
  runNow: command<{ job_id: string }, { conversation_id: string }>(
    async ({ job_id }) => {
      const pending = await automationPort.run(job_id);
      const completed = await waitForRun(job_id, pending.id);
      if (completed) {
        const status = runStatus(completed) ?? "skipped";
        onJobExecuted.emit({
          job_id,
          status,
          ...(completed.error ? { error: completed.error } : {}),
        });
        if (completed.status === "failed")
          throw new Error(completed.error ?? "automation_failed");
        if (completed.status === "cancelled")
          throw new Error("automation_cancelled");
      }
      return {
        conversation_id: completed?.sessionId ?? pending.sessionId ?? "",
      };
    },
  ),
  saveSkill: command<{ job_id: string; content: string }, void>(async () => {
    throw new Error("automation_skill_not_supported");
  }),
  hasSkill: command<{ job_id: string }, boolean>(async () => false),
  deleteSkill: command<{ job_id: string }, void>(async () => {
    throw new Error("automation_skill_not_supported");
  }),
  onJobCreated,
  onJobUpdated,
  onJobRemoved,
  onJobExecuted,
};
