import { modelAccessPort } from "../../features/models/modelAccessPort.js";
import { automationPort } from "../../features/automation/automationPort.js";
import { skillPort } from "../../features/skills/skillPort.js";
import { conversationPort } from "../../features/conversation/conversationPort.js";
import { presetPort } from "../../features/presets/presetPort.js";
import { notificationPort } from "../../features/notifications/notificationPort.js";
import { systemPort } from "../../features/system/systemPort.js";
import { workspacePort } from "../../features/workspace/workspacePort.js";
import { requestJson } from "../api/http.js";
import type { TChatConversation } from "@/common/config/storage";
import type { Theme } from "@/common/theme/types";
import type {
  PortalKimiDatasourceGrant,
  PortalManagedUser,
  PortalProvisionJob,
  PortalSkillMarketEntry,
  PortalUsageSummary,
} from "./ipcBridge.js";
import { getManagedAgents } from "./assistantHooks.js";
import { cronBridge } from "./cronAdapter.js";
import {
  displayConversationFilePath,
  materializeConversationFiles,
} from "./fileService.js";

const toRendererSkill = (
  skill: Awaited<ReturnType<typeof skillPort.list>>[number],
) => ({
  name: skill.name,
  description: skill.description,
  location: skill.relativePath,
  relative_location: skill.relativePath,
  is_auto_inject: false,
  is_custom: skill.source === "user" || skill.source === "market",
  source:
    skill.source === "builtin"
      ? ("builtin" as const)
      : skill.source === "managed"
        ? ("extension" as const)
        : ("custom" as const),
});

type ConversationListEvent = {
  conversation_id: string;
  action: "created" | "updated" | "deleted";
  source?: string;
};

const themeListeners = new Set<(theme: Theme) => void>();

type SharedProjectResponse = {
  id: string;
  ownerUserId: number;
  name: string;
  state: string;
  currentRole: "owner" | "member";
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
};

type SharedInviteResponse = {
  id: string;
  projectId: string;
  projectName: string;
  inviterName: string;
  status: "pending";
  createdAt: string;
  expiresAt: string;
};

const toRendererSharedProject = (project: SharedProjectResponse) => ({
  id: project.id,
  name: project.name,
  source_kind: "new" as const,
  state: project.state,
  role: project.currentRole,
  owner_name: "",
  member_count: 0,
  hidden: project.hidden,
  created_at: project.createdAt,
  updated_at: project.updatedAt,
});

const toRendererSharedInvite = (invite: SharedInviteResponse) => ({
  id: invite.id,
  project_id: invite.projectId,
  project_name: invite.projectName,
  inviter_name: invite.inviterName,
  status: invite.status,
  created_at: invite.createdAt,
  expires_at: invite.expiresAt,
});

const conversationListListeners = new Set<
  (event: ConversationListEvent) => void
>();
type RendererConfirmation<Option = unknown> = {
  title?: string;
  id: string;
  action?: string;
  description: string;
  call_id: string;
  options: Array<{ label: string; value: Option }>;
  command_type?: string;
};
type ConfirmationEvent = { conversation_id: string; id: string };
type ConfirmationAddEvent = RendererConfirmation & {
  conversation_id: string;
};
const confirmationAddListeners = new Set<
  (event: ConfirmationAddEvent) => void
>();
const confirmationRemoveListeners = new Set<
  (event: ConfirmationEvent) => void
>();
type RendererResponseMessage = {
  type: string;
  data: unknown;
  msg_id: string;
  turn_id?: string;
  conversation_id: string;
  created_at?: number;
  position?: "left" | "right" | "center" | "pop";
  status?: "finish" | "pending" | "error" | "work";
  replace?: boolean;
};
const responseStreamListeners = new Set<
  (event: RendererResponseMessage) => void
>();
const turnCompletedListeners = new Set<
  (event: { conversation_id: string; turn_id: string }) => void
>();
const runtimeSubscriptions = new Map<string, () => void>();
const conversationExtras = new Map<string, Record<string, unknown>>();

const toRendererConfirmation = (
  interaction: Awaited<ReturnType<typeof conversationPort.pending>>[number],
): RendererConfirmation<string> => ({
  id: interaction.id,
  call_id: interaction.id,
  title: interaction.tool,
  action: "exec",
  description: interaction.summary,
  command_type: interaction.tool,
  options: [
    { label: "Allow once", value: "allow_once" },
    { label: "Decline", value: "decline" },
  ],
});

const confirmationDecision = (data: unknown): "allow" | "reject" => {
  const value =
    data !== null && typeof data === "object" && "value" in data
      ? String((data as { value: unknown }).value)
      : String(data ?? "");
  return /reject|decline|cancel|deny|\bno\b/i.test(value) ? "reject" : "allow";
};

const emitResponse = (event: RendererResponseMessage) => {
  for (const listener of responseStreamListeners) listener(event);
};

const sendRendererMessage = async (input: {
  conversation_id: string;
  input: string;
  files?: string[];
}) => {
  ensureRuntimeSubscription(input.conversation_id);
  const replacements = await materializeConversationFiles(
    input.conversation_id,
    input.files ?? [],
  );
  let runtimeInput = input.input;
  let displayInput = input.input;
  for (const [stagedPath, privatePath] of replacements) {
    runtimeInput = runtimeInput.split(stagedPath).join(privatePath);
    displayInput = displayInput
      .split(stagedPath)
      .join(displayConversationFilePath(stagedPath));
  }
  const msgId = crypto.randomUUID();
  emitResponse({
    type: "user_content",
    data: displayInput,
    msg_id: msgId,
    conversation_id: input.conversation_id,
    created_at: Date.now(),
    position: "right",
  });
  await conversationPort.send(
    input.conversation_id,
    runtimeInput,
    replacements.size === 0 ? undefined : displayInput,
  );
  return {
    msg_id: msgId,
    turn_id: `pending:${msgId}`,
    runtime: { is_processing: true, turn_id: `pending:${msgId}` },
  };
};

const ensureRuntimeSubscription = (sessionId: string) => {
  if (
    runtimeSubscriptions.has(sessionId) ||
    typeof globalThis.EventSource === "undefined"
  )
    return;
  runtimeSubscriptions.set(
    sessionId,
    conversationPort.subscribe(sessionId, (event) => {
      const base = {
        conversation_id: sessionId,
        turn_id: "turnId" in event ? event.turnId : undefined,
        created_at: Date.parse(event.occurredAt),
      };
      if (event.type === "turn.started") {
        emitResponse({
          ...base,
          type: "start",
          data: null,
          msg_id: `turn:${event.turnId}`,
        });
      } else if (event.type === "assistant.delta") {
        emitResponse({
          ...base,
          type: "content",
          data: event.delta,
          msg_id: `assistant:${event.turnId}`,
          status: "pending",
        });
      } else if (event.type === "assistant.completed") {
        emitResponse({
          ...base,
          type: "content",
          data: event.content,
          msg_id: `assistant:${event.turnId}`,
          status: "finish",
          replace: true,
        });
      } else if (event.type === "turn.completed") {
        emitResponse({
          ...base,
          type: "finish",
          data: null,
          msg_id: `turn:${event.turnId}`,
        });
        for (const listener of turnCompletedListeners)
          listener({ conversation_id: sessionId, turn_id: event.turnId });
      } else if (event.type === "turn.failed") {
        emitResponse({
          ...base,
          type: "error",
          data: { code: event.code, message: event.message },
          msg_id: `error:${event.turnId}`,
        });
      } else if (event.type === "turn.cancelled") {
        emitResponse({
          ...base,
          type: "finish",
          data: null,
          msg_id: `turn:${event.turnId}`,
        });
      } else if (event.type === "approval.requested") {
        void conversationPort.pending(sessionId).then((pending) => {
          const interaction = pending.find(
            (item) => item.id === event.approvalId,
          );
          if (!interaction) return;
          const confirmation = {
            ...toRendererConfirmation(interaction),
            conversation_id: sessionId,
          };
          for (const listener of confirmationAddListeners)
            listener(confirmation);
        });
      } else if (event.type === "approval.resolved") {
        const resolved = { conversation_id: sessionId, id: event.approvalId };
        for (const listener of confirmationRemoveListeners) listener(resolved);
      }
    }),
  );
};

const toRendererConversation = (
  session: Awaited<ReturnType<typeof conversationPort.list>>[number],
): TChatConversation =>
  ({
    id: session.id,
    name: session.title,
    type: session.engine === "codex" ? "codex" : "acp",
    created_at: Date.parse(session.createdAt),
    modified_at: Date.parse(session.updatedAt),
    source: "workagent",
    status: "finished",
    extra: {
      backend: session.engine,
      workspace: session.workspaceId,
      is_project_workspace: false,
      preset_assistant_id: session.preset.presetId,
      ...(conversationExtras.get(session.id) ?? {}),
    },
  }) as TChatConversation;

const rendererWorkspacePath = (workspace: { id: string; name: string }) =>
  `workagent-workspace:${workspace.id}\\${workspace.name}`;

const runtimeWorkspaceId = (workspace: string | undefined) => {
  if (!workspace?.startsWith("workagent-workspace:"))
    return workspace || "default";
  const separator = workspace.indexOf("\\");
  return separator === -1
    ? workspace.slice("workagent-workspace:".length)
    : workspace.slice("workagent-workspace:".length, separator);
};

const createRendererConversation = async (input: {
  name?: string;
  assistant?: { id?: string };
  extra?: { workspace?: string };
}) => {
  const presetId = input.assistant?.id;
  const preset = presetId
    ? (await presetPort.list()).find((item) => item.id === presetId)
    : undefined;
  const session = await conversationPort.create({
    engine: preset?.engine ?? "harness",
    title: input.name?.trim().slice(0, 200) || "New conversation",
    workspace: runtimeWorkspaceId(input.extra?.workspace),
    ...(presetId ? { presetId } : {}),
  });
  for (const listener of conversationListListeners)
    listener({ conversation_id: session.id, action: "created" });
  return toRendererConversation(session);
};

export const ipcBridge = {
  cron: cronBridge,
  theme: {
    requestCurrent: { invoke: async () => null },
    setActive: {
      invoke: async (theme: Theme) => {
        for (const listener of themeListeners) listener(theme);
      },
    },
    changed: {
      on: (handler: (theme: Theme) => void) => {
        themeListeners.add(handler);
        return () => themeListeners.delete(handler);
      },
    },
  },
  fs: {
    listAvailableSkills: {
      invoke: async () => (await skillPort.list()).map(toRendererSkill),
    },
    listSkillImportHistory: { invoke: async () => [] },
    getSkillImportLimits: {
      invoke: async () => ({
        max_file_bytes: 50 * 1024 * 1024,
        max_total_bytes: 200 * 1024 * 1024,
      }),
    },
    importSkills: {
      invoke: async (_input: { skill_path: string }) => {
        throw new Error("browser_skill_import_requires_file_upload");
      },
    },
    deleteSkill: {
      invoke: async ({ skill_name }: { skill_name: string }) => {
        const skill = (await skillPort.list()).find(
          (entry) => entry.name === skill_name,
        );
        if (!skill) throw new Error("skill_not_found");
        await skillPort.remove(skill.id);
      },
    },
    listWorkspaceFiles: { invoke: async () => [] },
    getImageBase64: { invoke: async () => "" },
  },
  workspaceOfficeWatch: {
    start: { invoke: async () => undefined },
    stop: { invoke: async () => undefined },
    fileAdded: { on: () => () => undefined },
  },
  fileSnapshot: {
    init: {
      invoke: async () => ({ mode: "snapshot" as const, branch: null }),
    },
    dispose: { invoke: async () => undefined },
    compare: { invoke: async () => ({ staged: [], unstaged: [] }) },
    stageFile: { invoke: async () => undefined },
    stageAll: { invoke: async () => undefined },
    unstageFile: { invoke: async () => undefined },
    unstageAll: { invoke: async () => undefined },
    discardFile: { invoke: async () => undefined },
    resetFile: { invoke: async () => undefined },
    getBaselineContent: { invoke: async () => "" },
  },
  dialog: {
    showOpen: {
      invoke: async (_input?: {
        properties?: string[];
        filters?: Array<{ name: string; extensions: string[] }>;
      }) => [] as string[],
    },
  },
  extensions: {
    getMcpServers: { invoke: async () => [] },
  },
  mode: {
    listProviders: { invoke: () => modelAccessPort.providers() },
    createProvider: {
      invoke: async () => {
        throw new Error("managed_model_catalog_read_only");
      },
    },
    updateProvider: {
      invoke: async () => {
        throw new Error("managed_model_catalog_read_only");
      },
    },
    deleteProvider: {
      invoke: async () => {
        throw new Error("managed_model_catalog_read_only");
      },
    },
  },
  application: {
    systemInfo: {
      invoke: async () => ({ workDir: "", cacheDir: "", logDir: "" }),
    },
    getStartOnBootStatus: { invoke: async () => ({ success: true }) },
    getGpuStatus: { invoke: async () => ({ success: true }) },
    setGpuOverride: { invoke: async () => ({ success: false }) },
    setStartOnBoot: { invoke: async () => ({ success: false }) },
    updateSystemInfo: { invoke: async () => undefined },
    restart: { invoke: async () => ({ success: false }) },
    isDevToolsOpened: { invoke: async () => false },
    openDevTools: { invoke: async () => false },
    getCdpStatus: { invoke: async () => ({ success: false }) },
    updateCdpConfig: { invoke: async () => ({ success: false }) },
    devToolsStateChanged: { on: () => () => undefined },
    logStream: { on: () => () => undefined },
    writeRendererLog: { invoke: async () => undefined },
    getZoomFactor: { invoke: async () => 1 },
    setZoomFactor: {
      invoke: async ({ factor }: { factor: number }) => factor,
    },
  },
  systemSettings: {
    getCloseToTray: { invoke: async () => false },
    setCloseToTray: { invoke: async () => undefined },
  },
  portal: {
    getSystemStatus: { invoke: systemPort.status },
    downloadDiagnostics: {
      invoke: async () => window.location.assign(systemPort.diagnosticsUrl),
    },
    getNotifications: { invoke: notificationPort.list },
    acknowledgeNotification: {
      invoke: ({ id }: { id: string }) => notificationPort.acknowledge(id),
    },
    getMyUsage: {
      invoke: async (): Promise<PortalUsageSummary> => ({
        as_of: new Date().toISOString(),
        providers: [],
      }),
    },
    listProjects: {
      invoke: async () => ({
        projects: (await workspacePort.list()).map((workspace) => ({
          project_id: workspace.id,
          name: workspace.name,
        })),
      }),
    },
    createProject: {
      invoke: async ({ name }: { name: string }) => {
        const workspace = await workspacePort.create(name);
        return { path: rendererWorkspacePath(workspace) };
      },
    },
    listManagedUsers: {
      invoke: async () =>
        requestJson<{
          success: boolean;
          users: PortalManagedUser[];
          kimi_datasource_sources?: string[];
        }>("/api/portal/admin/users"),
    },
    addManagedUser: {
      invoke: async (input: { username: string; portal_password: string }) =>
        requestJson<{ success: boolean; job: PortalProvisionJob }>(
          "/api/portal/admin/users",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          },
        ),
    },
    getManagedUserJob: {
      invoke: async ({ id }: { id: string }) =>
        requestJson<{ success: boolean; job: PortalProvisionJob }>(
          `/api/portal/admin/user-jobs?id=${encodeURIComponent(id)}`,
        ),
    },
    getManagedUsersUsage: {
      invoke: async () =>
        requestJson<{
          success: boolean;
          users: Array<{
            username: string;
            resource_usage?: PortalUsageSummary;
            resource_usage_unavailable?: boolean;
          }>;
        }>("/api/portal/admin/users/usage"),
    },
    disableManagedUser: {
      invoke: (input: { username: string }) =>
        requestJson<{ success: boolean }>("/api/portal/admin/users/disable", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
    },
    enableManagedUser: {
      invoke: (input: { username: string }) =>
        requestJson<{ success: boolean }>("/api/portal/admin/users/enable", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
    },
    resetManagedUserPassword: {
      invoke: (input: { username: string; portal_password: string }) =>
        requestJson<{ success: boolean }>(
          "/api/portal/admin/users/reset-password",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          },
        ),
    },
    repairManagedUser: {
      invoke: (input: { username: string; windows_password: string }) =>
        requestJson<{ success: boolean }>("/api/portal/admin/users/repair", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
    },
    renameManagedWindowsAccount: {
      invoke: (input: {
        username: string;
        new_windows_username: string;
        windows_password: string;
      }) =>
        requestJson<{ success: boolean }>(
          "/api/portal/admin/users/rename-windows",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          },
        ),
    },
    setManagedUserLimits: {
      invoke: (input: {
        username: string;
        limits: {
          memory_bytes: number;
          cpu_percent: number;
          active_processes: number;
        };
      }) =>
        requestJson<{ success: boolean }>(
          "/api/portal/admin/users/set-limits",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          },
        ),
    },
    offboardManagedUserRetainingData: {
      invoke: (input: { username: string }) =>
        requestJson<{ success: boolean }>(
          "/api/portal/admin/users/offboard-retain",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          },
        ),
    },
    deleteOffboardedManagedUser: {
      invoke: (input: { username: string; confirmation: string }) =>
        requestJson<{ success: boolean }>(
          "/api/portal/admin/users/offboard-delete",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          },
        ),
    },
    setManagedUserKimiDatasource: {
      invoke: (input: {
        username: string;
        enabled: boolean;
        allowed_sources: string[];
        daily_limit: number;
        monthly_limit: number;
      }) =>
        requestJson<{
          success: boolean;
          kimi_datasource: PortalKimiDatasourceGrant;
        }>("/api/portal/admin/users/kimi-datasource", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
    },
    listSkillMarket: {
      invoke: async () =>
        requestJson<{ success: boolean; skills: PortalSkillMarketEntry[] }>(
          "/api/portal/skill-market",
        ),
    },
    publishSkill: {
      invoke: async (input: { skill_name: string }) =>
        requestJson("/api/portal/skill-market", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
    },
    installMarketSkill: {
      invoke: async (input: { id: string }) =>
        requestJson("/api/portal/skill-market/install", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
    },
    deleteMarketSkill: {
      invoke: async (input: { id: string }) =>
        requestJson(
          `/api/portal/skill-market?id=${encodeURIComponent(input.id)}`,
          { method: "DELETE" },
        ),
    },
    listSharedProjects: {
      invoke: async () => {
        const result = await requestJson<{ projects: SharedProjectResponse[] }>(
          "/api/portal/shared-projects",
        );
        return { projects: result.projects.map(toRendererSharedProject) };
      },
    },
    listAllSharedProjects: {
      invoke: async () => {
        const result = await requestJson<{ projects: SharedProjectResponse[] }>(
          "/api/portal/shared-projects?include_hidden=true",
        );
        return { projects: result.projects.map(toRendererSharedProject) };
      },
    },
    listAllSharedConversations: { invoke: async () => ({ conversations: [] }) },
    setSharedProjectHidden: {
      invoke: async (input: { project_id: string; hidden: boolean }) => {
        await requestJson<void>(
          `/api/portal/shared-projects/${encodeURIComponent(input.project_id)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ hidden: input.hidden }),
          },
        );
        return { success: true };
      },
    },
    setSharedConversationHidden: { invoke: async () => undefined },
    updateProfile: {
      invoke: async (input: {
        display_name: string;
        collaboration_enabled: boolean;
      }) =>
        requestJson("/api/portal/me/profile", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
    },
    restartService: { invoke: systemPort.restartRuntime },
    listSharedInvites: {
      invoke: async () => {
        const result = await requestJson<{ invites: SharedInviteResponse[] }>(
          "/api/portal/shared-invites",
        );
        return { invites: result.invites.map(toRendererSharedInvite) };
      },
    },
    acceptSharedInvite: {
      invoke: async (input: { invite_id: string }) => {
        await requestJson(
          `/api/portal/shared-invites/${encodeURIComponent(input.invite_id)}/accept`,
          { method: "POST" },
        );
        return { success: true };
      },
    },
    declineSharedInvite: {
      invoke: async (input: { invite_id: string }) => {
        await requestJson<void>(
          `/api/portal/shared-invites/${encodeURIComponent(input.invite_id)}/decline`,
          { method: "POST" },
        );
        return { success: true };
      },
    },
  },
  assistants: {
    list: {
      invoke: async () =>
        (await presetPort.list()).map((preset) => ({
          id: preset.id,
          source: preset.source,
          name: preset.name,
          name_i18n: {},
          description: preset.description,
          description_i18n: {},
          ...(preset.avatar ? { avatar: preset.avatar } : {}),
          enabled: preset.enabled,
          sort_order: 0,
          agent_id: preset.engine,
          agent: {
            type: preset.engine === "harness" ? "aionrs" : preset.engine,
            source:
              preset.engine === "harness"
                ? ("internal" as const)
                : ("builtin" as const),
          },
          enabled_skills: preset.skillIds,
          custom_skill_names: [],
          disabled_builtin_skills: [],
          context: preset.systemPrompt,
          context_i18n: {},
          prompts: [],
          prompts_i18n: {},
          models: preset.modelId ? [preset.modelId] : [],
          agent_status: "online" as const,
          team_selectable: false,
          deletable: preset.source === "user",
        })),
    },
    setState: {
      invoke: async (input: { id: string; enabled: boolean }) => {
        await presetPort.update(input.id, { enabled: input.enabled });
      },
    },
  },
  conversation: {
    listByCronJob: {
      invoke: async ({ cron_job_id }: { cron_job_id: string }) => {
        const runs = await automationPort.history(cron_job_id);
        const sessionIds = [
          ...new Set(
            runs
              .map((run) => run.sessionId)
              .filter((id): id is string => id !== null),
          ),
        ];
        return Promise.all(
          sessionIds.map(async (id) => {
            conversationExtras.set(id, {
              ...(conversationExtras.get(id) ?? {}),
              cron_job_id,
              cronJobId: cron_job_id,
            });
            return toRendererConversation(await conversationPort.get(id));
          }),
        );
      },
    },
    create: { invoke: createRendererConversation },
    createWithConversation: {
      invoke: async ({ conversation }: { conversation: TChatConversation }) =>
        createRendererConversation({
          name: conversation.name,
          assistant: {
            id: String(conversation.extra?.preset_assistant_id ?? ""),
          },
          extra: { workspace: String(conversation.extra?.workspace ?? "") },
        }),
    },
    get: {
      invoke: async ({ id }: { id: string }) => {
        ensureRuntimeSubscription(id);
        return toRendererConversation(await conversationPort.get(id));
      },
    },
    update: {
      invoke: async ({
        id,
        updates,
        merge_extra,
      }: {
        id: string;
        updates: { name?: string; extra?: Record<string, unknown> };
        merge_extra?: boolean;
      }) => {
        if (updates.name !== undefined)
          await conversationPort.rename(id, updates.name);
        if (updates.extra !== undefined) {
          conversationExtras.set(
            id,
            merge_extra
              ? { ...(conversationExtras.get(id) ?? {}), ...updates.extra }
              : updates.extra,
          );
        }
        for (const listener of conversationListListeners)
          listener({ conversation_id: id, action: "updated" });
        return true;
      },
    },
    remove: {
      invoke: async ({ id }: { id: string }) => {
        await conversationPort.remove(id);
        runtimeSubscriptions.get(id)?.();
        runtimeSubscriptions.delete(id);
        conversationExtras.delete(id);
        for (const listener of conversationListListeners)
          listener({ conversation_id: id, action: "deleted" });
        return true;
      },
    },
    listChanged: {
      emit: (event: ConversationListEvent) => {
        for (const listener of conversationListListeners) listener(event);
      },
      on: (listener: (event: ConversationListEvent) => void) => {
        conversationListListeners.add(listener);
        return () => conversationListListeners.delete(listener);
      },
    },
    confirmation: {
      list: {
        invoke: async ({ conversation_id }: { conversation_id: string }) => {
          ensureRuntimeSubscription(conversation_id);
          return (await conversationPort.pending(conversation_id)).map(
            toRendererConfirmation,
          );
        },
      },
      confirm: {
        invoke: async (input: {
          conversation_id: string;
          msg_id: string;
          data: unknown;
          call_id: string;
          always_allow?: boolean;
        }) => {
          await conversationPort.respond(
            input.call_id,
            confirmationDecision(input.data),
          );
          const event = {
            conversation_id: input.conversation_id,
            id: input.call_id,
          };
          for (const listener of confirmationRemoveListeners) listener(event);
        },
      },
      add: {
        emit: (event: ConfirmationAddEvent) => {
          for (const listener of confirmationAddListeners) listener(event);
        },
        on: (listener: (event: ConfirmationAddEvent) => void) => {
          confirmationAddListeners.add(listener);
          return () => confirmationAddListeners.delete(listener);
        },
      },
      update: { on: () => () => undefined },
      remove: {
        emit: (event: ConfirmationEvent) => {
          for (const listener of confirmationRemoveListeners) listener(event);
        },
        on: (listener: (event: ConfirmationEvent) => void) => {
          confirmationRemoveListeners.add(listener);
          return () => confirmationRemoveListeners.delete(listener);
        },
      },
    },
    sendMessage: {
      invoke: sendRendererMessage,
    },
    stop: {
      invoke: async ({ conversation_id }: { conversation_id: string }) => {
        await conversationPort.cancel(conversation_id);
        return { runtime: { is_processing: false, turn_id: null } };
      },
    },
    ensureRuntime: {
      invoke: async ({ conversation_id }: { conversation_id: string }) => {
        ensureRuntimeSubscription(conversation_id);
        return { is_processing: false, turn_id: null };
      },
    },
    activeLease: { invoke: async () => null },
    getAssociateConversation: { invoke: async () => null },
    getSlashCommands: { invoke: async () => [] },
    listArtifacts: { invoke: async () => [] },
    artifactStream: { on: () => () => undefined },
    getWorkspace: {
      invoke: async ({
        workspace,
        path,
        search,
      }: {
        conversation_id: string;
        workspace: string;
        path: string;
        search?: string;
      }) => {
        const normalizedPath = path.replaceAll("\\", "/");
        const normalizedWorkspace = workspace.replaceAll("\\", "/");
        const relativePath =
          normalizedPath === normalizedWorkspace || normalizedPath === ""
            ? ""
            : normalizedPath.startsWith(`${normalizedWorkspace}/`)
              ? normalizedPath.slice(normalizedWorkspace.length + 1)
              : normalizedPath;
        const entries = (await workspacePort.files(workspace, relativePath))
          .filter(
            (entry) =>
              !search ||
              entry.name
                .toLocaleLowerCase()
                .includes(search.toLocaleLowerCase()),
          )
          .map((entry) => ({
            name: entry.name,
            fullPath: `${workspace}/${entry.path}`,
            relativePath: entry.path,
            isDir: entry.kind === "directory",
            isFile: entry.kind === "file",
          }));
        const name = relativePath.split("/").pop() || workspace;
        return [
          {
            name,
            fullPath: relativePath ? `${workspace}/${relativePath}` : workspace,
            relativePath,
            isDir: true,
            isFile: false,
            children: entries,
          },
        ];
      },
    },
    responseSearchWorkSpace: { provider: () => () => undefined },
    responseStream: {
      emit: emitResponse,
      on: (listener: (event: RendererResponseMessage) => void) => {
        responseStreamListeners.add(listener);
        return () => responseStreamListeners.delete(listener);
      },
    },
    turnCompleted: {
      on: (
        listener: (event: { conversation_id: string; turn_id: string }) => void,
      ) => {
        turnCompletedListeners.add(listener);
        return () => turnCompletedListeners.delete(listener);
      },
    },
  },
  team: new Proxy(
    {
      get: { invoke: async () => null },
      list: { invoke: async () => [] },
    },
    {
      get: (target, key) => {
        if (key in target) return target[key as keyof typeof target];
        return {
          invoke: async () => undefined,
          on: () => () => undefined,
          emit: () => undefined,
        };
      },
    },
  ),
  task: {
    stopAll: { invoke: async () => ({ success: false }) },
  },
  database: {
    conversations: { invoke: async () => [] },
    getUserConversations: {
      invoke: async (_input: { limit: number }) => ({
        items: (await conversationPort.list()).map(toRendererConversation),
      }),
    },
    searchConversationMessages: {
      invoke: async () => ({ items: [], next_cursor: null }),
    },
  },
  windowControls: {
    getState: { invoke: async () => ({ is_maximized: false }) },
    stateChanged: { on: () => () => undefined },
    maximizedChanged: { on: () => () => undefined },
    minimize: { invoke: async () => undefined },
    maximize: { invoke: async () => undefined },
    unmaximize: { invoke: async () => undefined },
    close: { invoke: async () => undefined },
  },
  shell: {
    openExternal: {
      invoke: async (url: string) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
  },
  acpConversation: new Proxy(
    {
      sendMessage: {
        invoke: sendRendererMessage,
      },
      responseStream: {
        emit: emitResponse,
        on: (listener: (event: RendererResponseMessage) => void) => {
          responseStreamListeners.add(listener);
          return () => responseStreamListeners.delete(listener);
        },
      },
      getManagedAgents: { invoke: getManagedAgents },
      checkManagedAgentHealthById: {
        invoke: async ({ id }: { id: string }) => {
          const agent = (await getManagedAgents()).find(
            (item) => item.id === id,
          );
          if (!agent) throw new Error("engine_not_found");
          return agent;
        },
      },
    },
    {
      get: (target, key) => {
        if (key in target) return target[key as keyof typeof target];
        return {
          invoke: async () => {
            if (key === "checkProviderHealth") {
              return {
                status: "unknown",
                message: "managed_health_status_only",
                elapsed_ms: 0,
              };
            }
            throw new Error(`unsupported_browser_agent_command:${String(key)}`);
          },
          on: () => () => undefined,
          emit: () => undefined,
        };
      },
    },
  ),
};
