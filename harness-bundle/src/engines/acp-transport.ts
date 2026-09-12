import {
  nativeJson,
  NativeApprovalWaits,
  type EngineSessionOptions,
  type JsonValue,
  type BridgeEvent,
  type BridgeSession,
  type EngineBridge,
  type NativeEngineStatus,
} from "./types.js";
import { acpApprovalChoices } from "./approval-options.js";
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
  type NewSessionResponse,
} from "@agentclientprotocol/sdk";
import { withSkillCatalog } from "./skills.js";

async function deadline<T>(
  operation: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("acp_response_timeout")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

export type AcpTransportConfiguration = {
  id: "kimi" | "acp";
  command: string;
  args: string[];
  cwd?: string;
  environment(): NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
  applyOptions(
    connection: ClientSideConnection,
    sessionId: string,
    options: EngineSessionOptions | undefined,
    modes: NewSessionResponse["modes"],
    config?: SessionConfigOption[],
  ): Promise<void>;
  permission(
    result: Pick<NewSessionResponse, "modes" | "configOptions">,
  ): BridgeSession["permissionMode"];
  models(
    connection: ClientSideConnection,
    sessionId: string,
    models: NewSessionResponse["models"],
    config?: SessionConfigOption[],
  ): Promise<import("./types.js").EngineModel[]>;
  skillDirectories?(workspace: string, options: EngineSessionOptions): string[];
  sessionFailure?(operation: string, error: unknown): Error;
};

export class AcpBridge implements EngineBridge {
  readonly id: "kimi" | "acp";
  readonly #configuration: AcpTransportConfiguration;

  readonly #sessions = new Map<string, AcpSession>();
  #client: AcpClient | undefined;
  #capabilities: import("@agentclientprotocol/sdk").AgentCapabilities = {};
  #child: ChildProcessWithoutNullStreams | undefined;
  #connection: ClientSideConnection | undefined;
  #starting: Promise<ClientSideConnection> | undefined;
  readonly #scoped = new Map<string, AcpBridge>();
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
    configuration: AcpTransportConfiguration,
    skillDirectories?: readonly string[],
  ) {
    this.#configuration = configuration;
    this.id = configuration.id;
    this.#skillDirectories = skillDirectories;
  }

  capabilities() {
    return {
      approval: true,
      resume: Boolean(
        this.#capabilities.loadSession ||
          this.#capabilities.sessionCapabilities?.resume,
      ),
      steer: true,
      toolEvents: true,
      usage: false,
    };
  }

  #forSkills(
    workspace: string,
    options?: EngineSessionOptions,
  ): AcpBridge | undefined {
    if (
      !this.#configuration.skillDirectories ||
      this.#skillDirectories ||
      options?.skills === undefined
    )
      return undefined;
    const directories = this.#configuration.skillDirectories!(
      workspace,
      options,
    );
    const key = JSON.stringify(directories);
    let bridge = this.#scoped.get(key);
    if (!bridge) {
      bridge = new AcpBridge(this.#configuration, directories);
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
    const probe = new AcpBridge(this.#configuration);
    const workspace = await mkdtemp(join(tmpdir(), "workagent-models-"));
    try {
      const connection = await probe.#connect();
      const session = await deadline(
        connection.newSession({
          cwd: workspace,
          mcpServers: [],
        }),
        25_000,
      );
      return await this.#configuration.models(
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
      await this.#configuration.applyOptions(
        connection,
        result.sessionId,
        options,
        result.modes,
        result.configOptions,
      );
    } catch (error) {
      throw this.#sessionFailure("new", error);
    }
    const session = new AcpSession(
      connection,
      result.sessionId,
      onEvent,
      () => this.#sessions.delete(result.sessionId),
      {
        ...options,
        permissionMode:
          options?.permissionMode ?? this.#configuration.permission(result),
      },
    );
    this.#sessions.set(result.sessionId, session);
    this.#client?.replay(session);
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
      const resume = this.#capabilities.sessionCapabilities?.resume
        ? connection.unstable_resumeSession.bind(connection)
        : this.#capabilities.loadSession
          ? connection.loadSession.bind(connection)
          : undefined;
      if (!resume) throw new Error("engine_capability_unsupported:resume");
      result = await resume({
        sessionId: nativeId,
        cwd: workspace,
        mcpServers: projectMcpServers(options?.mcpServers ?? []),
      });
      await this.#configuration.applyOptions(
        connection,
        nativeId,
        options,
        result.modes,
        result.configOptions,
      );
    } catch (error) {
      throw this.#sessionFailure("resume", error);
    }
    const session = new AcpSession(
      connection,
      nativeId,
      onEvent,
      () => {
        this.#sessions.delete(nativeId);
      },
      {
        ...options,
        permissionMode:
          options?.permissionMode ?? this.#configuration.permission(result),
      },
    );
    this.#sessions.set(nativeId, session);
    this.#client?.replay(session);
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
      if (!this.#capabilities.sessionCapabilities?.fork)
        throw new Error("engine_capability_unsupported:fork");
      result = await connection.unstable_forkSession({
        sessionId: nativeId,
        cwd: workspace,
        mcpServers: projectMcpServers(options?.mcpServers ?? []),
      });
      await this.#configuration.applyOptions(
        connection,
        result.sessionId,
        options,
        result.modes,
        result.configOptions,
      );
    } catch (error) {
      throw this.#sessionFailure("fork", error);
    }
    const session = new AcpSession(
      connection,
      result.sessionId,
      onEvent,
      () => this.#sessions.delete(result.sessionId),
      {
        ...options,
        permissionMode:
          options?.permissionMode ?? this.#configuration.permission(result),
      },
    );
    this.#sessions.set(result.sessionId, session);
    this.#client?.replay(session);
    return withSkillCatalog(session, options);
  }

  #sessionFailure(operation: string, error: unknown): Error {
    if (this.#configuration.sessionFailure)
      return this.#configuration.sessionFailure(operation, error);
    return new Error(
      `engine_session_failed:${this.id}:${operation}: ${error instanceof Error ? error.message : String(error)}`,
    );
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
          "ACP is available; authentication is verified when a session starts.",
      };
    } catch {
      return {
        available: false,
        authenticated: null,
        state: "unavailable",
        detail: "The ACP server could not be reached.",
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
    const child = spawn(
      this.#configuration.command,
      [
        ...(this.#skillDirectories ?? []).flatMap((path) => [
          "--skills-dir",
          path,
        ]),
        ...this.#configuration.args,
      ],
      {
        env: await this.#configuration.environment(),
        ...(this.#configuration.cwd ? { cwd: this.#configuration.cwd } : {}),
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
    const client = new AcpClient(this.#sessions);
    this.#client = client;
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
            `engine_start_failed:ACP process exited with ${code ?? "no status"}${stderrDetail()}`,
          ),
        ),
      );
    });
    child.once("exit", (code) => {
      const detail = `ACP process exited with ${code ?? "no status"}${stderrDetail()}`;
      for (const session of this.#sessions.values())
        session.disconnected(detail);
      this.#sessions.clear();
      this.#child = undefined;
      this.#connection = undefined;
      this.#starting = undefined;
    });
    try {
      const initialized = await deadline(
        Promise.race([
          connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: "WorkAgent", version: "0.1.0" },
          }),
          startupFailure,
        ]),
        15_000,
      );
      this.#capabilities = initialized.agentCapabilities ?? {};
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

class AcpClient implements Client {
  readonly #sessions: Map<string, AcpSession>;
  readonly #earlyCommands = new Map<string, SessionNotification>();

  constructor(sessions: Map<string, AcpSession>) {
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
    const session = this.#sessions.get(params.sessionId);
    if (session) session.update(params);
    else if (params.update.sessionUpdate === "available_commands_update") {
      if (this.#earlyCommands.size >= 64)
        this.#earlyCommands.delete(this.#earlyCommands.keys().next().value!);
      this.#earlyCommands.set(params.sessionId, params);
    }
  }

  replay(session: AcpSession): void {
    const update = this.#earlyCommands.get(session.nativeId);
    this.#earlyCommands.delete(session.nativeId);
    if (update) session.update(update);
  }
}

export class AcpSession implements BridgeSession {
  #commands: import("./types.js").NativeCommandCatalog = {
    supported: false,
    revision: 0,
    items: [],
  };
  commands(): import("./types.js").NativeCommandCatalog {
    return structuredClone(this.#commands);
  }
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
      throw new Error("ACP session already has an active turn");
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
            message: `ACP agent stopped with ${result.stopReason}`,
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
          code: "acp_failed",
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
    if (!this.#commands.items.some((command) => command.id === "compact"))
      throw new Error("engine_compact_unavailable");
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
        code: "acp_disconnected",
        message: `ACP process disconnected${detail ? ` (${detail})` : ""}`,
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
      choices: acpApprovalChoices(params.options),
    });
    if (typeof decision === "object") {
      const option = params.options.find(
        (item) => item.optionId === decision.optionId,
      );
      return option
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
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
    if (params.sessionId !== this.nativeId) return;
    if (params.update.sessionUpdate === "available_commands_update") {
      this.#commands = {
        supported: true,
        revision: this.#commands.revision + 1,
        items: params.update.availableCommands.map((command) => ({
          id: command.name,
          label: command.name,
          description: command.description,
          ...(command.input ? { inputHint: command.input.hint } : {}),
        })),
      };
      return;
    }
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
