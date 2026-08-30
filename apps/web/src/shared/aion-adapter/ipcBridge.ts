import type { IMcpServer, IMcpServerTransport } from "@/common/config/storage";
import type {
  RuntimeMcpMutation,
  RuntimeMcpServer,
} from "@workagent/contracts";
import { mcpPort } from "../../features/mcp/mcpPort.js";

export type IExtensionSettingsTab = { id: string; title?: string } & Record<
  string,
  unknown
>;
export type IWebUIStatus = Record<string, unknown>;
export type IGpuStatus = Record<string, unknown>;
export type IStartOnBootStatus = Record<string, unknown>;
export type PortalSharedConversation = Record<string, unknown>;
export type PortalSharedProject = Record<string, unknown>;

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

export const extensions = unavailableService;
export const webui = unavailableService;
export const assistants = unavailableService;
export const channel = unavailableService;
export const acpConversation = unavailableService;
export const dialog = unavailableService;
export const fs = unavailableService;

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

const command = <Input, Output>(invoke: (input: Input) => Promise<Output>) => ({
  provider: () => {},
  invoke,
});

const noPlaintext = (values?: Record<string, string>) => {
  if (values !== undefined && Object.keys(values).length !== 0)
    throw new Error("mcp_plaintext_credentials_unsupported");
  return {};
};

const toRuntimeTransport = (
  transport: IMcpServerTransport,
): RuntimeMcpMutation["transport"] => {
  if (transport.type === "stdio")
    return {
      kind: "stdio",
      command: transport.command,
      args: transport.args ?? [],
      environmentCredentialIds: noPlaintext(transport.env),
    };
  return {
    kind: transport.type === "streamable_http" ? "http" : transport.type,
    url: transport.url,
    headerCredentialIds: noPlaintext(transport.headers),
  };
};

const toMutation = (server: LegacyPayload): RuntimeMcpMutation => ({
  name: server.name,
  description: server.description,
  source: "user",
  enabled: true,
  transport: toRuntimeTransport(server.transport),
  toolPolicy: "all",
  allowedTools: [],
  oauthState: "none",
});

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
  createServer: command<LegacyPayload, IMcpServer>(async (input) =>
    toLegacyMcpServer(await mcpPort.create(toMutation(input))),
  ),
  importServers: command<{ servers: LegacyPayload[] }, IMcpServer[]>(
    async ({ servers }) =>
      Promise.all(
        servers.map(async (server) =>
          toLegacyMcpServer(await mcpPort.create(toMutation(server))),
        ),
      ),
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
      servers.map(async (server) =>
        toLegacyMcpServer(
          await mcpPort.create(
            toMutation({
              name: server.name,
              description: server.description,
              transport: server.transport,
              original_json: server.original_json ?? "{}",
              builtin: server.builtin,
            }),
          ),
        ),
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
    if (data.transport !== undefined)
      mutation.transport = toRuntimeTransport(data.transport);
    return toLegacyMcpServer(await mcpPort.update(id, mutation));
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
  testMcpConnection: command<IMcpServer, { success: boolean; error: string }>(
    async () => ({ success: false, error: "mcp_connection_test_unavailable" }),
  ),
  checkOAuthStatus: command<{ server_url: string }, { authenticated: boolean }>(
    async () => ({ authenticated: false }),
  ),
  loginMcpOAuth: command<
    { server_url: string },
    { success: boolean; error: string }
  >(async () => ({ success: false, error: "mcp_oauth_unavailable" })),
  logoutMcpOAuth: command<{ server_url: string }, void>(async () => undefined),
  getAuthenticatedServers: command<void, string[]>(async () => []),
};
