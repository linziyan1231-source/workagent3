import type { Config as HarnessMcpConfig } from "@deepseek-ai/dsh-mcp-client";
import type { ResolvedMcpServer } from "../mcp-projection.js";
import { SHARED_TRASH_TOOL_TIMEOUT_MS } from "../shared-trash-client.js";

export const projectHarnessMcpServers = (
  servers: readonly ResolvedMcpServer[],
  cwd: string,
): HarnessMcpConfig[] =>
  servers.map((projection) => {
    const { server } = projection;
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(server.id))
      throw new Error(`unsupported_mcp_id:harness:${server.id}`);
    if (server.toolPolicy !== "all")
      throw new Error(`unsupported_mcp_tool_policy:${server.id}`);
    if (server.transport.kind === "sse")
      throw new Error(`unsupported_mcp_transport:harness:sse:${server.id}`);
    if (server.transport.kind === "stdio")
      return {
        transport: "stdio",
        serverName: server.id,
        command: server.transport.command,
        args: server.transport.args,
        env: projection.environment,
        cwd,
        toolCallTimeoutMs:
          server.id === "workagent-shared-trash"
            ? SHARED_TRASH_TOOL_TIMEOUT_MS
            : 60_000,
        failOnStartupError: false,
      };
    return {
      transport: "streamable-http",
      serverName: server.id,
      url: server.transport.url,
      headers: projection.headers,
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    };
  });
