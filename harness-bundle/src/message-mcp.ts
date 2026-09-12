import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { butlerRequest } from "./butler.js";
import type { ResolvedMcpServer } from "./mcp-projection.js";

export function messageServer(): ResolvedMcpServer {
  const stamp = "2026-09-11T00:00:00.000Z";
  return {
    server: {
      id: "workagent-messaging",
      name: "消息渠道发送工具",
      source: "managed",
      enabled: true,
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: [join(dirname(fileURLToPath(import.meta.url)), "message-mcp.js")],
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
    name: "message_targets",
    description: "列出当前员工已连接、可以接收主动消息的微信或其他聊天。",
    inputSchema: emptySchema,
    annotations: { readOnlyHint: true },
  },
  {
    name: "message_send",
    description:
      "按用户要求向已连接聊天发送文字或项目文件。发送文件时使用项目 ID 和项目内相对路径；先用 message_targets 选择目标。若返回会话上下文已过期，引导用户从微信端给机器人发一条消息后重试。",
    inputSchema: {
      type: "object",
      properties: {
        targetId: {
          type: "string",
          description: "message_targets 返回的目标 ID",
        },
        text: { type: "string", description: "可选的文字或文件说明" },
        workspaceId: { type: "string", description: "发送文件时的项目 ID" },
        filePath: { type: "string", description: "项目内相对文件路径" },
      },
      required: ["targetId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
];

export async function handleMessageMcp(request: {
  method: string;
  params?: Record<string, unknown>;
}) {
  if (request.method === "initialize")
    return {
      protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "workagent-messaging", version: "1.0.0" },
    };
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools };
  if (request.method !== "tools/call") throw new Error("unsupported_method");
  const name = request.params?.name;
  const input = (request.params?.arguments ?? {}) as Record<string, unknown>;
  const result =
    name === "message_targets"
      ? await butlerRequest("GET", "/v1/completion-notifications/targets")
      : name === "message_send" && typeof input.targetId === "string"
        ? await butlerRequest(
            "POST",
            "/v1/completion-notifications/send",
            input,
          )
        : (() => {
            throw new Error("invalid_tool_request");
          })();
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    isError:
      !!result &&
      typeof result === "object" &&
      "ok" in result &&
      result.ok === false,
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
    void handleMessageMcp(request)
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
                  text: "消息发送失败，请检查接收聊天、渠道连接和文件路径。",
                },
              ],
              isError: true,
            },
          }) + "\n",
        ),
      );
  });
}
