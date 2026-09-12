import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { butlerRequest, runButler } from "./butler.js";
import type { ResolvedMcpServer } from "./mcp-projection.js";

export function butlerServer(): ResolvedMcpServer {
  const stamp = "2026-09-11T00:00:00.000Z";
  return {
    server: {
      id: "workagent-butler",
      name: "AI管家管理工具",
      source: "managed",
      enabled: true,
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: [join(dirname(fileURLToPath(import.meta.url)), "butler-mcp.js")],
        environmentCredentialIds: {},
      },
      toolPolicy: "all",
      allowedTools: [],
      oauthState: "none",
      health: "unknown",
      createdAt: stamp,
      updatedAt: stamp,
    },
    environment: process.env.DSH_HOME ? { DSH_HOME: process.env.DSH_HOME } : {},
    headers: {},
    state: "ready",
  };
}

const emptySchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
const tools = [
  {
    name: "butler_help",
    description: "查询 WorkAgent3 的真实功能用法、配置接口和字段。",
    inputSchema: emptySchema,
    annotations: { readOnlyHint: true },
  },
  {
    name: "butler_overview",
    description: "只读检查当前员工的 MCP、技能、助手和消息渠道状态；隐藏凭据。",
    inputSchema: emptySchema,
    annotations: { readOnlyHint: true },
  },
  {
    name: "butler_read",
    description: "只读查询员工配置接口，path 从 butler_help 提供的接口选择。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "butler_configure",
    description:
      "按用户已授权的目标配置助手、MCP、技能或消息渠道。先读取现状，写后读回验证。不能发聊天消息或调用管理员接口。",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["POST", "PATCH", "DELETE"] },
        path: { type: "string" },
        body: { type: "object", additionalProperties: true },
      },
      required: ["method", "path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

export async function handleButlerMcp(request: {
  method: string;
  params?: Record<string, unknown>;
}) {
  if (request.method === "initialize")
    return {
      protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "workagent-butler", version: "1.0.0" },
    };
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools };
  if (request.method !== "tools/call") throw new Error("unsupported_method");
  const name = request.params?.name;
  const input = (request.params?.arguments ?? {}) as Record<string, unknown>;
  let result: unknown;
  if (name === "butler_help") result = await runButler("help");
  else if (name === "butler_overview") result = await runButler("overview");
  else if (name === "butler_read" && typeof input.path === "string")
    result = await butlerRequest("GET", input.path);
  else if (
    name === "butler_configure" &&
    typeof input.method === "string" &&
    ["POST", "PATCH", "DELETE"].includes(input.method) &&
    typeof input.path === "string"
  )
    result = await butlerRequest(input.method, input.path, input.body);
  else throw new Error("invalid_tool_request");
  const failed =
    name === "butler_overview"
      ? Object.values(result as Record<string, { ok: boolean }>).some(
          (row) => !row.ok,
        )
      : !!result &&
        typeof result === "object" &&
        "ok" in result &&
        result.ok === false;
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    isError: failed,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    let request: {
      id?: string | number;
      method: string;
      params?: Record<string, unknown>;
    };
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (request.id === undefined) return;
    void handleButlerMcp(request)
      .then((result) =>
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
        ),
      )
      .catch(() =>
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [
                {
                  type: "text",
                  text: "管家操作失败，请检查操作路径、输入和运行状态。",
                },
              ],
              isError: true,
            },
          }) + "\n",
        ),
      );
  });
}
