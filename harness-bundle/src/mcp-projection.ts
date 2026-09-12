import {
  runtimeMcpServerSchema,
  type RuntimeMcpServer,
} from "@workagent/contracts";

export type ResolvedMcpServer = {
  server: RuntimeMcpServer;
  environment: Record<string, string>;
  headers: Record<string, string>;
  state: "ready" | "needs_auth" | "unavailable";
};

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_mcp_projection");
  return value as Record<string, unknown>;
};

const secrets = (value: unknown): Record<string, string> => {
  const input = object(value);
  const result: Record<string, string> = {};
  for (const [name, secret] of Object.entries(input)) {
    if (name.length === 0 || typeof secret !== "string" || secret.length === 0)
      throw new Error("invalid_mcp_projection_secret");
    result[name] = secret;
  }
  return result;
};

const sameKeys = (
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) =>
  Object.keys(left).sort().join("\0") === Object.keys(right).sort().join("\0");

const resolvedServer = (value: unknown): ResolvedMcpServer => {
  const input = object(value);
  const server = runtimeMcpServerSchema.parse(input.server);
  const environment = secrets(input.environment);
  const headers = secrets(input.headers);
  const state = input.state;
  if (state !== "ready" && state !== "needs_auth" && state !== "unavailable")
    throw new Error("invalid_mcp_projection_state");
  if (
    state !== "ready" &&
    (Object.keys(environment).length !== 0 || Object.keys(headers).length !== 0)
  )
    throw new Error("unavailable MCP projection cannot contain credentials");
  const expectedEnvironment =
    server.transport.kind === "stdio"
      ? server.transport.environmentCredentialIds
      : {};
  const expectedHeaders =
    server.transport.kind === "stdio"
      ? {}
      : server.transport.headerCredentialIds;
  if (state === "ready" && !sameKeys(environment, expectedEnvironment))
    throw new Error(
      "resolved MCP environment does not match credential references",
    );
  if (state === "ready" && !sameKeys(headers, expectedHeaders))
    throw new Error("resolved MCP headers do not match credential references");
  return { server, environment, headers, state };
};

const projection = (value: unknown): readonly ResolvedMcpServer[] => {
  const servers = object(value).servers;
  if (!Array.isArray(servers)) throw new Error("invalid_mcp_projection");
  return servers.map(resolvedServer);
};

export class McpProjectionStore {
  nativeNames: readonly string[] = [];
  nativeConfig: Record<string, Record<string, unknown>> = {};
  readonly #servers = new Map<string, ResolvedMcpServer>();

  replace(value: unknown): void {
    const projected = projection(value);
    const names = object(value).nativeNames;
    if (
      names !== undefined &&
      (!Array.isArray(names) || names.some((name) => typeof name !== "string"))
    )
      throw new Error("invalid_native_mcp_names");
    this.nativeNames = (names ?? []) as string[];
    this.nativeConfig = (object(value).nativeConfig ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const next = new Map<string, ResolvedMcpServer>();
    for (const server of projected) {
      if (next.has(server.server.id)) throw new Error("duplicate_mcp_server");
      next.set(server.server.id, server);
    }
    this.#servers.clear();
    for (const [id, server] of next) this.#servers.set(id, server);
  }

  listServers(): readonly RuntimeMcpServer[] {
    return [...this.#servers.values()]
      .map(({ server }) => server)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getServer(id: string): RuntimeMcpServer | undefined {
    return this.#servers.get(id)?.server;
  }

  resolveServer(id: string): ResolvedMcpServer | undefined {
    return this.#servers.get(id);
  }
}
