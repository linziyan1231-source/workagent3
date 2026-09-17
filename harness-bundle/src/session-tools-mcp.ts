import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { butlerRequest } from "./butler.js";
import type { ResolvedMcpServer } from "./mcp-projection.js";

export function sessionToolsServer(
  sessionId: string,
  scopeToken: string,
): ResolvedMcpServer {
  return {
    server: {
      id: "workagent-session-tools",
      name: "团队与定时任务",
      source: "managed",
      enabled: true,
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: [
          join(dirname(fileURLToPath(import.meta.url)), "session-tools-mcp.js"),
        ],
        environmentCredentialIds: {},
      },
      toolPolicy: "all",
      allowedTools: [],
      oauthState: "none",
      health: "unknown",
      createdAt: "2026-09-12T00:00:00.000Z",
      updatedAt: "2026-09-12T00:00:00.000Z",
    },
    environment: {
      ...(process.env.DSH_HOME ? { DSH_HOME: process.env.DSH_HOME } : {}),
      WORKAGENT_SESSION_ID: sessionId,
      WORKAGENT_SCOPE_TOKEN: scopeToken,
    },
    headers: {},
    state: "ready",
  };
}

export async function handleSessionToolsMcp(
  request: { method: string; params?: Record<string, unknown> },
  environment = process.env,
) {
  if (request.method === "initialize")
    return {
      protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "workagent-session-tools", version: "1.0.0" },
    };
  if (request.method === "ping") return {};
  if (request.method !== "tools/list" && request.method !== "tools/call")
    throw Object.assign(new Error("unsupported_method"), { code: -32601 });
  const result = await butlerRequest(
    "POST",
    "/v1/session-tools",
    {
      sessionId: environment.WORKAGENT_SESSION_ID,
      scopeToken: environment.WORKAGENT_SCOPE_TOKEN,
      method: request.method,
      name: request.params?.name,
      arguments: request.params?.arguments,
    },
    environment,
  );
  if (request.method === "tools/list") {
    if (!result.ok) throw new Error(JSON.stringify(result.data));
    return result.data;
  }
  return {
    ...(result.ok ? {} : { isError: true }),
    content: [{ type: "text", text: JSON.stringify(result.data) }],
  };
}

export async function sessionToolsResponse(request: {
  id?: unknown;
  method: string;
  params?: Record<string, unknown>;
}) {
  if (request.id === undefined) return;
  try {
    return { jsonrpc: "2.0", id: request.id, result: await handleSessionToolsMcp(request) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "tool_failed";
    return request.method === "tools/call"
      ? { jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: message }] } }
      : { jsonrpc: "2.0", id: request.id, error: { code: error instanceof Error && "code" in error ? error.code : -32603, message } };
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    let request: {
      id?: unknown;
      method: string;
      params?: Record<string, unknown>;
    };
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    const response = await sessionToolsResponse(request);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
