export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type NativeApprovalDecision = "allow" | "reject" | "cancel";
export type NativeApprovalRequest = {
  turnId: string;
  tool: string;
  summary: string;
  input?: unknown;
  options?: JsonValue[];
  signal: AbortSignal;
};
export type ToolDetails = {
  input?: JsonValue;
  output?: JsonValue;
  result?: JsonValue;
  locations?: JsonValue;
  raw?: JsonValue;
};

// Native transports contain JSON. Clone at the boundary so later incremental
// updates cannot mutate an event already handed to the session journal.
export const nativeJson = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

export class NativeApprovalWaits {
  readonly #pending = new Set<AbortController>();
  constructor(readonly callback: EngineSessionOptions["requestApproval"]) {}
  abort(): void {
    for (const controller of this.#pending) controller.abort();
    this.#pending.clear();
  }
  async request(
    request: Omit<NativeApprovalRequest, "signal">,
  ): Promise<NativeApprovalDecision> {
    if (!this.callback) return "cancel";
    const controller = new AbortController();
    this.#pending.add(controller);
    let onAbort!: () => void;
    try {
      return await Promise.race([
        new Promise<NativeApprovalDecision>((resolve) => {
          onAbort = () => resolve("cancel");
          controller.signal.addEventListener("abort", onAbort, { once: true });
        }),
        Promise.resolve()
          .then(() =>
            controller.signal.aborted
              ? ("cancel" as const)
              : this.callback!({ ...request, signal: controller.signal }),
          )
          .catch(() => "cancel" as const),
      ]);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
      this.#pending.delete(controller);
    }
  }
}

export type BridgeEvent =
  | {
      type: "process.updated";
      turnId: string;
      processId: string;
      kind: "plan" | "reasoning";
      text?: string;
      delta?: string;
      data?: JsonValue;
    }
  | { type: "turn.started"; turnId: string }
  | { type: "turn.retrying"; turnId: string; message: string }
  | {
      type: "assistant.delta";
      turnId: string;
      delta: string;
      messageId?: string;
    }
  | {
      type: "assistant.completed";
      turnId: string;
      content: string;
      messageId?: string;
    }
  | { type: "turn.completed"; turnId: string }
  | ({
      type: "tool.started";
      turnId: string;
      toolCallId: string;
      tool: string;
    } & ToolDetails)
  | ({
      type: "tool.completed";
      tool?: string;
      turnId: string;
      toolCallId: string;
      failed: boolean;
    } & ToolDetails)
  | ({
      type: "tool.updated";
      turnId: string;
      toolCallId: string;
      tool?: string;
    } & ToolDetails)
  | { type: "turn.cancelled"; turnId: string }
  | { type: "turn.failed"; turnId: string; code: string; message: string };

export type BridgeSession = {
  readonly nativeId: string;
  readonly permissionMode?:
    | EngineSessionOptions["permissionMode"]
    | "manual_approval";
  cancel(): Promise<void>;
  compact?(): Promise<void>;
  close(): Promise<void>;
  send(
    content: string,
    images?: readonly import("../native-images.js").NativeImage[],
  ): Promise<string>;
  steer(
    content: string,
    images?: readonly import("../native-images.js").NativeImage[],
  ): Promise<string>;
};

export type NativeEngineStatus = {
  available: boolean;
  authenticated: boolean | null;
  state: "ready" | "needs_auth" | "unknown" | "unavailable";
  detail?: string;
};

export type EngineBridge = {
  readonly id: "codex" | "kimi";
  create(
    workspace: string,
    onEvent: (event: BridgeEvent) => void,
    options?: EngineSessionOptions,
  ): Promise<BridgeSession>;
  resume(
    nativeId: string,
    workspace: string,
    onEvent: (event: BridgeEvent) => void,
    options?: EngineSessionOptions,
  ): Promise<BridgeSession>;
  fork(
    nativeId: string,
    workspace: string,
    onEvent: (event: BridgeEvent) => void,
    options: EngineSessionOptions | undefined,
    lastTurnId?: string,
  ): Promise<BridgeSession>;
  close(): Promise<void>;
  status(): Promise<NativeEngineStatus>;
  listModels(): Promise<EngineModel[]>;
};

export type EngineModel = {
  id: string;
  name: string;
  isDefault: boolean;
  reasoning: Array<{ id: string; name: string }>;
  defaultReasoning?: string;
};

export type EngineSessionOptions = {
  requirePermission?: boolean;
  requestApproval?: (
    request: NativeApprovalRequest,
  ) => Promise<NativeApprovalDecision>;
  mcpServers: readonly import("../mcp-projection.js").ResolvedMcpServer[];
  modelId?: string;
  thinkingEffort?: string;
  permissionMode?: "read_only" | "workspace_write" | "full_access";
};
