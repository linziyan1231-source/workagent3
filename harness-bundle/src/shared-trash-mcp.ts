import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ResolvedMcpServer } from "./mcp-projection.js";
import {
  PlatformSharedTrashClient,
  type SharedTrashOperation,
} from "./shared-trash-client.js";

const projectPattern = /^[A-Za-z0-9_-]{1,128}$/;

/** The project is fixed by the session, never by a model-supplied argument. */
export function sharedTrashServer(projectId: string): ResolvedMcpServer {
  if (!projectPattern.test(projectId))
    throw new Error("invalid_shared_project");
  return {
    server: {
      id: "workagent-shared-trash",
      name: "当前协作项目回收站",
      source: "managed",
      enabled: true,
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: [
          join(dirname(fileURLToPath(import.meta.url)), "shared-trash-mcp.js"),
          projectId,
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
    environment: Object.fromEntries(
      [
        "WORKAGENT_PLATFORM_URL",
        "WORKAGENT_PLATFORM_TOKEN",
        "WORKAGENT_EMPLOYEE_SID",
      ].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]!]],
      ),
    ),
    headers: {},
    state: "ready",
  };
}

const tools = [
  {
    name: "shared_file_recycle",
    description:
      "删除当前协作项目的文件或文件夹时使用本工具：移入共享回收站，最多保留7天；全员共用60GB，超限按删除时间从早到晚清理。先读取最新内容再决定删除。仅文件管理和本受管工具的删除受保护，终端命令或第三方程序直接删除不进入回收站。",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "当前项目内相对路径，不接受其他项目或绝对路径",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "shared_trash_list",
    description:
      "查看当前协作项目回收站的文件、原路径和到期时间。无法查看其他项目的条目。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "shared_trash_restore",
    description:
      "将当前项目回收站条目恢复到原路径；原路径已有同名文件时拒绝恢复并保留回收站条目，不覆盖现有文件。",
    inputSchema: {
      type: "object",
      properties: {
        entryId: {
          type: "string",
          description: "shared_trash_list返回的条目ID",
        },
      },
      required: ["entryId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

export async function handleSharedTrashMcp(
  projectId: string,
  request: { method: string; params?: Record<string, unknown> },
  operate = (input: SharedTrashOperation) => {
    const client = PlatformSharedTrashClient.fromEnvironment();
    if (!client) throw new Error("shared_trash_unavailable");
    return client.operate(input);
  },
) {
  if (!projectPattern.test(projectId))
    throw new Error("invalid_shared_project");
  if (request.method === "initialize")
    return {
      protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "workagent-shared-trash", version: "1.0.0" },
    };
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools };
  if (request.method !== "tools/call") throw new Error("unsupported_method");
  const args = request.params?.arguments ?? {};
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("invalid_tool_request");
  const input = args as Record<string, unknown>;
  let operation: SharedTrashOperation;
  if (
    request.params?.name === "shared_trash_list" &&
    Object.keys(input).length === 0
  ) {
    operation = { projectId, operation: "list" };
  } else if (
    request.params?.name === "shared_file_recycle" &&
    Object.keys(input).length === 1 &&
    typeof input.path === "string" &&
    input.path.length > 0
  ) {
    const path = input.path.replaceAll("\\", "/");
    if (
      path.startsWith("/") ||
      path.includes(":") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("invalid_relative_path");
    operation = { projectId, operation: "recycle", path };
  } else if (
    request.params?.name === "shared_trash_restore" &&
    Object.keys(input).length === 1 &&
    typeof input.entryId === "string" &&
    input.entryId.length > 0
  ) {
    operation = { projectId, operation: "restore", entryId: input.entryId };
  } else throw new Error("invalid_tool_request");
  const result = await operate(operation);
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    isError: false,
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
    void handleSharedTrashMcp(process.argv[2] ?? "", request)
      .then((result) =>
        process.stdout.write(
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
        ),
      )
      .catch((error: unknown) =>
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [
                {
                  type: "text",
                  text:
                    error instanceof Error
                      ? error.message
                      : "shared_trash_failed",
                },
              ],
              isError: true,
            },
          }) + "\n",
        ),
      );
  });
}
