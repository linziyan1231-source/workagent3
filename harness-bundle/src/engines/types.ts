export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type NativeApprovalDecision =
  | "allow"
  | "reject"
  | "cancel"
  | { optionId: string };
export type NativeApprovalOption = {
  id: string;
  label: string;
  outcome: "allow" | "reject" | "cancel";
  scope: "once" | "session" | "rule" | "remember";
};
export type NativeApprovalRequest = {
  turnId: string;
  tool: string;
  summary: string;
  input?: unknown;
  options?: JsonValue[];
  choices?: NativeApprovalOption[];
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

type ExecutionEvent = Exclude<
  Extract<import("@workagent/contracts").EngineEvent, { turnId: string }>,
  { type: "approval.requested" | "approval.resolved" }
>;
type EventPayload<T> = T extends unknown
  ? Omit<T, "eventId" | "occurredAt" | "sessionId">
  : never;
// Native adapters emit the payload of the actual public event contract. The
// Runtime adds its durable session envelope; there is no second event protocol.
export type BridgeEvent = EventPayload<ExecutionEvent>;
export type BridgeSession = {
  readonly nativeId: string;
  // False once the backing engine process is gone; the runtime must
  // re-activate instead of reusing the dead session.
  readonly connected: boolean;
  commands?(): NativeCommandCatalog;
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
  readonly id: "codex" | "kimi" | "acp";
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

export type NativeCommandCatalog = {
  supported: boolean;
  revision: number;
  items: Array<{
    id: string;
    label: string;
    description?: string;
    inputHint?: string;
  }>;
};

export type EngineModel = {
  id: string;
  name: string;
  isDefault: boolean;
  reasoning: Array<{ id: string; name: string }>;
  defaultReasoning?: string;
};

export type EngineSessionOptions = {
  approvalPolicy?: "on_risk" | "never";
  systemPrompt?: string;
  nativeSkillPaths?: readonly string[];
  skills?: readonly import("../skill-projection.js").ResolvedSkill[];
  catalogSkills?: readonly import("../skill-projection.js").ResolvedSkill[];
  nativeMcpNames?: readonly string[];
  nativeMcpConfig?: Record<string, Record<string, unknown>>;
  requirePermission?: boolean;
  requestApproval?: (
    request: NativeApprovalRequest,
  ) => Promise<NativeApprovalDecision>;
  mcpServers: readonly import("../mcp-projection.js").ResolvedMcpServer[];
  modelId?: string;
  thinkingEffort?: string;
  permissionMode?: "read_only" | "workspace_write" | "full_access";
};
