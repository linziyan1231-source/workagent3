import {
  nativeJson,
  NativeApprovalWaits,
  type EngineSessionOptions,
  type JsonValue,
} from "./types.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type McpServer,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { nativeEngineEnvironment } from "./environment.js";
import { kimiSkillDirectories, withSkillCatalog } from "./skills.js";
import type {
  BridgeEvent,
  BridgeSession,
  EngineBridge,
  NativeEngineStatus,
} from "./types.js";

const kimiModel = (modelId: string | undefined): string | undefined =>
  modelId === "kimi-native" ? undefined : modelId;

function configSelect(
  config: SessionConfigOption[] | undefined,
  category: string,
) {
  const item = config?.find(
    (option) => option.category === category || option.id === category,
  );
  if (!item || item.type !== "select") return undefined;
  return {
    id: item.id,
    currentValue: item.currentValue,
    options: item.options.flatMap((option) =>
      "options" in option ? option.options : [option],
    ),
  };
}

export function kimiModelOptions(
  models:
    | {
        currentModelId: string;
        availableModels: Array<{ modelId: string; name: string }>;
      }
    | null
    | undefined,
  configOptions?: SessionConfigOption[],
): import("./types.js").EngineModel[] {
  const modelOption = configSelect(configOptions, "model");
  if (modelOption) {
    const thought = configSelect(configOptions, "thought_level");
    return modelOption.options.map((model) => ({
      id: model.value,
      name: model.name,
      isDefault: model.value === modelOption.currentValue,
      reasoning: (thought?.options ?? []).map((option) => ({
        id: option.value,
        name: option.name,
      })),
      ...(thought ? { defaultReasoning: thought.currentValue } : {}),
    }));
  }
  const result = new Map<string, import("./types.js").EngineModel>();
  for (const model of models?.availableModels ?? []) {
    const thinking = model.modelId.endsWith(",thinking");
    const id = thinking ? model.modelId.slice(0, -9) : model.modelId;
    const row = result.get(id) ?? {
      id,
      name: model.name.replace(/ \(thinking\)$/, ""),
      isDefault: false,
      reasoning: [],
    };
    row.reasoning.push({
      id: thinking ? "thinking" : "off",
      name: thinking ? "开启思考" : "关闭思考",
    });
    if (model.modelId === models?.currentModelId) {
      row.isDefault = true;
      row.defaultReasoning = thinking ? "thinking" : "off";
    }
    result.set(id, row);
  }
  return [...result.values()];
}

export async function kimiSessionModelOptions(
  connection: ClientSideConnection,
  sessionId: string,
  models: Parameters<typeof kimiModelOptions>[0],
  configOptions?: SessionConfigOption[],
) {
  const result = kimiModelOptions(models, configOptions);
  const selector = configSelect(configOptions, "model");
  if (!selector || result.length < 2) return result;
  // Thinking options belong to the selected model, not the whole engine.
  for (const model of result) {
    if (model.isDefault) continue;
    const selected = await connection.setSessionConfigOption({
      sessionId,
      configId: selector.id,
      value: model.id,
    });
    const capabilities = kimiModelOptions(
      undefined,
      selected.configOptions,
    ).find((row) => row.id === model.id)!;
    model.reasoning = capabilities.reasoning;
    if (capabilities.defaultReasoning === undefined)
      delete model.defaultReasoning;
    else model.defaultReasoning = capabilities.defaultReasoning;
  }
  return result;
}

export const applyKimiOptions = async (
  connection: ClientSideConnection,
  sessionId: string,
  options: import("./types.js").EngineSessionOptions | undefined,
  modes:
    | {
        availableModes: Array<{ id: string; name: string }>;
        currentModeId: string;
      }
    | null
    | undefined,
  configOptions?: SessionConfigOption[],
): Promise<void> => {
  if (configSelect(configOptions, "model")) {
    for (const [category, value] of [
      ["model", kimiModel(options?.modelId)],
      ["thought_level", options?.thinkingEffort],
      [
        "mode",
        options?.permissionMode &&
          {
            read_only: "plan",
            workspace_write: "auto",
            full_access: "yolo",
          }[options.permissionMode],
      ],
    ] as const) {
      const option = configSelect(configOptions, category);
      if (category === "mode" && options?.requirePermission && !option)
        throw new Error("engine_permission_unavailable");
      if (option && value !== undefined && value !== option.currentValue) {
        try {
          const result = await connection.setSessionConfigOption({
            sessionId,
            configId: option.id,
            value,
          });
          configOptions = result.configOptions;
        } catch (error) {
          // Kimi 0.41 can advertise "default" after restoring a persisted
          // plan session. Reapplying plan then reports this already-set state.
          const details = (error as { data?: { details?: unknown } })?.data
            ?.details;
          if (
            category !== "mode" ||
            value !== "plan" ||
            details !== "Already in plan mode"
          )
            throw error;
        }
      }
    }
    return;
  }
  const selected = kimiModel(options?.modelId);
  const modelId =
    selected && options?.thinkingEffort === "thinking"
      ? `${selected},thinking`
      : selected;
  if (modelId !== undefined)
    await connection.unstable_setSessionModel({ sessionId, modelId });
  if (
    options?.permissionMode === undefined ||
    modes === undefined ||
    modes === null
  ) {
    if (options?.requirePermission)
      throw new Error("engine_permission_unavailable");
    return;
  }
  const terms = {
    read_only: ["plan", "readonly"],
    workspace_write: ["acceptedit", "acceptedits", "workspacewrite", "auto"],
    full_access: [
      "yolo",
      "yolonosandbox",
      "dangerfullaccess",
      "nosandbox",
      "bypass",
      "full",
      "fullaccess",
    ],
  }[options.permissionMode];
  const target = modes.availableModes.find((mode) => {
    return [mode.id, mode.name].some((value) =>
      terms.includes(value.toLowerCase().replace(/[^a-z]/g, "")),
    );
  });
  if (target === undefined && options.requirePermission)
    throw new Error("engine_permission_unavailable");
  if (target !== undefined && target.id !== modes.currentModeId)
    await connection.setSessionMode({ sessionId, modeId: target.id });
};

// ACP agents report in-agent session failures as JSON-RPC RequestError
// values with generic messages ("Internal error"); re-code them so callers
// see the engine context and the team API maps the failure to 503 instead of
// a bare 400.
export const kimiSessionFailure = (
  operation: string,
  error: unknown,
): Error => {
  const message = error instanceof Error ? error.message : String(error);
  const data =
    error instanceof Error ? (error as { data?: unknown }).data : undefined;
  const detail =
    data === undefined ? message : `${message} ${JSON.stringify(data)}`;
  return new Error(`engine_session_failed:kimi:${operation}: ${detail}`);
};

export function kimiPermission(result: {
  configOptions?: SessionConfigOption[];
  modes?: { currentModeId: string } | null;
}): BridgeSession["permissionMode"] {
  const mode =
    configSelect(result.configOptions, "mode")?.currentValue ??
    result.modes?.currentModeId;
  return (
    {
      default: "manual_approval",
      plan: "read_only",
      auto: "workspace_write",
      yolo: "full_access",
    } as const
  )[mode as "default" | "plan" | "auto" | "yolo"];
}

export class KimiBridge implements EngineBridge {
  readonly id = "kimi" as const;
  readonly #binary: string;
  readonly #sessions = new Map<string, KimiSession>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #connection: ClientSideConnection | undefined;
  #starting: Promise<ClientSideConnection> | undefined;
  readonly #scoped = new Map<string, KimiBridge>();
  readonly #skillDirectories: readonly string[] | undefined;
  // Model discovery spawns a dedicated ACP process per call; cache briefly so
  // bursts of UI selectors cannot flood the host with short-lived processes.
  #models:
    | {
        expires: number;
        value: Promise<import("./types.js").EngineModel[]>;
      }
    | undefined;

  constructor(
    binary = process.env.WORKAGENT_KIMI_BIN ?? "kimi",
    skillDirectories?: readonly string[],
  ) {
    this.#binary = binary;
    this.#skillDirectories = skillDirectories;
  }

  #forSkills(
    workspace: string,
    options?: EngineSessionOptions,
  ): KimiBridge | undefined {
    if (this.#skillDirectories || options?.skills === undefined)
      return undefined;
    const directories = kimiSkillDirectories(workspace, options);
    const key = JSON.stringify(directories);
    let bridge = this.#scoped.get(key);
    if (!bridge) {
      bridge = new KimiBridge(this.#binary, directories);
      this.#scoped.set(key, bridge);
    }
    return bridge;
  }

  async listModels(): Promise<import("./types.js").EngineModel[]> {
    const cached = this.#models;
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = this.#probeModels();
    this.#models = { expires: Date.now() + 60_000, value };
    try {
      return await value;
    } catch (error) {
      // A failed probe is never cached; the next caller retries.
      if (this.#models?.value === value) this.#models = undefined;
      throw error;
    }
  }

  async #probeModels(): Promise<import("./types.js").EngineModel[]> {
    // A dedicated ACP process isolates the discovery session from active tasks.
    const probe = new KimiBridge(this.#binary);
    const workspace = await mkdtemp(join(tmpdir(), "workagent-models-"));
    try {
      const connection = await probe.#connect();
      const session = await connection.newSession({
        cwd: workspace,
        mcpServers: [],
      });
      return await kimiSessionModelOptions(
        connection,
        session.sessionId,
        session.models,
        session.configOptions,
      );
    } finally {
      await probe.close();
      await rm(workspace, { recursive: true, force: true });
    }
  }

  async create(
    workspace: string,
    onEvent: (event: BridgeEvent) => void,
    options?: import("./types.js").EngineSessionOptions,
  ): Promise<BridgeSession> {
    const scoped = this.#forSkills(workspace, options);
    if (scoped) return scoped.create(workspace, onEvent, options);
    const connection = await this.#connect();
    let result;
    try {
      result = await connection.newSession({
        cwd: workspace,
        mcpServers: projectMcpServers(options?.mcpServers ?? []),
      });
      await applyKimiOptions(
        connection,
        result.sessionId,
        options,
        result.modes,
        result.configOptions,
      );
    } catch (error) {
      throw kimiSessionFailure("new", error);
    }
    const session = new KimiSession(
      connection,
      result.sessionId,
      onEvent,
      () => this.#sessions.delete(result.sessionId),
      {
        ...options,
        permissionMode: options?.permissionMode ?? kimiPermission(result),
      },
    );
    this.#sessions.set(result.sessionId, session);
    return withSkillCatalog(session, options);
  }

  async resume(
    nativeId: string,
    workspace: string,
    onEvent: (event: BridgeEvent) => void,
    options?: import("./types.js").EngineSessionOptions,
  ): Promise<BridgeSession> {
    const scoped = this.#forSkills(workspace, options);
    if (scoped) return scoped.resume(nativeId, workspace, onEvent, options);
    const connection = await this.#connect();
    let result;
    try {
      result = await connection.unstable_resumeSession({
        sessionId: nativeId,
        cwd: workspace,
        mcpServers: projectMcpServers(options?.mcpServers ?? []),
      });
      await applyKimiOptions(
        connection,
        nativeId,
        options,
        result.modes,
        result.configOptions,
      );
    } catch (error) {
      throw kimiSessionFailure("resume", error);
    }
    const session = new KimiSession(
      connection,
      nativeId,
      onEvent,
      () => {
        this.#sessions.delete(nativeId);
      },
      {
        ...options,
        permissionMode: options?.permissionMode ?? kimiPermission(result),
      },
    );
    this.#sessions.set(nativeId, session);
    return withSkillCatalog(session, options);
  }

  async fork(
    nativeId: string,
    workspace: string,
    onEvent: (event: BridgeEvent) => void,
    options?: import("./types.js").EngineSessionOptions,
    lastTurnId?: string,
  ): Promise<BridgeSession> {
    const scoped = this.#forSkills(workspace, options);
    if (scoped)
      return scoped.fork(nativeId, workspace, onEvent, options, lastTurnId);
    if (lastTurnId !== undefined)
      throw new Error("engine_capability_unsupported:kimi:fork_at_turn");
    const connection = await this.#connect();
    let result;
    try {
      result = await connection.unstable_forkSession({
        sessionId: nativeId,
        cwd: workspace,
        mcpServers: projectMcpServers(options?.mcpServers ?? []),
      });
      await applyKimiOptions(
        connection,
        result.sessionId,
        options,
        result.modes,
        result.configOptions,
      );
    } catch (error) {
      throw kimiSessionFailure("fork", error);
    }
    const session = new KimiSession(
      connection,
      result.sessionId,
      onEvent,
      () => this.#sessions.delete(result.sessionId),
      {
        ...options,
        permissionMode: options?.permissionMode ?? kimiPermission(result),
      },
    );
    this.#sessions.set(result.sessionId, session);
    return withSkillCatalog(session, options);
  }

  async probe(): Promise<void> {
    await this.#connect();
  }

  async status(): Promise<NativeEngineStatus> {
    try {
      await this.#connect();
      return {
        available: true,
        authenticated: null,
        state: "unknown",
        detail:
          "Native Kimi is available; authentication is verified when a session starts.",
      };
    } catch {
      return {
        available: false,
        authenticated: null,
        state: "unavailable",
        detail: "The native Kimi ACP server could not be reached.",
      };
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.#scoped.values()].map((bridge) => bridge.close()),
    );
    this.#scoped.clear();
    for (const session of this.#sessions.values()) session.disconnected();
    this.#child?.kill();
    this.#child = undefined;
    this.#connection = undefined;
    this.#starting = undefined;
    this.#sessions.clear();
  }

  async #connect(): Promise<ClientSideConnection> {
    if (this.#connection !== undefined) return this.#connection;
    this.#starting ??= this.#start().catch((error: unknown) => {
      this.#starting = undefined;
      throw error;
    });
    return this.#starting;
  }

  async #start(): Promise<ClientSideConnection> {
    if (process.env.KIMI_CODE_HOME === undefined)
      throw new Error("KIMI_CODE_HOME is required for the native Kimi engine");
    const child = spawn(
      this.#binary,
      [
        ...(this.#skillDirectories ?? []).flatMap((path) => [
          "--skills-dir",
          path,
        ]),
        "acp",
      ],
      {
        env: nativeEngineEnvironment(process.env, "KIMI_CODE_HOME"),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.#child = child;
    // Keep the last stderr chunk so a silent early exit still leaves a
    // diagnosable cause in the failure message.
    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-8192);
    });
    const stderrDetail = () => {
      const tail = stderrTail.trim().slice(-400);
      return tail ? `: ${tail}` : "";
    };
    // Wait for the spawn to succeed before wiring the connection: a failed
    // spawn rejects here with the real cause instead of escaping as an
    // uncaught child error event or surfacing as an opaque stream error.
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error: Error) =>
        reject(new Error(`engine_start_failed:${error.message}`)),
      );
    });
    const client = new KimiClient(this.#sessions);
    const connection = new ClientSideConnection(
      () => client,
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
    connection.signal.addEventListener(
      "abort",
      () => {
        for (const session of this.#sessions.values()) session.disconnected();
      },
      { once: true },
    );
    // An instant exit during the handshake rejects with the exit status
    // instead of a generic connection-closed error.
    const startupFailure = new Promise<never>((_resolve, reject) => {
      child.once("exit", (code) =>
        reject(
          new Error(
            `engine_start_failed:kimi acp exited with ${code ?? "no status"}${stderrDetail()}`,
          ),
        ),
      );
    });
    child.once("exit", (code) => {
      const detail = `kimi acp exited with ${code ?? "no status"}${stderrDetail()}`;
      for (const session of this.#sessions.values())
        session.disconnected(detail);
      this.#sessions.clear();
      this.#child = undefined;
      this.#connection = undefined;
      this.#starting = undefined;
    });
    try {
      await Promise.race([
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "WorkAgent", version: "0.1.0" },
        }),
        startupFailure,
      ]);
    } catch (error) {
      // Do not leak a process that never completed the handshake.
      child.kill();
      throw error;
    }
    this.#connection = connection;
    return connection;
  }
}

export const projectMcpServers = (
  servers: readonly import("../mcp-projection.js").ResolvedMcpServer[],
): McpServer[] =>
  servers.map((projection) => {
    const server = projection.server;
    const transport = server.transport;
    if (transport.kind === "stdio") {
      return {
        name: server.name,
        command: transport.command,
        args: transport.args,
        env: Object.entries(projection.environment).map(([name, value]) => ({
          name,
          value,
        })),
      };
    }
    return {
      type: transport.kind,
      name: server.name,
      url: transport.url,
      headers: Object.entries(projection.headers).map(([name, value]) => ({
        name,
        value,
      })),
    };
  });

class KimiClient implements Client {
  readonly #sessions: Map<string, KimiSession>;

  constructor(sessions: Map<string, KimiSession>) {
    this.#sessions = sessions;
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return (
      this.#sessions.get(params.sessionId)?.requestPermission(params) ?? {
        outcome: { outcome: "cancelled" },
      }
    );
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.#sessions.get(params.sessionId)?.update(params);
  }
}

export class KimiSession implements BridgeSession {
  readonly nativeId: string;
  readonly permissionMode: BridgeSession["permissionMode"];
  readonly #connection: ClientSideConnection;
  readonly #emit: (event: BridgeEvent) => void;
  readonly #closed: () => void;
  #activeTurn: string | undefined;
  #connected = true;
  #assistantText = "";
  #completion: Promise<void> | undefined;
  #steering = false;
  readonly #approvals: NativeApprovalWaits;
  #approvalEnabled = false;
  readonly #tools = new Map<string, Record<string, unknown>>();

  constructor(
    connection: ClientSideConnection,
    nativeId: string,
    emit: (event: BridgeEvent) => void,
    closed: () => void,
    options?: Pick<EngineSessionOptions, "requestApproval"> & {
      permissionMode?: BridgeSession["permissionMode"];
    },
  ) {
    this.#connection = connection;
    this.nativeId = nativeId;
    this.permissionMode = options?.permissionMode;
    this.#approvals = new NativeApprovalWaits(options?.requestApproval);
    this.#emit = emit;
    this.#closed = closed;
  }

  async send(
    content: string,
    images: readonly import("../native-images.js").NativeImage[] = [],
  ): Promise<string> {
    if (this.#activeTurn !== undefined)
      throw new Error("Kimi already has an active turn");
    const turnId = `turn-${randomUUID()}`;
    this.#activeTurn = turnId;
    this.#approvalEnabled = true;
    this.#assistantText = "";
    this.#tools.clear();
    this.#emit({ type: "turn.started", turnId });
    this.#completion = this.#connection
      .prompt({
        sessionId: this.nativeId,
        prompt: [
          { type: "text", text: content },
          ...images.map((image) => ({
            type: "image" as const,
            mimeType: image.mimeType,
            data: image.data,
          })),
        ],
      })
      .then((result) => {
        if (this.#activeTurn !== turnId) return;
        this.#approvalEnabled = false;
        this.#approvals.abort();
        this.#activeTurn = undefined;
        if (result.stopReason === "cancelled") {
          this.#emit({ type: "turn.cancelled", turnId });
        } else if (result.stopReason === "end_turn") {
          this.#emit({
            type: "assistant.completed",
            turnId,
            content: this.#assistantText,
          });
          this.#emit({ type: "turn.completed", turnId });
        } else {
          this.#emit({
            type: "turn.failed",
            turnId,
            code: result.stopReason,
            message: `Kimi stopped with ${result.stopReason}`,
          });
        }
      })
      .catch((error: unknown) => {
        if (this.#activeTurn !== turnId) return;
        this.#approvalEnabled = false;
        this.#approvals.abort();
        this.#activeTurn = undefined;
        this.#emit({
          type: "turn.failed",
          turnId,
          code: "kimi_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return turnId;
  }

  async cancel(): Promise<void> {
    this.#approvalEnabled = false;
    this.#approvals.abort();
    if (this.#activeTurn === undefined) return;
    await this.#connection.cancel({ sessionId: this.nativeId });
  }

  async compact(): Promise<void> {
    await this.send("/compact");
  }

  async steer(
    content: string,
    images: readonly import("../native-images.js").NativeImage[] = [],
  ): Promise<string> {
    if (this.#activeTurn === undefined) throw new Error("no_active_turn");
    if (this.#steering) throw new Error("session_input_pending");
    this.#steering = true;
    try {
      // ACP has no mid-prompt input. Wait for cancellation to settle before
      // continuing the same native session with the user's revised direction.
      const completion = this.#completion;
      await this.cancel();
      await completion;
      return await this.send(content, images);
    } finally {
      this.#steering = false;
    }
  }

  async close(): Promise<void> {
    this.#connected = false;
    await this.cancel();
    this.#closed();
  }

  get connected(): boolean {
    return this.#connected;
  }

  disconnected(detail?: string): void {
    this.#connected = false;
    this.#approvalEnabled = false;
    this.#approvals.abort();
    const turnId = this.#activeTurn;
    this.#activeTurn = undefined;
    if (turnId)
      this.#emit({
        type: "turn.failed",
        turnId,
        code: "kimi_disconnected",
        message: `Kimi process disconnected${detail ? ` (${detail})` : ""}`,
      });
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const turnId = this.#activeTurn;
    if (!this.#approvalEnabled || !turnId || params.sessionId !== this.nativeId)
      return { outcome: { outcome: "cancelled" } };
    const decision = await this.#approvals.request({
      turnId,
      tool: params.toolCall.title ?? params.toolCall.kind ?? "tool",
      summary: params.toolCall.title ?? "Tool permission",
      input: nativeJson(params.toolCall),
      options: nativeJson(params.options) as JsonValue[],
    });
    const kinds =
      decision === "allow"
        ? ["allow_once", "allow_always"]
        : decision === "reject"
          ? ["reject_once", "reject_always"]
          : [];
    const option = kinds.flatMap((kind) =>
      params.options.filter((option) => option.kind === kind),
    )[0];
    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  update(params: SessionNotification): void {
    const turnId = this.#activeTurn;
    if (turnId === undefined) return;
    const update = params.update;
    if (update.sessionUpdate === "plan") {
      this.#emit({
        type: "process.updated",
        turnId,
        processId: `${turnId}-plan`,
        kind: "plan",
        data: nativeJson(update.entries),
      });
      return;
    }
    if (
      update.sessionUpdate === "agent_thought_chunk" &&
      update.content.type === "text"
    ) {
      this.#emit({
        type: "process.updated",
        turnId,
        processId: `${turnId}-thought`,
        kind: "reasoning",
        delta: update.content.text,
      });
      return;
    }
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content.type === "text"
    ) {
      this.#assistantText += update.content.text;
      this.#emit({
        type: "assistant.delta",
        turnId,
        delta: update.content.text,
      });
      return;
    }
    if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      const previous = this.#tools.get(update.toolCallId) ?? {};
      const detail = {
        ...previous,
        ...Object.fromEntries(
          Object.entries(update).filter(([, value]) => value !== undefined),
        ),
      };
      this.#tools.set(update.toolCallId, detail);
      const completed =
        update.status === "completed" || update.status === "failed";
      this.#emit({
        type: completed
          ? "tool.completed"
          : update.sessionUpdate === "tool_call"
            ? "tool.started"
            : "tool.updated",
        turnId,
        toolCallId: update.toolCallId,
        tool:
          typeof detail.title === "string"
            ? detail.title
            : typeof detail.kind === "string"
              ? detail.kind
              : "tool",
        ...(completed ? { failed: update.status === "failed" } : {}),
        ...(detail.rawInput !== undefined
          ? { input: nativeJson(detail.rawInput) }
          : {}),
        ...(detail.rawOutput !== undefined
          ? { output: nativeJson(detail.rawOutput) }
          : {}),
        ...(detail.content !== undefined
          ? { result: nativeJson(detail.content) }
          : {}),
        ...(detail.locations !== undefined
          ? { locations: nativeJson(detail.locations) }
          : {}),
        raw: nativeJson(detail),
      } as BridgeEvent);
    }
  }
}
