import type { IMcpServer, IMcpServerTransport } from "@/common/config/storage";
import type {
  RuntimeMcpMutation,
  RuntimeMcpServer,
} from "@workagent/contracts";
import { mcpPort } from "../../features/mcp/mcpPort.js";
import { credentialPort } from "../../features/credentials/credentialPort.js";
import { conversationPort } from "../../features/conversation/conversationPort.js";
import { presetPort } from "../../features/presets/presetPort.js";
import { channelPort } from "../../features/channels/channelPort.js";
import type { Assistant } from "@/common/types/agent/assistantTypes";
export type { PortalNotification } from "../../features/notifications/notificationPort.js";

export interface IDirOrFile {
  name: string;
  fullPath: string;
  relativePath: string;
  isDir: boolean;
  isFile: boolean;
  children?: IDirOrFile[];
}

export type IExtensionSettingsTab = {
  id: string;
  title?: string;
  label: string;
  url: string;
  order: number;
  extensionName: string;
  icon?: string;
  position?: {
    relativeTo: string;
    placement: "before" | "after";
  };
};
export type IWebUIStatus = Record<string, unknown>;
export type IGpuStatus = Record<string, unknown>;
export type IStartOnBootStatus = Record<string, unknown>;
export type PortalSharedConversation = Record<string, unknown>;
export type PortalSharedProject = Record<string, unknown>;
export type PortalSkillMarketEntry = {
  id: string;
  name: string;
  description: string;
  version?: string;
  publisher: { username: string; display_name: string };
  updated_at: string;
  archive_bytes?: number;
  can_delete: boolean;
};
export type PortalUsageWindow = {
  limit_usd: number;
  used_usd: number;
  remaining_usd: number;
  reset_at: string;
};
export type PortalUsageCountWindow = {
  limit: number;
  used: number;
  reset_at: string;
};
export type PortalUsageSummary = {
  as_of: string;
  providers: Array<{
    kind: "chatgpt" | "kimi";
    daily: PortalUsageWindow;
    weekly: PortalUsageWindow;
    pro?: PortalUsageCountWindow;
  }>;
  storage?: {
    personal: { remaining_bytes: number; limit_bytes: number };
    shared: { remaining_bytes: number; limit_bytes: number };
  };
};

const unavailableCommand = {
  provider: () => {},
  invoke: async () => undefined,
  on: () => () => undefined,
  emit: () => undefined,
};
const unavailableService = new Proxy(
  {},
  { get: () => unavailableCommand },
) as Record<string, typeof unavailableCommand>;

const command = <Input, Output>(invoke: (input: Input) => Promise<Output>) => ({
  provider: () => {},
  invoke,
});

export const extensions = unavailableService;
export const webui = unavailableService;
export const assistants = {
  list: {
    provider: () => {},
    invoke: async (): Promise<Assistant[]> =>
      (await presetPort.list()).map((preset) => ({
        id: preset.id,
        source: preset.source,
        name: preset.name,
        name_i18n: {},
        description: preset.description,
        description_i18n: {},
        ...(preset.avatar === null ? {} : { avatar: preset.avatar }),
        enabled: preset.enabled,
        sort_order: 0,
        agent_id: preset.engine,
        agent: {
          type: preset.engine === "harness" ? "aionrs" : preset.engine,
          source: preset.engine === "harness" ? "internal" : "builtin",
        },
        enabled_skills: preset.skillIds,
        custom_skill_names: [],
        disabled_builtin_skills: [],
        context: preset.systemPrompt,
        context_i18n: {},
        prompts: [],
        prompts_i18n: {},
        models: preset.modelId === null ? [] : [preset.modelId],
        agent_status: "online",
        team_selectable: false,
        deletable: preset.source === "user",
      })),
  },
};

const passiveEvent = {
  on: (_listener: (value: any) => void) => () => undefined,
  emit: (_value: any) => undefined,
};

export const channel = {
  getPluginStatus: command<
    void,
    Awaited<ReturnType<typeof channelPort.statuses>>
  >(async () => channelPort.statuses()),
  enablePlugin: command<Record<string, any>, any>(async ({ plugin_id }) =>
    channelPort.toggle(plugin_id, true),
  ),
  disablePlugin: command<Record<string, any>, any>(async ({ plugin_id }) =>
    channelPort.toggle(plugin_id, false),
  ),
  testPlugin: command<Record<string, any>, any>(async ({ plugin_id }) =>
    channelPort.test(plugin_id),
  ),
  getPendingPairings: command<
    void,
    Awaited<ReturnType<typeof channelPort.pending>>
  >(async () => channelPort.pending()),
  getAuthorizedUsers: command<
    void,
    Awaited<ReturnType<typeof channelPort.authorized>>
  >(async () => channelPort.authorized()),
  approvePairing: command<{ code: string }, void>(async ({ code }) =>
    channelPort.pairing(code, "approve"),
  ),
  rejectPairing: command<{ code: string }, void>(async ({ code }) =>
    channelPort.pairing(code, "reject"),
  ),
  revokeUser: command<{ user_id: string }, void>(async ({ user_id }) =>
    channelPort.pairing(user_id, "revoke"),
  ),
  getPlatformSettings: command<
    { platform: string },
    Awaited<ReturnType<typeof channelPort.getSettings>>
  >(async ({ platform }) => channelPort.getSettings(platform)),
  setAssistantSetting: command<
    { platform: string; assistant: { assistant_id: string } },
    void
  >(async ({ platform, assistant }) =>
    channelPort.putSettings(platform, { assistant }),
  ),
  setDefaultModelSetting: command<
    { platform: string; default_model: { id: string; use_model: string } },
    void
  >(async ({ platform, default_model }) =>
    channelPort.putSettings(platform, { default_model }),
  ),
  pluginStatusChanged: passiveEvent,
  pairingRequested: passiveEvent,
  userAuthorized: passiveEvent,
};
export const acpConversation = unavailableService;
export const dialog = unavailableService;
export const fs = unavailableService;

const oauthCallbackType = "workagent:mcp-oauth";

type OAuthPopupResult = {
  code: string | null;
  state: string | null;
  error: string | null;
};

async function findMcpServerByURL(serverURL: string) {
  return (await mcpPort.list()).find(
    (server) =>
      server.transport.kind !== "stdio" && server.transport.url === serverURL,
  );
}

export function waitForMcpOAuthPopup(
  popup: Window,
  expectedState: string,
  timeoutMs = 10 * 60 * 1000,
): Promise<OAuthPopupResult> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => finish(new Error("mcp_oauth_timeout")),
      timeoutMs,
    );
    const closed = window.setInterval(() => {
      if (popup.closed) finish(new Error("mcp_oauth_window_closed"));
    }, 250);
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== popup ||
        event.data?.type !== oauthCallbackType ||
        event.data?.state !== expectedState
      ) {
        return;
      }
      finish(undefined, event.data as OAuthPopupResult);
    };
    function finish(error?: Error, result?: OAuthPopupResult) {
      window.clearTimeout(timeout);
      window.clearInterval(closed);
      window.removeEventListener("message", onMessage);
      if (error) reject(error);
      else resolve(result!);
    }
    window.addEventListener("message", onMessage);
  });
}

export type SessionMentionTarget = {
  id: string;
  name: string;
  project?: string;
  modified_at: number;
};

export const sessionMention = {
  list: {
    provider: () => {},
    invoke: async () => ({ items: [] as SessionMentionTarget[] }),
  },
};
export const shell = {
  ...unavailableService,
  openExternal: {
    ...unavailableCommand,
    invoke: async (url: string) =>
      window.open(url, "_blank", "noopener,noreferrer"),
  },
};

type LegacyPayload = Pick<
  IMcpServer,
  "name" | "description" | "transport" | "original_json" | "builtin"
>;

export const conversation = {
  confirmMessage: command(
    async (input: { confirm_key: string; msg_id: string }) => {
      await conversationPort.respond(
        input.msg_id,
        input.confirm_key.startsWith("reject") ? "reject" : "allow",
      );
      return true;
    },
  ),
};

const toRuntimeTransport = async (
  transport: IMcpServerTransport,
  serverName: string,
  createdCredentialIds: string[],
): Promise<RuntimeMcpMutation["transport"]> => {
  const references: Record<string, string> = {};
  const values = transport.type === "stdio" ? transport.env : transport.headers;
  for (const [name, secret] of Object.entries(values ?? {})) {
    const metadata = await credentialPort.create({
      kind: transport.type === "stdio" ? "mcp_env" : "mcp_header",
      label: `${serverName}: ${name}`,
      secret,
    });
    references[name] = metadata.id;
    createdCredentialIds.push(metadata.id);
  }
  if (transport.type === "stdio")
    return {
      kind: "stdio",
      command: transport.command,
      args: transport.args ?? [],
      environmentCredentialIds: references,
    };
  return {
    kind: transport.type === "streamable_http" ? "http" : transport.type,
    url: transport.url,
    headerCredentialIds: references,
  };
};

const prepareMutation = async (server: LegacyPayload) => {
  const credentialIds: string[] = [];
  try {
    const mutation: RuntimeMcpMutation = {
      name: server.name,
      description: server.description,
      source: "user",
      enabled: true,
      transport: await toRuntimeTransport(
        server.transport,
        server.name,
        credentialIds,
      ),
      toolPolicy: "all",
      allowedTools: [],
      oauthState: "none",
    };
    return { mutation, credentialIds };
  } catch (error) {
    await Promise.allSettled(credentialIds.map(credentialPort.revoke));
    throw error;
  }
};

const createLegacyServer = async (server: LegacyPayload) => {
  const prepared = await prepareMutation(server);
  try {
    return toLegacyMcpServer(await mcpPort.create(prepared.mutation));
  } catch (error) {
    await Promise.allSettled(prepared.credentialIds.map(credentialPort.revoke));
    throw error;
  }
};

const toLegacyTransport = (
  transport: RuntimeMcpServer["transport"],
): IMcpServerTransport =>
  transport.kind === "stdio"
    ? {
        type: "stdio",
        command: transport.command,
        args: transport.args,
        env: {},
      }
    : { type: transport.kind, url: transport.url, headers: {} };

export const toLegacyMcpServer = (server: RuntimeMcpServer): IMcpServer => {
  const transport = toLegacyTransport(server.transport);
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    enabled: server.enabled,
    transport,
    last_test_status:
      server.health === "healthy"
        ? "connected"
        : server.health === "unavailable"
          ? "error"
          : undefined,
    created_at: Date.parse(server.createdAt),
    updated_at: Date.parse(server.updatedAt),
    original_json: JSON.stringify(
      { mcpServers: { [server.name]: transport } },
      null,
      2,
    ),
    builtin: server.source === "managed",
  };
};

export const mcpService = {
  listServers: command<void, IMcpServer[]>(async () =>
    (await mcpPort.list()).map(toLegacyMcpServer),
  ),
  createServer: command<LegacyPayload, IMcpServer>(createLegacyServer),
  importServers: command<{ servers: LegacyPayload[] }, IMcpServer[]>(
    async ({ servers }) => Promise.all(servers.map(createLegacyServer)),
  ),
  batchImportServers: command<
    {
      servers: Array<
        Partial<IMcpServer> & Pick<IMcpServer, "name" | "transport">
      >;
    },
    IMcpServer[]
  >(async ({ servers }) =>
    Promise.all(
      servers.map((server) =>
        createLegacyServer({
          name: server.name,
          description: server.description,
          transport: server.transport,
          original_json: server.original_json ?? "{}",
          builtin: server.builtin,
        }),
      ),
    ),
  ),
  updateServer: command<
    { id: string; data: Partial<LegacyPayload> },
    IMcpServer
  >(async ({ id, data }) => {
    const mutation: Partial<RuntimeMcpMutation> = {};
    if (data.name !== undefined) mutation.name = data.name;
    if (data.description !== undefined) mutation.description = data.description;
    const credentialIds: string[] = [];
    try {
      if (data.transport !== undefined)
        mutation.transport = await toRuntimeTransport(
          data.transport,
          data.name ?? id,
          credentialIds,
        );
      return toLegacyMcpServer(await mcpPort.update(id, mutation));
    } catch (error) {
      await Promise.allSettled(credentialIds.map(credentialPort.revoke));
      throw error;
    }
  }),
  deleteServer: command<{ id: string }, void>(async ({ id }) =>
    mcpPort.remove(id),
  ),
  toggleServer: command<{ id: string }, IMcpServer>(async ({ id }) => {
    const current = (await mcpPort.list()).find((server) => server.id === id);
    if (current === undefined) throw new Error("mcp_server_not_found");
    return toLegacyMcpServer(
      await mcpPort.update(id, { enabled: !current.enabled }),
    );
  }),
  getAgentMcpConfigs: command<void, []>(async () => []),
  testMcpConnection: command<
    IMcpServer,
    {
      success: boolean;
      error: string;
      needsAuth?: boolean;
      needs_auth?: boolean;
      tools?: Array<{ name: string; description?: string }>;
    }
  >(async (server) => {
    const result = await mcpPort.test(server.id);
    const needsAuth = result.error === "mcp_needs_auth";
    return {
      success: result.success,
      error: result.error ?? "",
      needsAuth,
      needs_auth: needsAuth,
    };
  }),
  checkOAuthStatus: command<{ server_url: string }, { authenticated: boolean }>(
    async ({ server_url }) => ({
      authenticated:
        (await findMcpServerByURL(server_url))?.oauthState === "ready",
    }),
  ),
  loginMcpOAuth: command<
    { server_url: string },
    { success: boolean; error: string }
  >(async ({ server_url }) => {
    try {
      const server = await findMcpServerByURL(server_url);
      if (!server) throw new Error("mcp_server_not_found");
      const redirectUri = new URL(
        "/oauth/mcp/callback",
        window.location.origin,
      ).toString();
      const flow = await mcpPort.startOAuth(server.id, redirectUri);
      const popup = window.open(
        flow.authorizationUrl,
        "workagent-mcp-oauth",
        "popup,width=560,height=720",
      );
      if (!popup) throw new Error("mcp_oauth_popup_blocked");
      const result = await waitForMcpOAuthPopup(popup, flow.state);
      if (result.error) throw new Error(`mcp_oauth_denied:${result.error}`);
      if (!result.code || !result.state)
        throw new Error("invalid_oauth_callback");
      await mcpPort.completeOAuth(server.id, {
        flowId: flow.flowId,
        state: result.state,
        code: result.code,
      });
      return { success: true, error: "" };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "mcp_oauth_failed",
      };
    }
  }),
  logoutMcpOAuth: command<{ server_url: string }, void>(
    async ({ server_url }) => {
      const server = await findMcpServerByURL(server_url);
      if (!server) throw new Error("mcp_server_not_found");
      await mcpPort.logoutOAuth(server.id);
    },
  ),
  getAuthenticatedServers: command<void, string[]>(async () =>
    (await mcpPort.list()).flatMap((server) =>
      server.oauthState === "ready" && server.transport.kind !== "stdio"
        ? [server.transport.url]
        : [],
    ),
  ),
};
