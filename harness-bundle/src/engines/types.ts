export type BridgeEvent =
  | { type: "turn.started"; turnId: string }
  | { type: "assistant.delta"; turnId: string; delta: string }
  | { type: "assistant.completed"; turnId: string; content: string }
  | { type: "turn.completed"; turnId: string }
  | {
      type: "tool.started";
      turnId: string;
      toolCallId: string;
      tool: string;
    }
  | {
      type: "tool.completed";
      turnId: string;
      toolCallId: string;
      failed: boolean;
    }
  | { type: "turn.cancelled"; turnId: string }
  | { type: "turn.failed"; turnId: string; code: string; message: string };

export type BridgeSession = {
  readonly nativeId: string;
  cancel(): Promise<void>;
  close(): Promise<void>;
  send(content: string): Promise<void>;
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
  close(): Promise<void>;
  status(): Promise<NativeEngineStatus>;
};

export type EngineSessionOptions = {
  mcpServers: readonly import("../mcp-projection.js").ResolvedMcpServer[];
};
