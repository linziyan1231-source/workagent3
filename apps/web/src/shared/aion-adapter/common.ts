import { modelAccessPort } from "../../features/models/modelAccessPort.js";
import { skillPort } from "../../features/skills/skillPort.js";
import { conversationPort } from "../../features/conversation/conversationPort.js";
import { requestJson } from "../api/http.js";
import type { TChatConversation } from "@/common/config/storage";
import type { Theme } from "@/common/theme/types";
import type {
  PortalSkillMarketEntry,
  PortalUsageSummary,
} from "./ipcBridge.js";
import { getManagedAgents } from "./assistantHooks.js";

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

const conversationListListeners = new Set<
  (event: ConversationListEvent) => void
>();
const conversationExtras = new Map<string, Record<string, unknown>>();

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

export const ipcBridge = {
  theme: {
    requestCurrent: { invoke: async () => null },
    setActive: { invoke: async (_theme: unknown) => undefined },
    changed: { on: (_handler: (theme: Theme) => void) => () => undefined },
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
    getMyUsage: {
      invoke: async (): Promise<PortalUsageSummary> => ({
        as_of: new Date().toISOString(),
        providers: [],
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
    listAllSharedProjects: { invoke: async () => ({ projects: [] }) },
    listAllSharedConversations: { invoke: async () => ({ conversations: [] }) },
    setSharedProjectHidden: { invoke: async () => undefined },
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
    restartService: { invoke: async () => ({ reconnect_after_ms: 2000 }) },
    listSharedInvites: { invoke: async () => ({ invites: [] }) },
    acceptSharedInvite: { invoke: async () => ({ success: false }) },
    declineSharedInvite: { invoke: async () => ({ success: false }) },
  },
  assistants: {
    list: { invoke: async () => [] },
    setState: {
      invoke: async (_input: { id: string; enabled: boolean }) => undefined,
    },
  },
  conversation: {
    get: {
      invoke: async ({ id }: { id: string }) =>
        toRendererConversation(await conversationPort.get(id)),
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
    responseStream: { on: () => () => undefined },
    turnCompleted: { on: () => () => undefined },
  },
  team: {
    get: { invoke: async () => null },
  },
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
