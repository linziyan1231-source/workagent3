import { codexApprovalChoices } from "./approval-options.js";
import {
  nativeJson,
  NativeApprovalWaits,
  type EngineSessionOptions,
} from "./types.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { nativeEngineEnvironment } from "./environment.js";
import { JsonLineRpc } from "./jsonl-rpc.js";
import type {
  BridgeEvent,
  BridgeSession,
  EngineBridge,
  NativeEngineStatus,
} from "./types.js";
import type { ResolvedMcpServer } from "../mcp-projection.js";
import { SHARED_TRASH_TOOL_TIMEOUT_MS } from "../shared-trash-client.js";
import { withSkillCatalog } from "./skills.js";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";

type ObjectValue = Record<string, unknown>;
type ThreadResponse = { thread: { id: string } };
type TurnResponse = { turn: { id: string } };
type AccountResponse = {
  account: { type?: string } | null;
  requiresOpenaiAuth: boolean;
};

export const codexAccountStatus = (
  result: AccountResponse,
): NativeEngineStatus => {
  if (result.requiresOpenaiAuth && result.account === null) {
    return {
      available: true,
      authenticated: false,
      state: "needs_auth",
      detail: "Sign in with the native Codex CLI to use this engine.",
    };
  }
  return {
    available: true,
    authenticated: result.account !== null || !result.requiresOpenaiAuth,
    state: "ready",
    detail:
      result.account?.type === undefined
        ? "Native Codex is ready."
        : `Native Codex is ready (${result.account.type}).`,
  };
};

const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;

const text = (value: unknown, key: string): string | undefined => {
  const candidate = object(value)?.[key];
  return typeof candidate === "string" ? candidate : undefined;
};

export const codexPermissions = (
  mode: import("./types.js").EngineSessionOptions["permissionMode"],
  policy?: EngineSessionOptions["approvalPolicy"],
) => {
  const approvalPolicy = policy === "never" ? "never" : "on-request";
  if (mode === "read_only") {
    return { approvalPolicy, sandbox: "read-only" } as const;
  }
  if (mode === "full_access") {
    return { approvalPolicy: "never", sandbox: "danger-full-access" } as const;
  }
  return {
    approvalPolicy: policy
      ? approvalPolicy
      : mode === "workspace_write"
        ? "on-request"
        : "never",
    sandbox: "workspace-write",
  } as const;
};

const codexModel = (modelId: string | undefined): string | undefined =>
  modelId === "codex-native" ? undefined : modelId;

const availableCodexModels = new Set([
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

export class CodexBridge implements EngineBridge {
  readonly id = "codex" as const;
  readonly #binary: string;
  readonly #sessions = new Map<string, CodexSession>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #rpc: JsonLineRpc | undefined;
  #starting: Promise<JsonLineRpc> | undefined;

  constructor(binary = process.env.WORKAGENT_CODEX_BIN ?? "codex") {
    this.#binary = binary;
  }

  async listModels(): Promise<import("./types.js").EngineModel[]> {
    const rpc = await this.#connection();
    const models: import("./types.js").EngineModel[] = [];
    let cursor: string | null = null;
    do {
      const page: {
        data: Array<{
          model: string;
          displayName: string;
          isDefault: boolean;
          defaultReasoningEffort?: string;
          supportedReasoningEfforts: Array<{
            reasoningEffort: string;
            description: string;
          }>;
        }>;
        nextCursor: string | null;
      } = await rpc.request("model/list", {
        limit: 100,
        includeHidden: false,
        cursor,
      });
      models.push(
        ...page.data
          .filter((model) => availableCodexModels.has(model.model))
          .map((model) => ({
            id: model.model,
            name: model.displayName,
            isDefault: model.isDefault,
            reasoning: model.supportedReasoningEfforts
              .filter((effort) => effort.reasoningEffort !== "ultra")
              .map((effort) => ({
                id: effort.reasoningEffort,
                name: effort.reasoningEffort,
              })),
            ...(model.defaultReasoningEffort
              ? {
                  defaultReasoning:
                    model.defaultReasoningEffort === "ultra"
                      ? "max"
                      : model.defaultReasoningEffort,
                }
              : {}),
          })),
      );
      cursor = page.nextCursor;
    } while (cursor);
    return models;
  }

  async create(
    workspace: string,
    onEvent: (event: BridgeEvent) => void,
    options?: import("./types.js").EngineSessionOptions,
  ): Promise<BridgeSession> {
    const rpc = await this.#connection();
    const modelId = codexModel(options?.modelId);
    await this.#configureSkillRoots(rpc, options);
    const result = await rpc.request<ThreadResponse>("thread/start", {
      cwd: workspace,
      ...(modelId === undefined ? {} : { model: modelId }),
      ...codexPermissions(options?.permissionMode, options?.approvalPolicy),
      serviceName: "workagent3",
      config: {
        ...codexCapabilityConfig(options, workspace),
      },
    });
    const session = new CodexSession(
      rpc,
      result.thread.id,
      onEvent,
      () => {
        this.#sessions.delete(result.thread.id);
      },
      modelId,
      options?.thinkingEffort,
      options,
    );
    this.#sessions.set(result.thread.id, session);
    return withSkillCatalog(session, options);
  }

  async resume(
    nativeId: string,
    workspace: string,
    onEvent: (event: BridgeEvent) => void,
    options?: import("./types.js").EngineSessionOptions,
  ): Promise<BridgeSession> {
    const rpc = await this.#connection();
    const modelId = codexModel(options?.modelId);
    await this.#configureSkillRoots(rpc, options);
    await rpc.request("thread/resume", {
      threadId: nativeId,
      cwd: workspace,
      ...codexPermissions(options?.permissionMode, options?.approvalPolicy),
      config: {
        ...codexCapabilityConfig(options, workspace),
      },
    });
    const session = new CodexSession(
      rpc,
      nativeId,
      onEvent,
      () => {
        this.#sessions.delete(nativeId);
      },
      modelId,
      options?.thinkingEffort,
      options,
    );
    this.#sessions.set(nativeId, session);
    return withSkillCatalog(session, options);
  }

  async fork(
    nativeId: string,
    workspace: string,
    onEvent: (event: BridgeEvent) => void,
    options: import("./types.js").EngineSessionOptions | undefined,
    lastTurnId?: string,
  ): Promise<BridgeSession> {
    const rpc = await this.#connection();
    const modelId = codexModel(options?.modelId);
    await this.#configureSkillRoots(rpc, options);
    const result = await rpc.request<ThreadResponse>("thread/fork", {
      threadId: nativeId,
      ...(lastTurnId === undefined ? {} : { lastTurnId }),
      cwd: workspace,
      ...(modelId === undefined ? {} : { model: modelId }),
      ...codexPermissions(options?.permissionMode, options?.approvalPolicy),
      config: {
        ...codexCapabilityConfig(options, workspace),
      },
    });
    const session = new CodexSession(
      rpc,
      result.thread.id,
      onEvent,
      () => this.#sessions.delete(result.thread.id),
      modelId,
      options?.thinkingEffort,
      options,
    );
    this.#sessions.set(result.thread.id, session);
    return withSkillCatalog(session, options);
  }

  async probe(): Promise<void> {
    await this.#connection();
  }

  async status(): Promise<NativeEngineStatus> {
    try {
      const rpc = await this.#connection();
      const result = await rpc.request<AccountResponse>("account/read", {
        refreshToken: false,
      });
      return codexAccountStatus(result);
    } catch {
      return {
        available: false,
        authenticated: null,
        state: "unavailable",
        detail: "The native Codex app-server could not be reached.",
      };
    }
  }

  async close(): Promise<void> {
    for (const session of this.#sessions.values()) session.disconnected();
    this.#rpc?.close();
    this.#child?.kill();
    this.#rpc = undefined;
    this.#child = undefined;
    this.#starting = undefined;
    this.#sessions.clear();
  }

  async #configureSkillRoots(
    rpc: JsonLineRpc,
    options?: EngineSessionOptions,
  ): Promise<void> {
    if (!options?.catalogSkills?.length) return;
    await rpc.request("skills/extraRoots/set", {
      extraRoots: [
        ...new Set(options.catalogSkills.map((skill) => skill.root)),
      ],
    });
  }

  async #connection(): Promise<JsonLineRpc> {
    if (this.#rpc !== undefined) return this.#rpc;
    this.#starting ??= this.#start().catch((error: unknown) => {
      this.#starting = undefined;
      throw error;
    });
    return this.#starting;
  }

  async #start(): Promise<JsonLineRpc> {
    if (process.env.CODEX_HOME === undefined)
      throw new Error("CODEX_HOME is required for the native Codex engine");
    const child = spawn(this.#binary, ["app-server", "--listen", "stdio://"], {
      env: nativeEngineEnvironment(process.env, "CODEX_HOME"),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    const rpc = new JsonLineRpc(child.stdout, child.stdin);
    child.stderr.resume();
    child.stdout.once("close", () => {
      for (const session of this.#sessions.values()) session.disconnected();
    });
    child.once("error", (error) => {
      rpc.close(error);
      for (const session of this.#sessions.values()) session.disconnected();
    });
    child.once("exit", (code) => {
      rpc.close(
        new Error(`Codex app-server exited with ${code ?? "no status"}`),
      );
      for (const session of this.#sessions.values()) session.disconnected();
      this.#sessions.clear();
      this.#rpc = undefined;
      this.#child = undefined;
      this.#starting = undefined;
    });
    rpc.onRequest((id, method, params) => {
      if (
        method !== "item/commandExecution/requestApproval" &&
        method !== "item/fileChange/requestApproval"
      ) {
        child.stdin.write(
          `${JSON.stringify({ id, error: { code: -32601, message: "Unsupported server request" } })}\n`,
        );
        return;
      }
      const data = object(params) ?? {};
      const session = this.#sessions.get(text(data, "threadId") ?? "");
      void (
        session?.requestApproval(method, data) ??
        Promise.resolve({ decision: "cancel" })
      ).then((result) => rpc.respond(id, result));
    });
    rpc.onNotification((method, params) => this.#notification(method, params));
    await rpc.request("initialize", {
      clientInfo: {
        name: "workagent3",
        title: "WorkAgent",
        version: "0.1.0",
      },
    });
    rpc.notify("initialized", {});
    this.#rpc = rpc;
    return rpc;
  }

  #notification(method: string, params: unknown): void {
    const values = object(params);
    const threadId = text(values, "threadId");
    if (threadId === undefined) return;
    const session = this.#sessions.get(threadId);
    session?.notification(method, values ?? {});
  }
}

export function codexCapabilityConfig(
  options?: EngineSessionOptions,
  workspace?: string,
) {
  const projectServers = new Map<string, Record<string, unknown>>();
  if (workspace) {
    let directory = workspace;
    while (true) {
      const config = join(directory, ".codex", "config.toml");
      if (existsSync(config)) {
        const parsed = parseToml(readFileSync(config, "utf8"));
        for (const [name, server] of Object.entries(parsed.mcp_servers ?? {}))
          if (!projectServers.has(name))
            projectServers.set(name, {
              ...(server as Record<string, unknown>),
              required: false,
            });
      }
      const parent = dirname(directory);
      if (parent === directory || existsSync(join(directory, ".git"))) break;
      directory = parent;
    }
  }
  const selected = new Set(options?.skills?.map((skill) => skill.entry.id));
  return {
    mcp_servers: {
      ...Object.fromEntries(
        Object.entries(options?.nativeMcpConfig ?? {})
          .filter(([name]) => !projectServers.has(name))
          .map(([name, config]) => [name, { ...config, required: false }]),
      ),
      ...Object.fromEntries(projectServers),
      ...projectCodexMcpServers(
        (options?.mcpServers ?? []).filter(
          ({ server }) =>
            !server.transport.globalSource ||
            !projectServers.has(server.transport.nativeName ?? ""),
        ),
      ),
    },
    ...(options?.catalogSkills
      ? {
          skills: {
            config: [
              ...(options.nativeSkillPaths ?? [])
                .filter(
                  (path) =>
                    !options.catalogSkills!.some(
                      (skill) =>
                        join(skill.entry.referenceDirectory!, "SKILL.md") ===
                        path,
                    ),
                )
                .map((path) => ({ path, enabled: false })),
              ...options.catalogSkills.map((skill) => ({
                path: join(skill.entry.referenceDirectory!, "SKILL.md"),
                enabled: selected.has(skill.entry.id),
              })),
            ],
          },
        }
      : {}),
  };
}

export const projectCodexMcpServers = (
  servers: readonly ResolvedMcpServer[],
): Record<string, Record<string, unknown>> =>
  Object.fromEntries(
    servers.map((projection) => {
      const { server } = projection;
      const policy =
        server.toolPolicy === "all"
          ? {}
          : { enabled_tools: server.allowedTools };
      if (server.transport.kind === "stdio")
        return [
          server.transport.nativeName ?? server.id,
          {
            command: server.transport.command,
            args: server.transport.args,
            env: projection.environment,
            ...(server.id === "workagent-shared-trash"
              ? { tool_timeout_sec: SHARED_TRASH_TOOL_TIMEOUT_MS / 1000 }
              : {}),
            ...(server.transport.globalSource ? { enabled: true } : {}),
            required: false,
            ...policy,
          },
        ];
      if (server.transport.kind === "sse")
        throw new Error(`unsupported_mcp_transport:codex:sse:${server.id}`);
      return [
        server.transport.nativeName ?? server.id,
        {
          url: server.transport.url,
          http_headers: projection.headers,
          ...(server.transport.globalSource ? { enabled: true } : {}),
          required: false,
          ...policy,
        },
      ];
    }),
  );

export class CodexSession implements BridgeSession {
  readonly nativeId: string;
  readonly permissionMode: EngineSessionOptions["permissionMode"];
  readonly #rpc: JsonLineRpc;
  readonly #emit: (event: BridgeEvent) => void;
  readonly #closed: () => void;
  #activeTurn: string | undefined;
  #connected = true;
  readonly #approvals: NativeApprovalWaits;
  #approvalEnabled = false;
  readonly #modelId: string | undefined;
  readonly #thinkingEffort: string | undefined;
  readonly #messageKinds = new Map<
    string,
    "commentary" | "question" | "answer"
  >();

  constructor(
    rpc: JsonLineRpc,
    nativeId: string,
    emit: (event: BridgeEvent) => void,
    closed: () => void,
    modelId?: string,
    thinkingEffort?: string,
    options?: Pick<EngineSessionOptions, "requestApproval" | "permissionMode">,
  ) {
    this.#rpc = rpc;
    this.nativeId = nativeId;
    this.permissionMode = options?.permissionMode ?? "workspace_write";
    this.#approvals = new NativeApprovalWaits(options?.requestApproval);
    this.#emit = emit;
    this.#closed = closed;
    this.#modelId = modelId;
    // Existing sessions may still carry the retired ultra option.
    this.#thinkingEffort = thinkingEffort === "ultra" ? "max" : thinkingEffort;
  }

  async send(
    content: string,
    images: readonly import("../native-images.js").NativeImage[] = [],
  ): Promise<string> {
    const result = await this.#rpc.request<TurnResponse>("turn/start", {
      threadId: this.nativeId,
      input: [
        { type: "text", text: content },
        ...images.map((image) => ({
          type: "image",
          url: `data:${image.mimeType};base64,${image.data}`,
        })),
      ],
      ...(this.#modelId === undefined ? {} : { model: this.#modelId }),
      ...(this.#thinkingEffort === undefined
        ? {}
        : { effort: this.#thinkingEffort }),
    });
    this.#activeTurn = result.turn.id;
    this.#approvalEnabled = true;
    return result.turn.id;
  }

  async cancel(): Promise<void> {
    this.#approvalEnabled = false;
    this.#approvals.abort();
    if (this.#activeTurn === undefined) return;
    await this.#rpc.request("turn/interrupt", {
      threadId: this.nativeId,
      turnId: this.#activeTurn,
    });
  }

  async compact(): Promise<void> {
    await this.#rpc.request("thread/compact/start", {
      threadId: this.nativeId,
    });
  }

  async steer(
    content: string,
    images: readonly import("../native-images.js").NativeImage[] = [],
  ): Promise<string> {
    if (this.#activeTurn === undefined) throw new Error("no_active_turn");
    const result = await this.#rpc.request<{ turnId: string }>("turn/steer", {
      threadId: this.nativeId,
      expectedTurnId: this.#activeTurn,
      input: [
        { type: "text", text: content },
        ...images.map((image) => ({
          type: "image",
          url: `data:${image.mimeType};base64,${image.data}`,
        })),
      ],
    });
    return result.turnId;
  }

  async close(): Promise<void> {
    this.#connected = false;
    this.#approvalEnabled = false;
    this.#approvals.abort();
    await this.#rpc.request("thread/unsubscribe", { threadId: this.nativeId });
    this.#closed();
  }

  get connected(): boolean {
    return this.#connected;
  }

  disconnected(): void {
    this.#connected = false;
    this.#approvalEnabled = false;
    this.#approvals.abort();
    if (this.#activeTurn === undefined) return;
    const turnId = this.#activeTurn;
    this.#activeTurn = undefined;
    this.#emit({
      type: "turn.failed",
      turnId,
      code: "codex_disconnected",
      message: "Codex 进程已中断，请重新发送消息。",
    });
  }

  async requestApproval(
    method: string,
    params: ObjectValue,
  ): Promise<{ decision: import("./types.js").JsonValue }> {
    const turnId = text(params, "turnId");
    if (
      !this.#approvalEnabled ||
      !turnId ||
      turnId !== this.#activeTurn ||
      text(params, "threadId") !== this.nativeId ||
      (method !== "item/commandExecution/requestApproval" &&
        method !== "item/fileChange/requestApproval")
    )
      return { decision: "cancel" };
    const tool =
      text(params, "command") ??
      (method === "item/fileChange/requestApproval"
        ? "fileChange"
        : "commandExecution");
    const offered = (
      Array.isArray(params.availableDecisions)
        ? nativeJson(params.availableDecisions)
        : ["accept", "decline", "cancel"]
    ) as import("./types.js").JsonValue[];
    const choices = codexApprovalChoices(offered);
    const decision = await this.#approvals.request({
      turnId,
      tool,
      summary: text(params, "reason") ?? tool,
      input: nativeJson(params),
      choices,
      ...(Array.isArray(params.availableDecisions)
        ? {
            options: nativeJson(
              params.availableDecisions,
            ) as import("./types.js").JsonValue[],
          }
        : {}),
    });
    if (typeof decision === "object") {
      const choice = choices.find((item) => item.id === decision.optionId);
      return {
        decision: choice ? offered[Number(choice.id.slice(7))]! : "cancel",
      };
    }
    const nativeDecision =
      decision === "allow"
        ? "accept"
        : decision === "reject"
          ? "decline"
          : "cancel";
    if (
      Array.isArray(params.availableDecisions) &&
      !params.availableDecisions.includes(nativeDecision)
    )
      return { decision: "cancel" };
    return { decision: nativeDecision };
  }

  notification(method: string, params: ObjectValue): void {
    const turn = object(params.turn);
    const item = object(params.item);
    const turnId =
      text(params, "turnId") ?? text(turn, "id") ?? this.#activeTurn;
    if (turnId === undefined) return;
    if (
      (method === "item/started" || method === "item/completed") &&
      text(item, "type") === "agentMessage"
    ) {
      const id = text(item, "id");
      const phase = text(item, "phase");
      // The pinned Codex app-server projects async prompts as agentMessage
      // items using the tool call ID. Ordinary model messages use message IDs.
      const kind = id?.startsWith("call_")
        ? "question"
        : phase === "commentary"
          ? "commentary"
          : phase === "final_answer"
            ? "answer"
            : undefined;
      if (id && kind) this.#messageKinds.set(id, kind);
    }
    if (method === "turn/plan/updated") {
      this.#emit({
        type: "process.updated",
        turnId,
        processId: `${turnId}-plan`,
        kind: "plan",
        text: text(params, "explanation") || "",
        data: nativeJson(params.plan || []),
      });
      return;
    }
    if (method === "item/reasoning/summaryTextDelta") {
      this.#emit({
        type: "process.updated",
        turnId,
        processId: `${text(params, "itemId") || turnId}-summary-${params.summaryIndex || 0}`,
        kind: "reasoning",
        delta: text(params, "delta") || "",
      });
      return;
    }
    if (method === "turn/started") {
      this.#activeTurn = turnId;
      this.#approvalEnabled = true;
      this.#emit({ type: "turn.started", turnId });
      return;
    }
    if (method === "error") {
      const error = object(params.error);
      const message = text(error, "message") ?? "Codex 请求失败，请稍后重试。";
      if (params.willRetry === true) {
        this.#emit({ type: "turn.retrying", turnId, message });
      } else {
        this.#approvalEnabled = false;
        this.#approvals.abort();
        this.#activeTurn = undefined;
        this.#emit({
          type: "turn.failed",
          turnId,
          code: "codex_failed",
          message,
        });
      }
      return;
    }
    if (method === "item/agentMessage/delta") {
      const delta = text(params, "delta");
      const messageId = text(params, "itemId");
      if (delta !== undefined)
        this.#emit({
          type: "assistant.delta",
          turnId,
          delta,
          ...(messageId === undefined ? {} : { messageId }),
          ...(messageId && this.#messageKinds.has(messageId)
            ? { kind: this.#messageKinds.get(messageId)! }
            : {}),
        });
      return;
    }
    if (
      method === "item/commandExecution/outputDelta" ||
      method === "item/fileChange/outputDelta"
    ) {
      const toolCallId = text(params, "itemId");
      const delta = text(params, "delta");
      if (toolCallId !== undefined && delta !== undefined)
        this.#emit({
          type: "tool.updated",
          turnId,
          toolCallId,
          output: delta,
          raw: nativeJson(params),
        });
      return;
    }
    const itemType = text(item, "type");
    const itemId = text(item, "id");
    if (method === "item/completed" && itemType === "agentMessage") {
      this.#emit({
        type: "assistant.completed",
        turnId,
        content: text(item, "text") ?? "",
        ...(itemId === undefined ? {} : { messageId: itemId }),
        ...(itemId && this.#messageKinds.has(itemId)
          ? { kind: this.#messageKinds.get(itemId)! }
          : {}),
      });
      return;
    }
    if (
      itemId !== undefined &&
      (itemType === "commandExecution" ||
        itemType === "mcpToolCall" ||
        itemType === "fileChange")
    ) {
      const details = {
        tool: text(item, "tool") ?? text(item, "command") ?? itemType,
        raw: nativeJson(item),
        ...(item?.arguments !== undefined
          ? { input: nativeJson(item.arguments) }
          : item?.changes !== undefined
            ? { input: nativeJson(item.changes) }
            : item?.command !== undefined
              ? { input: nativeJson({ command: item.command, cwd: item.cwd }) }
              : {}),
        ...(item?.aggregatedOutput !== undefined
          ? { output: nativeJson(item.aggregatedOutput) }
          : {}),
        ...(item?.result !== undefined
          ? { result: nativeJson(item.result) }
          : {}),
        ...(Array.isArray(item?.changes)
          ? {
              locations: nativeJson(
                item.changes.map((change) => ({ path: object(change)?.path })),
              ),
            }
          : {}),
      };
      if (method === "item/started") {
        this.#emit({
          type: "tool.started",
          turnId,
          toolCallId: itemId,
          ...details,
        });
      } else if (method === "item/completed") {
        this.#emit({
          type: "tool.completed",
          turnId,
          toolCallId: itemId,
          failed: text(item, "status") === "failed",
          ...details,
        });
      }
      return;
    }
    if (method === "turn/completed") {
      this.#messageKinds.clear();
      const status = text(turn, "status");
      this.#approvalEnabled = false;
      this.#approvals.abort();
      this.#activeTurn = undefined;
      if (status === "interrupted") {
        this.#emit({ type: "turn.cancelled", turnId });
      } else if (status === "failed") {
        const error = object(turn?.error);
        this.#emit({
          type: "turn.failed",
          turnId,
          code: text(error, "codexErrorInfo") ?? "codex_failed",
          message: text(error, "message") ?? "Codex turn failed",
        });
      } else {
        this.#emit({ type: "turn.completed", turnId });
      }
    }
  }
}
