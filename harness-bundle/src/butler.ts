import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const BUTLER_HELP = {
  overview:
    "AI管家管理当前员工的助手、MCP、技能和消息渠道，并根据实际状态排查问题。设置页面与管家使用同一份配置。其他员工的数据不可访问。",
  skills:
    "设置→技能：Codex 全局安装会自动登记，普通技能通过目录引用共享给兼容引擎，保留脚本和参考资料。项目技能留在项目。停用和删除登记不删除原安装。新会话生效，空闲旧会话可重新加载能力。",
  mcp: "设置→MCP 服务：查看来源、启停和测试连接。Codex 全局配置自动同步；凭据由现有凭据库保存。未知健康状态不等于连接成功。托管应用、OAuth 和引擎专用能力可能无法跨引擎共享。",
  channels:
    "设置→消息渠道：先选择渠道，再配置账号或扫码绑定，选择助手、模型、项目、权限和接收开关。扫码和第三方授权必须由用户本人完成。管家可读取状态、配置、重连、启停接收；不能替用户完成扫码。",
  assistants:
    "设置→助手：创建或复制助手，配置引擎、系统提示词及绑定能力。内置助手可以启停；需要修改时复制。管家默认使用 Codex，可复制后选择兼容引擎。",
  sessions:
    "新会话使用最新能力集合。已有会话可在空闲时重新加载能力，保留消息历史。运行中的任务不能重载。单次运行状态不能证明任务卡住，应对比状态并查看错误。",
  models:
    "设置中查看模型、授权和凭据状态。模型不可用先检查授权和连接。管家不显示密钥，不修改平台管理员控制的模型授权或额度。",
};

// The helper is an employee-local client, not a general HTTP proxy.
export function allowedButlerRequest(method: string, path: string): boolean {
  if (/[?#%\\]/.test(path) || path.includes("..")) return false;
  const id = "[A-Za-z0-9_:@.-]+";
  const rules: [string, string][] = [
    [
      "GET",
      "/v1/(system/status|models|credentials|capabilities|presets|skills|mcp-servers|workspaces|sessions|runtime-settings|capability-sync/status)",
    ],
    ["GET", `/v1/(presets|skills|sessions)/${id}`],
    ["GET", "/v1/completion-notifications/targets"],
    [
      "POST",
      "/v1/(presets|mcp-servers|credentials|imports/mcp|capability-sync/run)",
    ],
    ["PATCH", `/v1/(presets|skills|mcp-servers)/${id}`],
    ["DELETE", `/v1/(presets|skills|mcp-servers|credentials)/${id}`],
    ["POST", `/v1/mcp-servers/${id}/test`],
    ["POST", `/v1/presets/${id}/copy`],
    ["POST", `/v1/sessions/${id}/capabilities/reload`],
    ["POST", "/v1/completion-notifications/send"],
    ["GET", "/dsh-im-connect/api/(channels|assistant|projects)"],
    ["POST", "/dsh-im-connect/api/assistant"],
    [
      "POST",
      `/dsh-im-connect/api/accounts/${id}/(settings|receive|reconnect|check|remove|approve|deny)`,
    ],
    [
      "POST",
      `/dsh-im-connect/api/channels/${id}/(connect|receive|disconnect|remove)`,
    ],
    ["GET", `/dsh-im-connect/api/channels/${id}/qr/status`],
    ["POST", `/dsh-im-connect/api/channels/${id}/qr/(start|refresh|cancel)`],
  ];
  return rules.some(
    ([verb, pattern]) =>
      verb === method && new RegExp(`^${pattern}$`).test(path),
  );
}

export function redactButlerValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactButlerValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /secret|password|token|api.?key|authorization|cookie|headers|environment/i.test(
          key,
        )
          ? "[已隐藏]"
          : redactButlerValue(item),
      ]),
    );
  if (typeof value === "string")
    return value
      .replace(/(Bearer\s+)\S+/gi, "$1[已隐藏]")
      .replace(/([?&](?:key|token|secret|password)=)[^&\s]+/gi, "$1[已隐藏]");
  return value;
}

export async function butlerRequest(
  method: string,
  path: string,
  body?: unknown,
  environment = process.env,
) {
  if (!allowedButlerRequest(method, path)) throw new Error("管家不支持此操作");
  const nativeHome = environment.CODEX_HOME ?? environment.KIMI_CODE_HOME;
  const home =
    environment.DSH_HOME ??
    (nativeHome ? join(nativeHome, "..", "..", "dsh-home") : undefined);
  if (!home) throw new Error("请在 WorkAgent3 的管家会话中运行");
  const endpoint = JSON.parse(
    readFileSync(join(home, "workagent", "runtime-gateway.json"), "utf8"),
  ) as { baseURL: string; token: string };
  const token = endpoint.token;
  if (!token) throw new Error("管家配置访问尚未准备好");
  const base = new URL(endpoint.baseURL);
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    base.username ||
    base.password
  )
    throw new Error("员工运行时地址无效");
  const response = await fetch(new URL(path, base), {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-dsh-im-connect-client": "1",
      origin: base.origin,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    value = { error: "接口未返回结构化结果" };
  }
  return {
    ok: response.ok,
    status: response.status,
    data: redactButlerValue(value),
  };
}

export function butlerPrompt(): string {
  return `你是 AI管家，帮助当前员工配置、使用和诊断 WorkAgent3。用简洁中文沟通，用户要求操作时执行，不只讲步骤。
使用已绑定的 workagent-butler MCP：butler_help 查询用法与接口字段，butler_overview 读取当前状态，butler_read 按 path 查询，butler_configure 按 method/path/body 配置。先发现这些 MCP 工具再调用，overview 对应 butler_overview。不要通过终端启动脚本或读取凭据文件。
工具自动认证和隐藏密钥。不能把任何密钥、请求头或账号凭据回显到聊天；需要用户提供密钥时引导现有设置的安全输入。
先 help 了解真实接口与字段，再 overview/GET 读取状态。用户已明确要求的普通修改直接执行，未明确的目标或删除范围先问清楚。写后 GET 读回核对；失败如实报告，不能把已保存当成已连接成功。不要发送测试消息给他人，除非用户明确要求。
MCP/Skill 使用现有目录和接口，不另建安装平台。先检查新安装；项目安装不提升为全局，其他员工不可访问。修改现有记录只提交所需字段，保留用户其他配置。来源冲突不擅自覆盖。
渠道扫码/第三方授权由用户本人完成，引导到设置→消息渠道对应账号。可以准备配置和读取扫码状态，不能声称已经替用户授权。密钥需用户提供时优先引导设置中的安全输入，不要求贴到聊天。
帮助回答依据 help 的随版本说明和实时查询；无法确认的情况明确说明，不编造入口。新能力用于新会话，空闲旧会话可重载，不打断正在执行的任务。`;
}

export async function runButler(
  command?: string,
  method?: string,
  path?: string,
  bodyPath?: string,
) {
  if (command === "help")
    return {
      topics: BUTLER_HELP,
      operations: {
        read: "GET /v1/presets, /v1/skills, /v1/mcp-servers, /v1/models, /v1/credentials, /v1/system/status, /v1/sessions, /v1/workspaces, /v1/capability-sync/status; GET /dsh-im-connect/api/channels, /assistant, /projects（后两项也需完整前缀）",
        sync: "POST /v1/capability-sync/run {}",
        toggle:
          "PATCH /v1/skills/{id} 或 /v1/mcp-servers/{id}，正文 {enabled:boolean}；DELETE 同一路径删除登记",
        mcp: "POST /v1/imports/mcp 正文 {mcpServers:{服务名:{command,args,env}或{url,headers}}}；POST /v1/mcp-servers/{id}/test {}",
        assistants:
          "POST /v1/presets 或 PATCH /v1/presets/{id}：name,description,engine(codex/kimi/harness),systemPrompt,skillIds,mcpServerIds；先读现有模型和助手确定其他字段。POST /v1/presets/{id}/copy {name}",
        channelSettings:
          "POST /dsh-im-connect/api/accounts/{id}/settings：name,presetId,provider(workagent-codex/workagent-kimi/workagent-harness),model,reasoningEffort,cwd,permission(read-only/workspace-write/danger-full-access),privateAccess(approved/all)。先 GET channels 和 assistant 读取真实账号、支持字段和模型。",
        channelConnect:
          "POST /dsh-im-connect/api/channels/{channelId}/connect {config:{渠道定义所需字段},settings:{账号设置}}；字段从 GET channels 的渠道元数据读取，缺失时引导设置安全输入。POST accounts/{id}/receive {receiveEnabled:boolean}、reconnect {}、check {}，完整前缀 /dsh-im-connect/api/。扫码 GET channels/{id}/qr/status，POST channels/{id}/qr/start {}，引导用户在设置完成。",
        reload: "POST /v1/sessions/{id}/capabilities/reload {}，忙碌时不可执行",
      },
    };
  if (command === "overview")
    return Object.fromEntries(
      await Promise.all(
        [
          ["system", "/v1/system/status"],
          ["sync", "/v1/capability-sync/status"],
          ["skills", "/v1/skills"],
          ["mcp", "/v1/mcp-servers"],
          ["assistants", "/v1/presets"],
          ["channels", "/dsh-im-connect/api/channels"],
        ].map(async ([name, endpoint]) => [
          name,
          await butlerRequest("GET", endpoint!).catch(() => ({
            ok: false,
            error: "状态读取失败",
          })),
        ]),
      ),
    );
  if (command !== "request" || !method || !path)
    throw new Error("用法：help | overview | request METHOD /path [JSON文件]");
  return butlerRequest(
    method,
    path,
    bodyPath ? JSON.parse(readFileSync(bodyPath, "utf8")) : undefined,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runButler(process.argv[2], process.argv[3], process.argv[4], process.argv[5])
    .then((value) => {
      process.stdout.write(JSON.stringify(value, null, 2) + "\n");
      if (value && "ok" in value && value.ok === false) process.exitCode = 1;
    })
    .catch(() => {
      process.stderr.write(
        "管家操作失败：请检查运行状态、操作路径和输入文件。\n",
      );
      process.exitCode = 1;
    });
}
