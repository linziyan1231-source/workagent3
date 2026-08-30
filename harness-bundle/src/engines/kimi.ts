import { randomUUID } from "node:crypto";
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
} from "@agentclientprotocol/sdk";
import { nativeEngineEnvironment } from "./environment.js";
import type {
  BridgeEvent,
  BridgeSession,
  EngineBridge,
  NativeEngineStatus,
} from "./types.js";

export class KimiBridge implements EngineBridge {
  readonly id = "kimi" as const;
  readonly #binary: string;
  readonly #sessions = new Map<string, KimiSession>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #connection: ClientSideConnection | undefined;
  #starting: Promise<ClientSideConnection> | undefined;

  constructor(binary = process.env.WORKAGENT_KIMI_BIN ?? "kimi") {
    this.#binary = binary;
  }

  async create(
    workspace: string,
    onEvent: (event: BridgeEvent) => void,
    options?: import("./types.js").EngineSessionOptions,
  ): Promise<BridgeSession> {
    const connection = await this.#connect();
    const result = await connection.newSession({
      cwd: workspace,
      mcpServers: projectMcpServers(options?.mcpServers ?? []),
    });
    const session = new KimiSession(connection, result.sessionId, onEvent, () =>
      this.#sessions.delete(result.sessionId),
    );
    this.#sessions.set(result.sessionId, session);
    return session;
  }

  async resume(
    nativeId: string,
    workspace: string,
    onEvent: (event: BridgeEvent) => void,
    options?: import("./types.js").EngineSessionOptions,
  ): Promise<BridgeSession> {
    const connection = await this.#connect();
    await connection.unstable_resumeSession({
      sessionId: nativeId,
      cwd: workspace,
      mcpServers: projectMcpServers(options?.mcpServers ?? []),
    });
    const session = new KimiSession(connection, nativeId, onEvent, () => {
      this.#sessions.delete(nativeId);
    });
    this.#sessions.set(nativeId, session);
    return session;
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
    const child = spawn(this.#binary, ["acp"], {
      env: nativeEngineEnvironment(process.env, "KIMI_CODE_HOME"),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    child.stderr.resume();
    const client = new KimiClient(this.#sessions);
    const connection = new ClientSideConnection(
      () => client,
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
    child.once("exit", () => {
      this.#child = undefined;
      this.#connection = undefined;
      this.#starting = undefined;
    });
    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "WorkAgent", version: "0.1.0" },
    });
    this.#connection = connection;
    return connection;
  }
}

export const projectMcpServers = (
  servers: readonly import("@workagent/contracts").RuntimeMcpServer[],
): McpServer[] =>
  servers.map((server) => {
    const transport = server.transport;
    if (transport.kind === "stdio") {
      if (Object.keys(transport.environmentCredentialIds).length !== 0)
        throw new Error(`mcp_credentials_unavailable:${server.id}`);
      return {
        name: server.name,
        command: transport.command,
        args: transport.args,
        env: [],
      };
    }
    if (Object.keys(transport.headerCredentialIds).length !== 0)
      throw new Error(`mcp_credentials_unavailable:${server.id}`);
    return {
      type: transport.kind,
      name: server.name,
      url: transport.url,
      headers: [],
    };
  });

class KimiClient implements Client {
  readonly #sessions: Map<string, KimiSession>;

  constructor(sessions: Map<string, KimiSession>) {
    this.#sessions = sessions;
  }

  async requestPermission(
    _params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    // Approval bridging is added as a separate capability; fail closed until then.
    return { outcome: { outcome: "cancelled" } };
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    this.#sessions.get(params.sessionId)?.update(params);
  }
}

class KimiSession implements BridgeSession {
  readonly nativeId: string;
  readonly #connection: ClientSideConnection;
  readonly #emit: (event: BridgeEvent) => void;
  readonly #closed: () => void;
  #activeTurn: string | undefined;
  #assistantText = "";

  constructor(
    connection: ClientSideConnection,
    nativeId: string,
    emit: (event: BridgeEvent) => void,
    closed: () => void,
  ) {
    this.#connection = connection;
    this.nativeId = nativeId;
    this.#emit = emit;
    this.#closed = closed;
  }

  async send(content: string): Promise<void> {
    if (this.#activeTurn !== undefined)
      throw new Error("Kimi already has an active turn");
    const turnId = `turn-${randomUUID()}`;
    this.#activeTurn = turnId;
    this.#assistantText = "";
    this.#emit({ type: "turn.started", turnId });
    void this.#connection
      .prompt({
        sessionId: this.nativeId,
        prompt: [{ type: "text", text: content }],
      })
      .then((result) => {
        if (result.stopReason === "cancelled") {
          this.#emit({ type: "turn.cancelled", turnId });
        } else if (result.stopReason === "end_turn") {
          this.#emit({
            type: "assistant.completed",
            turnId,
            content: this.#assistantText,
          });
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
        this.#emit({
          type: "turn.failed",
          turnId,
          code: "kimi_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.#activeTurn === turnId) this.#activeTurn = undefined;
      });
  }

  async cancel(): Promise<void> {
    if (this.#activeTurn === undefined) return;
    await this.#connection.cancel({ sessionId: this.nativeId });
  }

  async close(): Promise<void> {
    await this.cancel();
    this.#closed();
  }

  update(params: SessionNotification): void {
    const turnId = this.#activeTurn;
    if (turnId === undefined) return;
    const update = params.update;
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
    if (update.sessionUpdate === "tool_call") {
      this.#emit({
        type: "tool.started",
        turnId,
        toolCallId: update.toolCallId,
        tool: update.title,
      });
      return;
    }
    if (
      update.sessionUpdate === "tool_call_update" &&
      (update.status === "completed" || update.status === "failed")
    ) {
      this.#emit({
        type: "tool.completed",
        turnId,
        toolCallId: update.toolCallId,
        failed: update.status === "failed",
      });
    }
  }
}
