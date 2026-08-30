import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { nativeEngineEnvironment } from "./environment.js";
import { JsonLineRpc } from "./jsonl-rpc.js";
import type {
  BridgeEvent,
  BridgeSession,
  EngineBridge,
  NativeEngineStatus,
} from "./types.js";

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

  async create(
    workspace: string,
    onEvent: (event: BridgeEvent) => void,
    _options?: import("./types.js").EngineSessionOptions,
  ): Promise<BridgeSession> {
    const rpc = await this.#connection();
    const result = await rpc.request<ThreadResponse>("thread/start", {
      cwd: workspace,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      serviceName: "workagent3",
    });
    const session = new CodexSession(rpc, result.thread.id, onEvent, () => {
      this.#sessions.delete(result.thread.id);
    });
    this.#sessions.set(result.thread.id, session);
    return session;
  }

  async resume(
    nativeId: string,
    workspace: string,
    onEvent: (event: BridgeEvent) => void,
    _options?: import("./types.js").EngineSessionOptions,
  ): Promise<BridgeSession> {
    const rpc = await this.#connection();
    await rpc.request("thread/resume", {
      threadId: nativeId,
      cwd: workspace,
      approvalPolicy: "never",
      sandbox: "workspace-write",
    });
    const session = new CodexSession(rpc, nativeId, onEvent, () => {
      this.#sessions.delete(nativeId);
    });
    this.#sessions.set(nativeId, session);
    return session;
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
    this.#rpc?.close();
    this.#child?.kill();
    this.#rpc = undefined;
    this.#child = undefined;
    this.#starting = undefined;
    this.#sessions.clear();
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
    child.once("error", (error) => rpc.close(error));
    child.once("exit", (code) => {
      rpc.close(
        new Error(`Codex app-server exited with ${code ?? "no status"}`),
      );
      this.#rpc = undefined;
      this.#child = undefined;
      this.#starting = undefined;
    });
    rpc.onRequest((id) => {
      // Approval bridging is added as a separate capability; fail closed until then.
      rpc.respond(id, { decision: "decline" });
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

class CodexSession implements BridgeSession {
  readonly nativeId: string;
  readonly #rpc: JsonLineRpc;
  readonly #emit: (event: BridgeEvent) => void;
  readonly #closed: () => void;
  #activeTurn: string | undefined;

  constructor(
    rpc: JsonLineRpc,
    nativeId: string,
    emit: (event: BridgeEvent) => void,
    closed: () => void,
  ) {
    this.#rpc = rpc;
    this.nativeId = nativeId;
    this.#emit = emit;
    this.#closed = closed;
  }

  async send(content: string): Promise<void> {
    const result = await this.#rpc.request<TurnResponse>("turn/start", {
      threadId: this.nativeId,
      input: [{ type: "text", text: content }],
    });
    this.#activeTurn = result.turn.id;
  }

  async cancel(): Promise<void> {
    if (this.#activeTurn === undefined) return;
    await this.#rpc.request("turn/interrupt", {
      threadId: this.nativeId,
      turnId: this.#activeTurn,
    });
  }

  async close(): Promise<void> {
    await this.#rpc.request("thread/unsubscribe", { threadId: this.nativeId });
    this.#closed();
  }

  notification(method: string, params: ObjectValue): void {
    const turn = object(params.turn);
    const item = object(params.item);
    const turnId =
      text(params, "turnId") ?? text(turn, "id") ?? this.#activeTurn;
    if (turnId === undefined) return;
    if (method === "turn/started") {
      this.#activeTurn = turnId;
      this.#emit({ type: "turn.started", turnId });
      return;
    }
    if (method === "item/agentMessage/delta") {
      const delta = text(params, "delta");
      if (delta !== undefined)
        this.#emit({ type: "assistant.delta", turnId, delta });
      return;
    }
    const itemType = text(item, "type");
    const itemId = text(item, "id");
    if (method === "item/completed" && itemType === "agentMessage") {
      this.#emit({
        type: "assistant.completed",
        turnId,
        content: text(item, "text") ?? "",
      });
      return;
    }
    if (
      itemId !== undefined &&
      (itemType === "commandExecution" || itemType === "mcpToolCall")
    ) {
      if (method === "item/started") {
        this.#emit({
          type: "tool.started",
          turnId,
          toolCallId: itemId,
          tool: itemType,
        });
      } else if (method === "item/completed") {
        this.#emit({
          type: "tool.completed",
          turnId,
          toolCallId: itemId,
          failed: text(item, "status") === "failed",
        });
      }
      return;
    }
    if (method === "turn/completed") {
      const status = text(turn, "status");
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
      }
    }
  }
}
