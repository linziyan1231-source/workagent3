import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { butlerRequest } from "./butler.js";
import type { ResolvedMcpServer } from "./mcp-projection.js";

export function publishServer(): ResolvedMcpServer {
  const stamp = "2026-09-12T00:00:00.000Z";
  return {
    server: {
      id: "workagent-app-publish",
      name: "网页发布工具",
      source: "managed",
      enabled: true,
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: [join(dirname(fileURLToPath(import.meta.url)), "publish-mcp.js")],
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

const tools = [
  {
    name: "app_publish",
    description:
      "把工作区里的网页目录发布成在线网页，返回分享链接。发布前必须先向用户确认访问范围（authenticated 仅 WorkAgent 登录用户 / token 任何人凭带密钥链接 / password 任何人凭 8 位访问密码）和有效天数（默认 5 天）。更新已发布网页时传入 appId 以保留链接。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "网页名称" },
        entry: {
          type: "string",
          description: "入口文件相对项目根目录的路径，默认 index.html；入口所在目录会被整体发布",
        },
        workspaceId: {
          type: "string",
          description:
            "入口文件所在工作区的 ID；未指定时会自动查找包含 entry 的工作区，若找不到或多个工作区都包含则报错",
        },
        access: {
          type: "string",
          enum: ["authenticated", "token", "password"],
          description: "访问范围，必须与用户确认后选择",
        },
        validDays: {
          type: "number",
          description: "有效天数，默认 5；到期后网页自动不可访问",
        },
        appId: {
          type: "string",
          description: "要更新的已发布网页 ID；不传则按名称复用或新建",
        },
      },
      required: ["name", "access"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "app_publish_list",
    description:
      "列出当前员工已发布的网页：ID、名称、分享链接、访问范围、有效期和启停状态。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

function workspaceRootFromEnv(): string | undefined {
  const home = process.env.DSH_HOME;
  if (!home) return undefined;
  // DSH_HOME is <dataRoot>/dsh-home and the workspace root is a sibling of it
  // (<dataRoot>/workspace), so only one ".." is needed.
  return join(home, "..", "workspace");
}

async function resolveWorkspaceId(entry: string, requested?: string): Promise<string> {
  if (requested) return requested;
  const root = workspaceRootFromEnv();
  if (!root) return "default";
  const candidates: string[] = [];
  const defaultEntry = join(root, ".workagent-unassigned", entry);
  if (existsSync(defaultEntry)) candidates.push("default");
  const workspaceResponse = (await butlerRequest("GET", "/v1/workspaces")) as
    | { data?: unknown }
    | undefined;
  const workspaces = workspaceResponse?.data as
    | { id?: string; directory?: string }[]
    | undefined;
  if (Array.isArray(workspaces)) {
    for (const ws of workspaces) {
      const id = ws.id;
      const dir = ws.directory;
      if (!id || !dir) continue;
      if (id === "default") continue;
      const candidateEntry = join(root, dir as string, entry);
      if (existsSync(candidateEntry)) candidates.push(id);
    }
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new Error(
      `找不到入口文件 ${entry}，请确认文件已放入工作区，或显式指定 workspaceId`,
    );
  }
  throw new Error(
    `多个工作区都包含 ${entry}（${candidates.join(", ")}），请显式指定 workspaceId`,
  );
}

export async function handlePublishMcp(request: {
  method: string;
  params?: Record<string, unknown>;
}) {
  if (request.method === "initialize")
    return {
      protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "workagent-app-publish", version: "1.0.0" },
    };
  if (request.method === "ping") return {};
  if (request.method === "tools/list") return { tools };
  if (request.method !== "tools/call") throw new Error("unsupported_method");
  const name = request.params?.name;
  const input = (request.params?.arguments ?? {}) as Record<string, unknown>;
  let result: unknown;
  if (name === "app_publish_list") result = await butlerRequest("GET", "/v1/app-publishing");
  else if (name === "app_publish") {
    const entry = typeof input.entry === "string" && input.entry ? input.entry : "index.html";
    const requestedWorkspace =
      typeof input.workspaceId === "string" && input.workspaceId ? input.workspaceId : undefined;
    const workspaceId = await resolveWorkspaceId(entry, requestedWorkspace);
    const body: Record<string, unknown> = {
      workspaceId,
      name: input.name,
      entry,
      access: input.access,
    };
    if (typeof input.validDays === "number") body.validDays = input.validDays;
    if (typeof input.appId === "string" && input.appId) body.appId = input.appId;
    result = await butlerRequest("POST", "/v1/app-publishing/publish", body);
  } else throw new Error("invalid_tool_request");
  const failed =
    !!result && typeof result === "object" && "ok" in result && result.ok === false;
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
    void handlePublishMcp(request)
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
                  text: "网页发布操作失败，请检查运行状态和输入后重试。",
                },
              ],
              isError: true,
            },
          }) + "\n",
        ),
      );
  });
}
