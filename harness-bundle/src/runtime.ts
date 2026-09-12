import type { EngineEvent } from "@workagent/contracts";
import { randomUUID } from "node:crypto";
import {
  SessionBusyError,
  type ExecutionAdmission,
} from "./execution-admission.js";
import { ManagedAcpCatalog } from "./acp-catalog.js";
import type { AcpCatalogEntry, EngineId } from "@workagent/contracts";
import {
  resolveExecutionConfiguration,
  ExecutionConfigurationError,
} from "./execution-configuration.js";
import {
  marketChangeSchema,
  remapCapabilityIds,
  projectCapabilityBinding,
  runtimeMarketCapabilities,
  type MarketChange,
} from "./market-capabilities.js";
import { butlerServer } from "./butler-mcp.js";
import { messageServer } from "./message-mcp.js";
import { sessionToolsServer } from "./session-tools-mcp.js";
import { sharedTrashServer } from "./shared-trash-mcp.js";
import { RuntimePreferences } from "./runtime-preferences.js";
import { nativeImages, nativeFileInput } from "./native-images.js";
import {
  automationSkillPrompt,
  validatedSkillSuggestion,
} from "./automation-skills.js";
import {
  CompletionNotifications,
  type NotificationTransport,
} from "./completion-notifications.js";
import { mountCompletionNotifications } from "./completion-notifications-api.js";
import {
  CollaborationChannels,
  collaborationId,
} from "./collaboration-channels.js";
import { dirname, resolve as resolvePath } from "node:path";
import { statSync } from "node:fs";
import {
  SharedAwareness,
  isAbsoluteWorkspacePath,
  resolveSharedProjectRoot,
  sharedChangesText,
} from "./shared-awareness.js";
import {
  channelEngine,
  channelAssistantContext,
  channelPermission,
  channelModelCatalog,
  channelEvent,
  type ChannelConfig,
  type ChannelEvent,
} from "./channel-runtime.js";
import { ConversationQuota, quotaMessage } from "./conversation-quota.js";
import {
  PlatformQuotaClient,
  type AutomationQuotaPort,
} from "./quota-client.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import {
  installModelSelection,
  type AgentHandle,
} from "@deepseek-ai/dsh-agent";
import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { apply as installMcp } from "@deepseek-ai/dsh-mcp-client";
import { apply as installSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";
import {
  SessionId,
  type Session,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import { CodexBridge } from "./engines/codex.js";
import { discoverModels } from "./model-discovery.js";
import { KimiBridge } from "./engines/kimi.js";
import type {
  BridgeEvent,
  BridgeSession,
  EngineBridge,
  NativeApprovalRequest,
} from "./engines/types.js";
import { authorized } from "./runtime-http.js";
import { ApprovalBridge } from "./approval-bridge.js";
import {
  SessionIndex,
  type StoredSession,
  type QueuedInput,
  type SessionCreation,
} from "./session-index.js";
import { ENGINE_CAPABILITIES } from "./engine-registry.js";
import { WorkspaceStore } from "./workspace-store.js";
import { MessageStore, type StoredMessage } from "./message-store.js";
import type {
  AutomationExecution,
  AutomationRunnerPort,
} from "./automation-store.js";
import type {
  CredentialStatus,
  PresetBinding,
  RuntimeMessage,
  RuntimeSession,
  SharedTurnResult,
  SharedTurnRuntimeRequest,
} from "@workagent/contracts";
import type { PresetStore } from "./preset-store.js";
import type { McpCatalogStore, SkillCatalogStore } from "./capability-store.js";
import type { ResolvedMcpServer } from "./mcp-projection.js";
import type { ResolvedSkill } from "./skill-projection.js";
import type {
  TeamExecution,
  TeamRunnerPort,
  TeamSessionPort,
  TeamSessionRequest,
} from "./team-store.js";
import type { InboxExecution, InboxRunnerPort } from "./inbox-api.js";
import { projectHarnessMcpServers } from "./engines/harness-mcp.js";
import { installHarnessPrompt } from "./engines/harness-configuration.js";
import type { NativeSessionPort } from "./native-session-port.js";
import type {} from "@deepseek-ai/dsh-session-title";
import type {
  NativeSessionLog,
  NativeSessionEvent,
} from "./native-session-log.js";
import type { CredentialStatusStore } from "./model-access-store.js";

export const automationTargetSessionId = (
  automationRunId: string,
  definition: AutomationExecution["definition"],
): string => {
  if (definition.executionMode === "existing") {
    if (definition.conversationId === null)
      throw new Error("automation_conversation_required");
    return definition.conversationId;
  }
  return `session-${automationRunId}`;
};

export const nativeCredentialError = (
  engine: EngineId,
  credential: CredentialStatus | undefined,
): string | undefined =>
  engine === "harness" || engine === "acp" || credential?.state === "ready"
    ? undefined
    : `credential_needs_auth:${engine}`;

export const searchRuntimeMessages = (
  items: Array<{ session: RuntimeSession; message: RuntimeMessage }>,
  keyword: string,
  page: number,
  pageSize: number,
  sessionId?: string,
) => {
  const normalizedKeyword = keyword.toLocaleLowerCase();
  const matches = items
    .filter(
      ({ session }) => sessionId === undefined || session.id === sessionId,
    )
    .filter(({ message }) =>
      message.text.toLocaleLowerCase().includes(normalizedKeyword),
    )
    .sort(
      (left, right) =>
        Date.parse(right.message.createdAt) -
        Date.parse(left.message.createdAt),
    );
  const offset = page * pageSize;
  return {
    items: matches.slice(offset, offset + pageSize),
    total: matches.length,
    page,
    pageSize,
    hasMore: offset + pageSize < matches.length,
  };
};

export const planMessageFork = (
  messages: readonly StoredMessage[],
  messageId: string,
  editing: boolean,
  requireNativeTurn = true,
) => {
  const selectedIndex = messages.findIndex(
    (message) =>
      message.id === messageId &&
      (message.role === "user" || (!editing && message.role === "assistant")),
  );
  if (selectedIndex === -1) throw new Error("fork_message_not_found");
  const selected = messages[selectedIndex]!;
  if (requireNativeTurn && selected.nativeTurnId === undefined)
    throw new Error("message_turn_unavailable");
  const previousUser = messages
    .slice(0, selectedIndex)
    .reverse()
    .find((message) => message.role === "user");
  const nextUserIndex = messages.findIndex(
    (message, index) => index > selectedIndex && message.role === "user",
  );
  return {
    selectedTurnId: selected.nativeTurnId,
    previousTurnId: previousUser?.nativeTurnId,
    hasLaterUser: nextUserIndex !== -1,
    copiedMessages: messages.slice(
      0,
      editing
        ? selectedIndex
        : selected.role === "assistant"
          ? selectedIndex + 1
          : nextUserIndex === -1
            ? messages.length
            : nextUserIndex,
    ),
  };
};

type SessionRecord = {
  createdAt: string;
  engine: EngineId;
  acpCatalogId?: string;
  acpCatalogRevision?: string;
  acpSnapshot?: AcpCatalogEntry;
  events: PublicEvent[];
  activity?: ReturnType<typeof sessionActivity>;
  lastTurn?: RuntimeSession["lastTurn"];
  handle: AgentHandle | undefined;
  native: BridgeSession | undefined;
  nativeId: string;
  nextEventSequence: number;
  activating: Promise<void> | undefined;
  title: string;
  updatedAt: string;
  workspaceId: string;
  workspacePath?: string;
  channelKey?: string;
  internal?: boolean;
  modelId?: string;
  thinkingEffort?: string;
  permissionMode?: "read_only" | "workspace_write" | "full_access";
  requirePermission?: boolean;
  preset: PresetBinding;
  parentSessionId?: string;
  branchKind?: "fork" | "edit" | "side_chat";
  anchorMessageId?: string;
  contextMode?: "native" | "transcript";
  pendingContext?: string | undefined;
  fileRevision?: number;
  sharedCursor?: number;
  inputPending?: boolean;
  queue?: QueuedInput[];
  creation?: SessionCreation;
};

const branchMetadata = (record: SessionRecord) => ({
  ...(record.acpSnapshot
    ? {
        acpCatalogId: record.acpSnapshot.id,
        acpCatalogRevision: record.acpSnapshot.revision,
        acpSnapshot: record.acpSnapshot,
      }
    : {}),
  ...(record.parentSessionId
    ? { parentSessionId: record.parentSessionId }
    : {}),
  ...(record.branchKind ? { branchKind: record.branchKind } : {}),
  ...(record.anchorMessageId
    ? { anchorMessageId: record.anchorMessageId }
    : {}),
  ...(record.contextMode ? { contextMode: record.contextMode } : {}),
});

export const branchTranscript = (messages: readonly StoredMessage[]) =>
  messages.length === 0
    ? undefined
    : "以下 JSON 是此会话分支继承的历史对话，仅作为前文背景。不要重新执行历史请求；只处理随后给出的新消息。\n" +
      JSON.stringify(
        messages.map(({ role, text }) => ({ role, content: text })),
      ) +
      "\n以上是历史对话。下面是新消息：\n";

type PublicEvent = Record<string, unknown> & {
  eventId: string;
  occurredAt: string;
  sessionId: string;
  type: string;
};

const activityEventTypes = new Set([
  "turn.started",
  "turn.retrying",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
]);
export const sessionActivity = (events: readonly PublicEvent[]) => {
  const event = events.findLast((event) => activityEventTypes.has(event.type));
  return {
    state:
      event?.type === "turn.started"
        ? "running"
        : event?.type === "turn.retrying"
          ? "retrying"
          : "idle",
    ...(event?.type === "turn.retrying" || event?.type === "turn.failed"
      ? { message: event.message }
      : {}),
  };
};

export const eventsAfterLastId = <T extends { eventId: string }>(
  events: readonly T[],
  lastEventId: string | undefined,
): readonly T[] => {
  if (lastEventId === undefined) return events;
  const lastIndex = events.findIndex((event) => event.eventId === lastEventId);
  return lastIndex === -1 ? events : events.slice(lastIndex + 1);
};

const writeJson = (
  response: ServerResponse,
  status: number,
  value: unknown,
): void => {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(value));
};

const readJson = async (
  request: IncomingMessage,
): Promise<Record<string, unknown>> => {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 64 * 1024) throw new Error("request body is too large");
  }
  const parsed: unknown = JSON.parse(body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON object required");
  }
  return parsed as Record<string, unknown>;
};

export const normalizeEvent = (
  session: Session,
  event: SessionEvent,
): EngineEvent | undefined => {
  const base = {
    eventId: `${session.id}-${event.seq}`,
    occurredAt: new Date(event.time).toISOString(),
    sessionId: String(session.id),
  };
  switch (event.type) {
    case "turn/start":
      return {
        ...base,
        type: "turn.started",
        turnId: `turn-${event.data.turn}`,
      };
    case "assistant/chunk":
      return event.data.chunk.type === "text-delta"
        ? {
            ...base,
            type: "assistant.delta",
            turnId: `turn-${event.data.turn}`,
            delta: event.data.chunk.text,
          }
        : undefined;
    case "assistant/message": {
      const content = event.data.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return {
        ...base,
        type: "assistant.completed",
        turnId: `turn-${event.data.turn}`,
        content,
      };
    }
    case "tool/call":
      return {
        ...base,
        type: "tool.started",
        turnId: `turn-${event.data.turn}`,
        toolCallId: String(event.data.callId),
        tool: event.data.name,
      };
    case "tool/result":
      return {
        ...base,
        type: "tool.completed",
        turnId: `turn-${event.data.turn}`,
        toolCallId: String(event.data.message.content[0].toolCallId),
        failed: event.data.message.content[0].isError === true,
      };
    case "turn/end":
      if (event.data.reason.kind === "aborted") {
        return {
          ...base,
          type: "turn.cancelled",
          turnId: `turn-${event.data.turn}`,
        };
      }
      if (event.data.reason.kind === "error") {
        return {
          ...base,
          type: "turn.failed",
          turnId: `turn-${event.data.turn}`,
          code: event.data.reason.error.code,
          message: event.data.reason.error.message,
        };
      }
      if (event.data.reason.kind === "completed")
        return {
          ...base,
          type: "turn.completed",
          turnId: `turn-${event.data.turn}`,
        };
      return {
        ...base,
        type: "turn.failed",
        turnId: `turn-${event.data.turn}`,
        code: `turn_${event.data.reason.kind.replace("-", "_")}`,
        message: `Turn ended with ${event.data.reason.kind}`,
      };
    default:
      return undefined;
  }
};

export class RuntimeController
  implements
    AutomationRunnerPort,
    TeamRunnerPort,
    InboxRunnerPort,
    TeamSessionPort
{
  /** Public DSH transport delegates to the same native admission/queue/fork implementation. */
  readonly nativeSessionPort: NativeSessionPort = {
    approvals: () => this.#approvals.pendingNative(),
    respondApproval: (sessionId, approvalId, decision) =>
      this.nativeSessionPort.owns(sessionId) &&
      this.#approvals.respondNative(sessionId, approvalId, decision),
    owns: (id) => {
      const record = this.#sessions.get(id);
      return !!record && record.engine !== "harness" && !record.internal;
    },
    list: () =>
      [...this.#sessions]
        .filter(([id]) => this.nativeSessionPort.owns(id))
        .map(([id, record]) => ({
          id,
          engine: record.engine,
          title: record.title,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          workspaceId: record.workspaceId,
          workspacePath: this.#engineWorkspace(record),
          preset: record.preset,
          activity: {
            state: (record.activity?.state ?? "idle") as
              | "idle"
              | "running"
              | "retrying",
            ...(typeof record.activity?.message === "string"
              ? { message: record.activity.message }
              : {}),
          },
          lastTurn: record.lastTurn,
          ...branchMetadata(record),
        })),
    session: (id) =>
      this.nativeSessionPort.owns(id)
        ? this.#ctx.sessions?.get(SessionId(id))
        : undefined,
    messages: (id) => {
      this.#nativeRecord(id);
      return this.#messages.list(id);
    },
    queue: (id) => this.#nativeRecord(id).queue ?? [],
    prompt: async (
      id,
      content,
      mode,
      messageId = `message-${randomUUID()}`,
    ) => {
      const record = this.#nativeRecord(id);
      if (!content.trim()) throw new Error("content_required");
      if (!messageId || messageId.length > 200)
        throw new Error("invalid_message_id");
      const known = this.#messages.list(id).find((row) => row.id === messageId);
      const queued = record.queue?.find((row) => row.messageId === messageId);
      if (known || queued) {
        if ((known?.text ?? queued?.content) !== content)
          throw new Error("message_id_conflict");
        return;
      }
      if (
        record.inputPending &&
        (!record.activity || record.activity.state === "idle")
      )
        throw new Error("session_input_pending");
      const input = { messageId, content };
      if (
        mode === "queue" &&
        (record.inputPending ||
          (record.activity && record.activity.state !== "idle"))
      ) {
        record.queue ??= [];
        record.queue.push(input);
        this.#queueChanged(id, record);
      } else {
        await this.#deliverInput(
          id,
          record,
          input,
          mode === "steer" &&
            !!record.activity &&
            record.activity.state !== "idle",
        );
      }
    },
    cancel: async (id) => {
      const record = this.#nativeRecord(id);
      if (record.activating) await record.activating;
      await record.native?.cancel();
    },
    updateQueue: async (id, itemId, action) => {
      const record = this.#nativeRecord(id);
      const item = record.queue?.find((row) => row.messageId === itemId);
      if (!item) throw new Error("queued_message_not_found");
      if (record.inputPending) throw new Error("session_input_pending");
      if (action.kind === "steer") {
        await this.#deliverInput(id, record, item, true);
        return;
      }
      if (action.kind === "edit") {
        if (action.content.some((part) => part.type !== "text"))
          throw new Error("text_input_only");
        const content = action.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
        if (!content.trim()) throw new Error("content_required");
        item.content = content;
        delete item.displayContent;
        delete item.error;
      } else record.queue = record.queue!.filter((row) => row !== item);
      this.#queueChanged(id, record);
    },
    fork: (id, messageId) =>
      this.#forkSession(id, this.#nativeRecord(id), messageId),
    rename: (id, title) => {
      const record = this.#nativeRecord(id);
      if (!title.trim() || title.length > 200) throw new Error("invalid_title");
      record.title = title.trim();
      record.updatedAt = new Date().toISOString();
      this.#persist(id, record);
      this.#nativeLog?.get(id)?.append("session/title", {
        title: record.title,
        messageSeqs: [],
        source: { kind: "user" },
      });
      return record.title;
    },
    models: async (id) => {
      const record = this.#nativeRecord(id);
      const models = await (await this.#bridge(record)).listModels();
      const model =
        record.modelId &&
        !["codex-native", "kimi-native"].includes(record.modelId)
          ? record.modelId
          : models.find((row) => row.isDefault)?.id;
      if (!model) throw new Error("engine_model_unavailable");
      return {
        current: {
          provider: record.engine,
          model,
          ...(record.thinkingEffort
            ? { reasoningEffort: record.thinkingEffort }
            : {}),
        },
        routable: true,
        groups: [
          {
            id: record.engine,
            name:
              record.engine === "codex"
                ? "Codex"
                : record.engine === "acp"
                  ? (record.acpSnapshot?.label ?? "ACP")
                  : "Kimi",
            models: models.map((row) => ({
              id: row.id,
              name: row.name,
              ...(row.reasoning?.length
                ? {
                    reasoning: {
                      efforts: row.reasoning,
                      ...(row.defaultReasoning
                        ? { defaultEffort: row.defaultReasoning }
                        : {}),
                    },
                  }
                : {}),
            })),
          },
        ],
        failures: [],
      };
    },
    selectModel: async (id, selection) => {
      const record = this.#nativeRecord(id);
      if (
        record.inputPending ||
        (record.activity && record.activity.state !== "idle")
      )
        throw new Error("session_input_pending");
      if (selection.provider !== record.engine)
        throw new Error("engine_model_mismatch");
      const models = await (await this.#bridge(record)).listModels();
      const model = models.find((row) => row.id === selection.model);
      if (this.#sessions.get(id) !== record)
        throw new Error("session_not_found");
      if (
        !model ||
        (selection.reasoningEffort !== undefined &&
          !model.reasoning.some(
            (effort) => effort.id === selection.reasoningEffort,
          ))
      )
        throw new Error("engine_model_unavailable");
      // Re-reserve after the async catalog read; another ingress may have started a turn.
      if (
        record.inputPending ||
        (record.activity && record.activity.state !== "idle")
      )
        throw new Error("session_input_pending");
      record.inputPending = true;
      const previous = {
        modelId: record.modelId,
        thinkingEffort: record.thinkingEffort,
      };
      try {
        await record.native?.close();
        record.native = undefined;
        if (this.#sessions.get(id) !== record)
          throw new Error("session_not_found");
        record.modelId = selection.model;
        if (selection.reasoningEffort === undefined)
          delete record.thinkingEffort;
        else record.thinkingEffort = selection.reasoningEffort;
        await this.#activate(id, record);
        if (this.#sessions.get(id) !== record)
          throw new Error("session_not_found");
        this.#persist(id, record);
        return { ...selection };
      } catch (error) {
        Object.assign(record, previous);
        throw error;
      } finally {
        record.inputPending = false;
      }
    },
  };

  #nativeRecord(id: string): SessionRecord {
    if (!this.nativeSessionPort.owns(id)) throw new Error("session_not_found");
    return this.#sessions.get(id)!;
  }
  readonly #ctx: Context;
  readonly #preferences: RuntimePreferences;
  #drainUntil = 0;
  get #draining() {
    return this.#drainUntil > Date.now();
  }
  #activityExtra: () => { active: boolean; nextWakeAt: string | null } =
    () => ({ active: true, nextWakeAt: null });
  readonly #token: string;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #sessionDeletions = new Map<string, Promise<void>>();
  readonly #subscribers = new Map<string, Set<ServerResponse>>();
  readonly #eventListeners = new Map<
    string,
    Set<(event: PublicEvent) => void>
  >();
  readonly #automationExecutions = new Map<
    string,
    Promise<{ sessionId: string; result?: string }>
  >();
  readonly #automationTargets = new Map<string, string>();
  readonly #cancelledBackground = new Set<string>();
  readonly #backgroundAdmissions = new Map<string, string>();
  readonly #toolScopes = new Map<string, string>();
  #teamInputHandler:
    | ((sessionId: string, input: QueuedInput) => boolean)
    | undefined;
  setTeamInputHandler(
    handler: (sessionId: string, input: QueuedInput) => boolean,
  ): void {
    this.#teamInputHandler = handler;
  }

  validateToolScope(sessionId: string, scopeToken: string): boolean {
    return (
      typeof scopeToken === "string" &&
      this.#toolScopes.get(sessionId) === scopeToken
    );
  }
  sessionToolContext(sessionId: string) {
    const record = this.#sessions.get(sessionId);
    if (!record || record.internal) throw new Error("session_not_found");
    return {
      sessionId,
      engine: record.engine,
      presetId: record.preset.presetId,
      workspaceId: record.workspaceId,
      ...(record.preset.resolvedSnapshot.acpCatalogId
        ? { acpCatalogId: record.preset.resolvedSnapshot.acpCatalogId }
        : {}),
    };
  }
  #sessionMcpServers(
    id: string,
    servers: readonly ResolvedMcpServer[],
  ): readonly ResolvedMcpServer[] {
    let token = this.#toolScopes.get(id);
    if (!token) {
      token = randomUUID();
      this.#toolScopes.set(id, token);
    }
    return [...servers, sessionToolsServer(id, token)];
  }
  readonly #automationNotifications = new Map<
    string,
    { runId: string; enabled: boolean; targetId: string }
  >();
  readonly #sharedTurnExecutions = new Map<string, Promise<SharedTurnResult>>();
  readonly #sharedTurnTargets = new Map<string, string>();
  readonly #bridges = new Map<"codex" | "kimi", EngineBridge>();
  readonly #acp: ManagedAcpCatalog;
  readonly #index: SessionIndex;
  readonly #workspaces: WorkspaceStore;
  #sharedFiles?: WorkspaceStore;
  setSharedFileStore(store: WorkspaceStore) {
    this.#sharedFiles = store;
    store.moves.busy = (id) =>
      !store.get(id) ||
      [...this.#sessions.values()].some(
        (record) =>
          record.workspacePath === store.engineRoot(id) &&
          (record.inputPending ||
            record.activating ||
            (record.activity && record.activity.state !== "idle")),
      );
  }
  readonly #messages: MessageStore;
  readonly #presets: PresetStore;
  readonly #mcp: McpCatalogStore;
  readonly #skills: SkillCatalogStore;
  readonly #credentials: CredentialStatusStore;
  readonly #conversationQuota: ConversationQuota;
  readonly #completionNotifications: CompletionNotifications;
  readonly #collaborationChannels: CollaborationChannels | undefined;
  readonly #nativeLog: NativeSessionLog | undefined;
  readonly #approvals: ApprovalBridge;
  readonly #nativeMetadata = new Map<string, string>();
  readonly #nativeAttached = new Set<string>();
  readonly #awareness = new SharedAwareness();

  constructor(
    ctx: Context,
    token: string,
    workspaces: WorkspaceStore,
    presets: PresetStore,
    mcp: McpCatalogStore,
    skills: SkillCatalogStore,
    credentials: CredentialStatusStore,
    quota:
      | AutomationQuotaPort
      | undefined = PlatformQuotaClient.fromEnvironment(),
    nativeLog?: NativeSessionLog,
  ) {
    this.#ctx = ctx;
    this.#token = token;
    const dshHome = process.env.DSH_HOME;
    if (dshHome === undefined)
      throw new Error("workagent-runtime-api: DSH_HOME is required");
    this.#preferences = new RuntimePreferences(dshHome);
    this.#acp = new ManagedAcpCatalog(dshHome);
    this.#preferences.mount(ctx, token);
    this.#conversationQuota = new ConversationQuota(dshHome, quota);
    this.#index = new SessionIndex(dshHome);
    this.#messages = new MessageStore(dshHome);
    this.#nativeLog = nativeLog;
    this.#workspaces = workspaces;
    workspaces.moves.busy = (id) =>
      [...this.#sessions.values()].some(
        (record) =>
          record.workspaceId === id &&
          (record.inputPending ||
            record.activating ||
            (record.activity && record.activity.state !== "idle")),
      );

    this.#completionNotifications = new CompletionNotifications(
      dshHome,
      workspaces,
      process.env.WORKAGENT_PUBLIC_BASE_URL,
    );
    this.#collaborationChannels =
      CollaborationChannels.fromEnvironment(dshHome);
    if (this.#collaborationChannels) {
      const channels = this.#collaborationChannels;
      this.#completionNotifications.attachCollaboration(channels);
      ctx.effect(() => {
        const poll = () =>
          void channels
            .poll(this.#completionNotifications)
            .catch((error) =>
              console.error("collaboration notification poll failed", error),
            );
        poll();
        const timer = setInterval(poll, 5000);
        timer.unref();
        return () => clearInterval(timer);
      }, "collaboration completion notifications");
    }
    mountCompletionNotifications(
      ctx,
      token,
      this.#completionNotifications,
      async (id) => {
        const sharedId = collaborationId(id);
        if (sharedId) {
          await this.#collaborationChannels?.access(sharedId);
          return Boolean(this.#collaborationChannels);
        }
        return this.#sessions.has(id);
      },
    );
    this.#presets = presets;
    this.#mcp = mcp;
    this.#skills = skills;
    this.#credentials = credentials;
    const storedSessions = this.#index.list();
    const defaultWorkspaceId = storedSessions.some(
      (session) => session.workspaceId === undefined,
    )
      ? workspaces.ensureDefault().id
      : "default";
    this.#bridges.set("codex", new CodexBridge());
    this.#bridges.set("kimi", new KimiBridge());
    for (const session of storedSessions) {
      const record = this.#record(session, defaultWorkspaceId);
      this.#sessions.set(session.id, record);
      this.#openNativeLog(session.id, record);
      if (session.workspaceId === undefined || session.preset === undefined)
        this.#persist(session.id, record);
    }
    this.#approvals = new ApprovalBridge(
      ctx,
      token,
      dshHome,
      (sessionId, event) => {
        const record = this.#sessions.get(sessionId);
        if (record === undefined) return;
        this.#publish(record, {
          ...event,
          eventId: `${sessionId}-interaction-${record.nextEventSequence++}`,
          occurredAt: new Date().toISOString(),
          sessionId,
        });
      },
    );
  }

  #openNativeLog(id: string, record: SessionRecord): void {
    const log = this.#nativeLog;
    if (
      !log ||
      record.engine === "harness" ||
      record.internal ||
      this.#nativeAttached.has(id)
    )
      return;
    if (!log.get(id))
      log.open(
        {
          id,
          engine: record.engine,
          workspacePath: this.#engineWorkspace(record),
          createdAt: record.createdAt,
          ...(record.nativeId ? { nativeId: record.nativeId } : {}),
          ...(record.parentSessionId
            ? { parentSessionId: record.parentSessionId }
            : {}),
        },
        this.#messages.list(id),
      );
    this.#messages.project(id, {
      list: () => log.messages(id),
      append: (message) => log.appendMessage(message),
      delete: () => log.delete(id),
    });
    this.#nativeAttached.add(id);
    log.appendEvent(id, {
      type: "session.capabilities",
      engine: record.engine,
      send: true,
      cancel: true,
      queue: "persistent-workagent",
      resume: "native",
      steer: record.engine === "codex" ? "native-turn" : "cancel-and-resubmit",
      fork: record.engine === "codex" ? "native-or-transcript" : "transcript",
      edit: "transcript-or-native-branch",
      sideChat: "isolated-transcript",
      modelSelection: "idle-native-resume",
      approval: true,
      modelSteps: false,
      modelRequestInspection: false,
      rawToolDetails: true,
    });
    this.#publishNativeMetadata(id, record);
  }

  #publishNativeMetadata(id: string, record: SessionRecord): void {
    if (!this.#nativeLog?.get(id)) return;
    const metadata = JSON.parse(
      JSON.stringify({
        type: "session.metadata",
        id,
        engine: record.engine,
        title: record.title,
        workspaceId: record.workspaceId,
        workspacePath: this.#engineWorkspace(record),
        modelId: record.modelId,
        thinkingEffort: record.thinkingEffort,
        permissionMode: record.permissionMode,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        preset: record.preset,
        activity: record.activity ?? { state: "idle" },
        lastTurn: record.lastTurn,
        queue: record.queue ?? [],
        ...branchMetadata(record),
      }),
    ) as NativeSessionEvent;
    const encoded = JSON.stringify(metadata);
    if (this.#nativeMetadata.get(id) === encoded) return;
    this.#nativeLog.appendEvent(id, metadata);
    this.#nativeMetadata.set(id, encoded);
  }

  workspaceForSession(sessionId: string): string | undefined {
    const record = this.#sessions.get(sessionId);
    return record?.internal === true ? undefined : record?.workspaceId;
  }

  executeSharedTurn(
    request: SharedTurnRuntimeRequest,
  ): Promise<SharedTurnResult> {
    const active = this.#sharedTurnExecutions.get(request.runId);
    if (active !== undefined) return active;
    const execution = this.#executeSharedTurn(request).finally(() => {
      this.#sharedTurnExecutions.delete(request.runId);
      this.#sharedTurnTargets.delete(request.runId);
    });
    this.#sharedTurnExecutions.set(request.runId, execution);
    return execution;
  }

  async cancelSharedTurn(runId: string): Promise<void> {
    const sessionId = this.#sharedTurnTargets.get(runId);
    if (sessionId === undefined) return;
    const record = this.#sessions.get(sessionId);
    if (record === undefined || record.internal !== true) return;
    await this.#activate(sessionId, record);
    if (record.handle !== undefined)
      record.handle.agent.cancel({ kind: "user" });
    else await record.native!.cancel();
  }

  admit(request: AutomationExecution): ExecutionAdmission {
    return this.#admitSession(
      automationTargetSessionId(request.automationRunId, request.definition),
      request.automationRunId,
    );
  }

  admitTeamTask(request: TeamExecution): ExecutionAdmission {
    return this.#admitSession(request.sessionId, request.taskId);
  }

  async billingModel(
    request: AutomationExecution,
    recovery = false,
  ): Promise<string> {
    const id = automationTargetSessionId(
      request.automationRunId,
      request.definition,
    );
    if (!recovery) {
      if (request.definition.executionMode === "existing")
        await this.#existingAutomationSession(id, request.definition);
      else await this.#startAutomationSession(id, request);
    }
    const record = this.#sessions.get(id);
    if (!record?.acpSnapshot)
      throw new Error("acp_accounting_snapshot_missing");
    return record.acpSnapshot.billingModelId;
  }

  async teamBillingModel(
    request: TeamExecution,
    recovery = false,
  ): Promise<string> {
    if (!recovery)
      await this.openTeamSession({
        sessionId: request.sessionId,
        title: request.name,
        engine: request.engine,
        acpCatalogId: request.acpCatalogId,
        presetId: request.presetId,
        workspaceId: request.workspaceId,
      });
    const record = this.#sessions.get(request.sessionId);
    if (!record?.acpSnapshot)
      throw new Error("acp_accounting_snapshot_missing");
    return record.acpSnapshot.billingModelId;
  }

  #admitSession(sessionId: string, executionId: string): ExecutionAdmission {
    if (this.#draining) throw new Error("runtime_draining");
    if (this.#cancelledBackground.has(executionId))
      throw new Error("background_execution_cancelled");
    if (this.#backgroundAdmissions.get(sessionId) === executionId)
      return { release() {} };
    const record = this.#sessions.get(sessionId);
    if (
      this.#backgroundAdmissions.has(sessionId) ||
      record?.inputPending ||
      (record?.activity && record.activity.state !== "idle")
    )
      throw new SessionBusyError(sessionId);
    this.#backgroundAdmissions.set(sessionId, executionId);
    if (record) record.inputPending = true;
    return {
      release: () => {
        if (this.#backgroundAdmissions.get(sessionId) !== executionId) return;
        this.#backgroundAdmissions.delete(sessionId);
        this.#cancelledBackground.delete(executionId);
        if (record) {
          record.inputPending = false;
          setTimeout(() => void this.#drainQueue(sessionId, record), 0);
        }
      },
    };
  }

  execute(
    request: AutomationExecution,
  ): Promise<{ sessionId: string; result?: string }> {
    const active = this.#automationExecutions.get(request.automationRunId);
    if (active !== undefined) return active;
    const target = automationTargetSessionId(
      request.automationRunId,
      request.definition,
    );
    this.#automationTargets.set(request.automationRunId, target);
    if (request.definition.id.startsWith("automation-"))
      this.#automationNotifications.set(target, {
        runId: request.automationRunId,
        enabled: request.definition.messageNotificationEnabled,
        targetId: request.definition.messageNotificationTargetId ?? "",
      });
    const execution = this.#executeAutomation(request).finally(() => {
      this.#automationExecutions.delete(request.automationRunId);
      this.#automationTargets.delete(request.automationRunId);
      this.#cancelledBackground.delete(request.automationRunId);
      if (
        this.#automationNotifications.get(target)?.runId ===
        request.automationRunId
      )
        this.#automationNotifications.delete(target);
    });
    this.#automationExecutions.set(request.automationRunId, execution);
    return execution;
  }

  channelService() {
    const owned = (_key: string, id: string) => {
      const record = this.#sessions.get(id);
      if (!record || record.internal)
        throw new Error("channel_session_not_found");
      return record;
    };
    const configuration = (key: string, id: string): ChannelConfig => {
      const record = owned(key, id);
      return {
        provider: `workagent-${record.engine}`,
        presetId: record.preset.presetId,
        model: record.modelId!,
        ...(record.thinkingEffort
          ? { reasoningEffort: record.thinkingEffort }
          : {}),
        cwd: this.#engineWorkspace(record),
        permissionPreset:
          record.permissionMode === "full_access"
            ? "danger-full-access"
            : record.permissionMode === "read_only"
              ? "read-only"
              : "workspace-write",
      };
    };
    return {
      configuration,
      collaboration: this.#collaborationChannels,
      steer: async (key: string, id: string, content: string) => {
        const record = owned(key, id);
        if (!content.trim()) throw new Error("content_required");
        await this.#activate(id, record);
        await this.#deliverInput(
          id,
          record,
          { messageId: "message-" + randomUUID(), content },
          true,
        );
      },
      cancel: (key: string, id: string) => {
        const record = owned(key, id);
        if (record.handle) return record.handle.agent.cancel({ kind: "user" });
        return this.nativeSessionPort.cancel(id);
      },
      history: (_key: string) =>
        [...this.#sessions]
          .filter(([, record]) => !record.internal)
          .map(([id, record]) => ({
            id,
            title: record.title,
            updatedAt: record.updatedAt,
            workspaceId: record.workspaceId,
            workspaceName:
              this.#workspaces.get(record.workspaceId)?.name || "默认项目",
            active: Boolean(
              record.inputPending ||
                record.activating ||
                record.queue?.length ||
                (record.activity && record.activity.state !== "idle"),
            ),
          }))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      projects: () =>
        [{ id: "default", name: "默认项目" }, ...this.#workspaces.list()].map(
          (project) => ({
            id: project.id,
            name: project.name,
            cwd: this.#workspaces.engineRoot(project.id),
          }),
        ),
      resume: async (key: string, id: string) => {
        const record = owned(key, id);
        if (
          record.inputPending ||
          record.activating ||
          record.queue?.length ||
          (record.activity && record.activity.state !== "idle")
        )
          throw new Error("session_input_pending");
        await this.#activate(id, record);
        return this.#channelHandle(id, record, key);
      },
      activeChannel: (id: string) => this.#channelRuns.get(id)?.key,
      rename: (key: string, id: string, title: string) => {
        const record = owned(key, id);
        if (record.engine === "harness") {
          if (!title.trim() || title.length > 200)
            throw new Error("invalid_title");
          record.title = title.trim();
          record.updatedAt = new Date().toISOString();
          this.#persist(id, record);
          return record.title;
        }
        return this.nativeSessionPort.rename(id, title);
      },
      sessionModels: async (key: string, id: string) => {
        const record = owned(key, id);
        if (record.engine === "harness") {
          const groups = channelModelCatalog(
            await discoverModels(this.#ctx, new Map()),
          );
          return {
            current: { provider: "harness", model: record.modelId! },
            routable: true,
            groups,
            failures: [],
          };
        }
        return this.nativeSessionPort.models(id);
      },
      selectModel: async (key: string, id: string, model: string) => {
        const record = owned(key, id);
        if (record.engine === "harness") {
          if (
            record.inputPending ||
            record.activating ||
            (record.activity && record.activity.state !== "idle")
          )
            throw new Error("session_input_pending");
          const groups = await discoverModels(this.#ctx, new Map());
          if (!groups[0]?.models.some((row) => row.id === model))
            throw new Error("engine_model_unavailable");
          await record.handle?.dispose();
          record.handle = undefined;
          record.modelId = model;
          delete record.thinkingEffort;
          this.#persist(id, record);
          return configuration(key, id);
        }
        await this.nativeSessionPort.selectModel(id, {
          provider: record.engine,
          model,
        });
        return configuration(key, id);
      },
      compact: async (key: string, id: string) => {
        const record = owned(key, id);
        if (
          record.inputPending ||
          record.activating ||
          (record.activity && record.activity.state !== "idle")
        )
          throw new Error("session_input_pending");
        record.inputPending = true;
        try {
          await this.#activate(id, record);
          if (!record.native?.compact)
            throw new Error("engine_compact_unavailable");
          await record.native.compact();
        } finally {
          record.inputPending = false;
        }
      },
      quota: async (key: string, id: string) => {
        const record = owned(key, id);
        const client = PlatformQuotaClient.fromEnvironment();
        if (!client) throw new Error("quota_not_configured");
        return client.usage(record.modelId!.replace(/^kimi-code\//, ""));
      },
      attachNotifications: (transport: NotificationTransport) =>
        this.#completionNotifications.attach(transport),
      handles: (provider?: string) => channelEngine(provider) !== undefined,
      assistants: () =>
        this.#presets
          .list()
          .filter((preset) => preset.enabled)
          .map(({ id, name, engine, modelId }) => ({
            id,
            name: id === "builtin-general" ? "通用助手" : name,
            provider: `workagent-${engine}`,
            modelId,
          })),
      validateAssistant: (config: ChannelConfig) => {
        const engine = channelEngine(config.provider);
        const preset = this.#presets.resolve(
          config.presetId ||
            (engine === "harness" ? "builtin-general" : `builtin-${engine}`),
        );
        if (preset.resolvedSnapshot.engine !== engine)
          throw new Error("channel_assistant_engine_mismatch");
      },
      models: async () =>
        channelModelCatalog(await discoverModels(this.#ctx, this.#bridges)),
      listSessionIds: () =>
        [...this.#sessions]
          .filter(([, record]) => !record.internal)
          .map(([id]) => id),
      open: (
        config: ChannelConfig,
        sessionId?: string,
        title?: string,
        channelKey?: string,
      ) => this.#openChannel(config, sessionId, title, channelKey),
    };
  }

  async #openChannel(
    config: ChannelConfig,
    sessionId?: string,
    title?: string,
    channelKey?: string,
  ) {
    if (this.#draining) throw new Error("runtime_draining");
    const engine = channelEngine(config.provider);
    if (!engine) throw new Error("unsupported_channel_engine");
    const presetId =
      config.presetId ||
      (engine === "harness" ? "builtin-general" : `builtin-${engine}`);
    const permissionMode = channelPermission(config.permissionPreset);
    const workspacePath = resolvePath(
      config.cwd || this.#workspaces.engineRoot("default"),
    );
    const existing = sessionId ? this.#sessions.get(sessionId) : undefined;
    if (existing?.internal) throw new Error("channel_session_not_found");
    if (
      sessionId &&
      (!existing ||
        existing.engine !== engine ||
        existing.preset.presetId !== presetId ||
        existing.modelId !== config.model ||
        existing.thinkingEffort !== config.reasoningEffort ||
        existing.permissionMode !== permissionMode ||
        resolvePath(this.#engineWorkspace(existing)) !== workspacePath)
    )
      return undefined;
    const credentialError =
      engine === "harness"
        ? undefined
        : nativeCredentialError(
            engine,
            this.#credentials.statusFor(`${engine}-native`),
          );
    if (credentialError) throw new Error(credentialError);
    const id = sessionId ?? `session-channel-${randomUUID()}`;
    let record = existing;
    if (!record) {
      const preset = this.#presets.resolve(presetId);
      if (preset.resolvedSnapshot.engine !== engine)
        throw new Error("channel_assistant_engine_mismatch");
      if (!config.model) throw new Error("channel_model_required");
      const models =
        engine === "harness"
          ? (await discoverModels(this.#ctx, new Map()))[0]!.models
          : await this.#bridges.get(engine)!.listModels();
      const model = models.find((row) => row.id === config.model);
      if (
        !model ||
        (config.reasoningEffort &&
          !model.reasoning.some(
            (effort) => effort.id === config.reasoningEffort,
          ))
      )
        throw new Error("channel_model_unavailable");
      const now = new Date().toISOString();
      const context = channelAssistantContext(
        "",
        engine === "harness" ? [] : this.#resolvedSkills(preset),
      );
      record = {
        engine,
        events: [],
        handle: undefined,
        native: undefined,
        activating: undefined,
        nativeId: id,
        nextEventSequence: 1,
        title: title || "消息渠道会话",
        ...(context
          ? {
              pendingContext: `${context}\n\n`,
            }
          : {}),
        createdAt: now,
        updatedAt: now,
        workspaceId:
          this.#workspaces
            .list()
            .find(
              (workspace) =>
                resolvePath(this.#workspaces.engineRoot(workspace.id)) ===
                workspacePath,
            )?.id ?? "default",
        workspacePath,
        ...(channelKey ? { channelKey } : {}),
        modelId: config.model,
        permissionMode,
        ...(config.reasoningEffort
          ? { thinkingEffort: config.reasoningEffort }
          : {}),
        preset,
      };
      this.#sessions.set(id, record);
      try {
        await this.#activate(id, record);
      } catch (error) {
        this.#sessions.delete(id);
        this.#toolScopes.delete(id);
        throw error;
      }
      this.#persist(id, record);
    } else {
      await this.#activate(id, record);
      this.#persist(id, record);
    }
    return this.#channelHandle(id, record, channelKey);
  }

  // A channel owns a reply route for one input, never the task's runtime.
  readonly #channelRuns = new Map<string, { key: string | undefined }>();

  #channelHandle(id: string, session: SessionRecord, channelKey?: string) {
    return {
      sessionId: id,
      workagent: true,
      followup: async (
        message: {
          id: string;
          content: Array<{ type: string; text?: string }>;
        },
        onEvent: (event: ChannelEvent) => Promise<void>,
      ) => {
        if (this.#sessions.get(id) !== session)
          throw new Error("channel_session_not_found");
        if (
          session.inputPending ||
          session.queue?.length ||
          (session.activity && session.activity.state !== "idle")
        )
          throw new Error("session_input_pending");
        const route = { key: channelKey };
        this.#channelRuns.set(id, route);
        let deliveries = Promise.resolve();
        let finish!: () => void;
        const terminal = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const listener = (event: PublicEvent) => {
          const mapped = channelEvent(event);
          if (mapped) deliveries = deliveries.then(() => onEvent(mapped));
          // Observe delivery failures immediately while the native turn continues.
          void deliveries.catch(() => undefined);
          if (
            ["turn.completed", "turn.failed", "turn.cancelled"].includes(
              event.type,
            )
          ) {
            listeners.delete(listener);
            if (this.#channelRuns.get(id) === route)
              this.#channelRuns.delete(id);
            finish();
          }
        };
        const listeners = this.#eventListeners.get(id) ?? new Set();
        listeners.add(listener);
        this.#eventListeners.set(id, listeners);
        try {
          await this.#deliverInput(
            id,
            session,
            {
              messageId: message.id,
              content: message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text ?? "")
                .join("\n"),
            },
            false,
          );
          await terminal;
          await deliveries;
        } finally {
          if (this.#channelRuns.get(id) === route) this.#channelRuns.delete(id);
          listeners.delete(listener);
          if (!listeners.size) this.#eventListeners.delete(id);
        }
      },
      dispose: async () => {},
    };
  }

  async openTeamSession(request: TeamSessionRequest): Promise<void> {
    if (this.#draining) throw new Error("runtime_draining");
    const existing = this.#sessions.get(request.sessionId);
    if (existing !== undefined) {
      if (existing.handle === undefined && existing.native?.connected !== true)
        await this.#activate(request.sessionId, existing);
      return;
    }
    const workspace = this.#workspaces.get(request.workspaceId);
    if (workspace === undefined) throw new Error("workspace_not_found");
    const preset = this.#presets.resolve(request.presetId);
    if (preset.resolvedSnapshot.engine !== request.engine)
      throw new Error("preset_engine_mismatch");
    const resolvedSkills = this.#resolvedSkills(preset);
    this.#validateSkillCompatibility(request.engine, resolvedSkills);
    const mcpServers = this.#resolvedMcpServers(preset);
    this.#validateMcpCompatibility(request.engine, mcpServers);
    const now = new Date().toISOString();
    const record: SessionRecord = {
      activating: undefined,
      engine: request.engine,
      events: [],
      handle: undefined,
      native: undefined,
      nativeId: request.sessionId,
      nextEventSequence: 1,
      title: request.title,
      createdAt: now,
      updatedAt: now,
      workspaceId: workspace.id,
      ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
      ...(request.thinkingEffort === undefined
        ? {}
        : { thinkingEffort: request.thinkingEffort }),
      ...(request.permissionMode === undefined
        ? {}
        : { permissionMode: request.permissionMode }),
      preset,
    };
    if (request.engine === "harness") {
      record.handle = await this.#createHarness(
        request.sessionId,
        this.#workspaces.engineRoot(record.workspaceId),
        mcpServers,
        resolvedSkills,
        record,
      );
    } else {
      const credentialError = nativeCredentialError(
        request.engine,
        this.#credentials.statusFor(`${request.engine}-native`),
      );
      if (credentialError !== undefined) throw new Error(credentialError);
      const bridge = await this.#bridge(record);
      if (bridge === undefined) throw new Error("engine_unavailable");
      record.native = await bridge.create(
        this.#workspaces.engineRoot(record.workspaceId),
        (event) =>
          this.#publish(
            record,
            this.#nativeEvent(request.sessionId, record, event),
          ),
        {
          mcpServers: this.#sessionMcpServers(request.sessionId, mcpServers),
          ...this.#nativeSkillOptions(resolvedSkills, record),
          requestApproval: (approval) =>
            this.#approvals.requestNative(request.sessionId, approval),
          ...(request.modelId === undefined
            ? {}
            : { modelId: request.modelId }),
          ...(request.thinkingEffort === undefined
            ? {}
            : { thinkingEffort: request.thinkingEffort }),
          ...(request.permissionMode === undefined
            ? {}
            : { permissionMode: request.permissionMode }),
        },
      );
      record.nativeId = record.native.nativeId;
    }
    this.#sessions.set(request.sessionId, record);
    this.#persist(request.sessionId, record);
  }

  async executeTeamTask(
    request: TeamExecution,
  ): Promise<{ sessionId: string; result?: string }> {
    await this.openTeamSession({
      sessionId: request.sessionId,
      title: request.name,
      engine: request.engine,
      presetId: request.presetId,
      workspaceId: request.workspaceId,
      acpCatalogId: request.acpCatalogId,
    });
    const now = new Date().toISOString();
    return this.execute({
      automationRunId: request.taskId,
      onSubmitted: request.onSubmitted,
      executionContext: request.executionContext,
      definition: {
        id: `team-${request.teamId}-${request.memberId}`,
        version: 1,
        name: request.name,
        enabled: false,
        schedule: { kind: "interval", everyMinutes: 1 },
        presetId: request.presetId,
        engine: request.engine,
        acpCatalogId: request.acpCatalogId,
        workspaceId: request.workspaceId,
        input: request.input,
        notificationPolicy: "none",
        messageNotificationEnabled: false,
        messageNotificationTargetId: null,
        executionMode: "existing",
        conversationId: request.sessionId,
        nextRunAt: null,
        lastRunAt: null,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  async executeInbox(
    request: InboxExecution,
  ): Promise<{ sessionId: string; replyText?: string }> {
    if (this.#draining) throw new Error("runtime_draining");
    const messageId = `message-${request.receiptId}`;
    if (
      this.#messages
        .list(request.sessionId)
        .some((message) => message.id === messageId)
    ) {
      return { sessionId: request.sessionId };
    }
    const now = new Date().toISOString();
    const workspaceId = "default";
    const definition: AutomationExecution["definition"] = {
      id: `inbox-${request.sessionId}`,
      version: 1,
      name: request.title,
      enabled: false,
      schedule: { kind: "interval", everyMinutes: 1 },
      presetId: "builtin-general",
      engine: "harness",
      workspaceId,
      input: request.input,
      notificationPolicy: "none",
      messageNotificationEnabled: false,
      messageNotificationTargetId: null,
      executionMode: "existing",
      conversationId: request.sessionId,
      nextRunAt: null,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const record = await this.#startAutomationSession(request.sessionId, {
      automationRunId: request.receiptId,
      definition,
    });
    if (record.handle === undefined && record.native?.connected !== true)
      await this.#activate(request.sessionId, record);
    const attachmentPaths: string[] = [];
    for (const attachment of request.attachments) {
      if (attachment.contentBase64 === undefined) continue;
      const content = Buffer.from(attachment.contentBase64, "base64");
      if (
        content.length !== attachment.size ||
        content.toString("base64") !== attachment.contentBase64
      )
        throw new Error("invalid_inbox_attachment");
      try {
        const asset = this.#workspaces.addAttachment(
          workspaceId,
          request.sessionId,
          attachment.name,
          attachment.contentType,
          content,
        );
        attachmentPaths.push(asset.path);
      } finally {
        content.fill(0);
      }
    }
    const runtimeInput =
      attachmentPaths.length === 0
        ? request.input
        : `${request.input}\n\nWorkspace attachment paths:\n${attachmentPaths.map((path) => `- ${path}`).join("\n")}`;
    const terminal = this.#waitForTerminal(request.sessionId);
    try {
      await this.#deliverInput(
        request.sessionId,
        record,
        { messageId, content: runtimeInput },
        false,
      );
    } catch (error) {
      this.#publish(record, {
        sessionId: request.sessionId,
        type: "turn.failed",
        turnId: request.receiptId,
        eventId: `inbox-${request.receiptId}-failed`,
        occurredAt: new Date().toISOString(),
        message:
          error instanceof Error
            ? quotaMessage(error.message)
            : "engine_turn_rejected",
      });
      await terminal.catch(() => undefined);
      throw error;
    }
    const completed = await terminal;
    return completed.result === undefined
      ? { sessionId: request.sessionId }
      : { sessionId: request.sessionId, replyText: completed.result };
  }

  cancelTeamTask(taskId: string): Promise<void> {
    return this.cancel(taskId);
  }

  async cancel(automationRunId: string): Promise<void> {
    const admittedSession = [...this.#backgroundAdmissions].find(
      ([, executionId]) => executionId === automationRunId,
    )?.[0];
    if (admittedSession || this.#automationTargets.has(automationRunId))
      this.#cancelledBackground.add(automationRunId);
    const sessionId =
      this.#automationTargets.get(automationRunId) ??
      admittedSession ??
      `session-${automationRunId}`;
    const record = this.#sessions.get(sessionId);
    if (record === undefined) return;
    await this.#activate(sessionId, record);
    if (record.handle !== undefined) {
      record.handle.agent.cancel({ kind: "user" });
      return;
    }
    await record.native!.cancel();
  }

  setActivityProvider(
    provider: () => { active: boolean; nextWakeAt: string | null },
  ) {
    this.#activityExtra = provider;
  }

  activitySnapshot() {
    const extra = this.#activityExtra();
    const notifications = this.#completionNotifications.snapshot();
    const records = [...this.#sessions.values()];
    return {
      known: true,
      active:
        extra.active ||
        notifications.channelActive ||
        notifications.deliveries.some(
          (row) => row.status === "pending" || row.status === "sending",
        ) ||
        this.#automationExecutions.size > 0 ||
        this.#sharedTurnExecutions.size > 0 ||
        this.#sessionDeletions.size > 0 ||
        records.some(
          (record) =>
            record.inputPending ||
            record.activating ||
            record.queue?.length ||
            (record.activity && record.activity.state !== "idle"),
        ),
      nextWakeAt: extra.nextWakeAt,
      lastActiveAt:
        records
          .map((record) => record.updatedAt)
          .sort()
          .at(-1) ?? null,
      channelActive: notifications.channelActive,
      draining: this.#draining,
    };
  }

  mount(): void {
    this.#ctx.effect(
      () =>
        this.#ctx.webServer.register({
          kind: "exact",
          path: "/v1/activity",
          handler: async (request, response) => {
            if (!authorized(request, this.#token))
              return writeJson(response, 401, {
                error: "authentication_required",
              });
            if (request.method === "POST") {
              try {
                const input = await readJson(request);
                if (typeof input.draining !== "boolean")
                  return writeJson(response, 400, { error: "invalid_request" });
                if (input.draining && this.activitySnapshot().active)
                  return writeJson(response, 409, { error: "runtime_busy" });
                this.#drainUntil = input.draining ? Date.now() + 120_000 : 0;
              } catch {
                return writeJson(response, 400, { error: "invalid_request" });
              }
            } else if (request.method !== "GET")
              return writeJson(response, 405, { error: "method_not_allowed" });
            writeJson(response, 200, this.activitySnapshot());
          },
        }),
      "workagent: runtime idle admission",
    );
    this.#ctx.effect(
      () =>
        this.#ctx.webServer.register({
          kind: "exact",
          path: "/v1/model-options",
          handler: async (request, response) => {
            if (!authorized(request, this.#token))
              return writeJson(response, 401, {
                error: "authentication_required",
              });
            if (request.method !== "GET") {
              response.writeHead(405, { allow: "GET" });
              response.end();
              return;
            }
            writeJson(response, 200, [
              ...(await discoverModels(this.#ctx, this.#bridges)),
              ...(await this.#acpModels()),
            ]);
          },
        }),
      "workagent-runtime-api: live model discovery",
    );
    this.#ctx.effect(
      () => () =>
        Promise.all(
          [...this.#bridges.values()]
            .map((bridge) => bridge.close())
            .concat(this.#acp.close()),
        ),
      "workagent-runtime-api: native engine shutdown",
    );
    this.#ctx.effect(
      () =>
        this.#ctx.webServer.register({
          kind: "exact",
          path: "/v1/engines",
          handler: (request, response) => this.#engines(request, response),
        }),
      "workagent-runtime-api: engine registry route",
    );
    this.#ctx.effect(
      () =>
        this.#ctx.webServer.register({
          kind: "exact",
          path: "/v1/messages/search",
          handler: (request, response) => this.#handle(request, response),
        }),
      "workagent-runtime-api: persisted message search route",
    );
    this.#ctx.effect(
      () =>
        this.#ctx.webServer.register({
          kind: "exact",
          path: "/v1/market-capabilities/change",
          handler: (request, response) => this.#handle(request, response),
        }),
      "workagent-runtime-api: market capability changes",
    );
    this.#ctx.effect(
      () =>
        this.#ctx.webServer.register({
          kind: "prefix",
          path: "/v1/sessions",
          handler: (request, response) => this.#handle(request, response),
        }),
      "workagent-runtime-api: session routes",
    );
    this.#ctx.effect(
      () =>
        this.#ctx.webServer.register({
          kind: "prefix",
          path: "/v1/session-operations",
          handler: (request, response) =>
            this.#sessionOperation(request, response),
        }),
      "workagent-runtime-api: durable session operations",
    );
    this.#ctx.effect(
      () =>
        this.#ctx.on("session/event", (session, event) => {
          // Native logs are already produced by #publish; never feed them back
          // into the native execution path or duplicate quota/notification work.
          if (this.#nativeLog?.get(String(session.id)) === session) return;
          const normalized = normalizeEvent(session, event);
          if (normalized === undefined) return;
          const record = this.#sessions.get(String(session.id));
          if (record !== undefined) this.#publish(record, normalized);
        }),
      "workagent-runtime-api: normalized session events",
    );
    // Harness file-tool observations feed the shared-folder own-write table.
    // The dsh-fs event vocabulary is augmented onto Context by the tool stack,
    // which this bundle does not depend on; register with a structural type.
    (
      this.#ctx as {
        on(
          event: string,
          listener: (
            target: { displayPath: string },
            observation: { kind: "present" | "absent" },
            actor: unknown,
          ) => void,
        ): unknown;
      }
    ).on("fs/observed", (target, observation, actor) =>
      this.#observeSharedFile(target, observation, actor),
    );
  }

  async #acpModels() {
    const entries = await this.#acp.list().catch(() => []);
    return Promise.all(
      entries
        .filter((entry) => entry.enabled)
        .map(async (entry) => {
          const base = {
            engine: "acp",
            acpCatalogId: entry.id,
            label: entry.label,
            permissionModes: entry.permissionModes ?? {},
            fetchedAt: new Date().toISOString(),
          };
          try {
            const bridge = await this.#acp.bridge(entry);
            const models = await bridge.listModels();
            return {
              ...base,
              state: models.length ? "ready" : "empty",
              models,
            };
          } catch {
            return { ...base, state: "unavailable", models: [] };
          }
        }),
    );
  }

  async #engines(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!authorized(request, this.#token)) {
      writeJson(response, 401, { error: "authentication_required" });
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return;
    }
    const unavailable = (label: string) => ({
      available: false,
      authenticated: null,
      state: "unavailable" as const,
      detail: `${label} status timed out.`,
    });
    const status = async (id: "codex" | "kimi", label: string) => {
      const bridge = this.#bridges.get(id);
      if (bridge === undefined) return unavailable(label);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          bridge.status(),
          new Promise<ReturnType<typeof unavailable>>((resolve) => {
            timer = setTimeout(() => resolve(unavailable(label)), 8_000);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };
    const [codex, kimi] = await Promise.all([
      status("codex", "Codex"),
      status("kimi", "Kimi"),
    ]);
    const approved = await this.#acp.list().catch(() => []);
    const acpStatuses = await Promise.all(
      approved.map(async (entry) => {
        const base = {
          id: "acp",
          acpCatalogId: entry.id,
          label: entry.label,
          available: false,
          authenticated: null,
          state: "unavailable",
          capabilities: {
            approval: true,
            resume: false,
            steer: false,
            toolEvents: true,
            usage: false,
          },
        };
        if (!entry.enabled) return { ...base, detail: "管理员已停用" };
        try {
          const bridge = await this.#acp.bridge(entry);
          const state = await bridge.status();
          return { ...base, ...state, capabilities: bridge.capabilities() };
        } catch {
          return { ...base, detail: "请检查自己的引擎连接信息" };
        }
      }),
    );
    writeJson(response, 200, [
      {
        id: "harness",
        label: "Harness",
        available: true,
        authenticated: null,
        state: "unknown",
        detail: "Harness is ready; model access is verified on the first turn.",
        capabilities: ENGINE_CAPABILITIES.harness,
      },
      {
        id: "codex",
        label: "Codex",
        ...codex,
        capabilities: ENGINE_CAPABILITIES.codex,
      },
      {
        id: "kimi",
        label: "Kimi",
        ...kimi,
        capabilities: ENGINE_CAPABILITIES.kimi,
      },
      ...acpStatuses,
    ]);
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!authorized(request, this.#token)) {
      writeJson(response, 401, { error: "authentication_required" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://runtime");
    const path = url.pathname;
    if (
      path === "/v1/market-capabilities/change" &&
      request.method === "POST"
    ) {
      try {
        await this.#applyMarketChange(
          marketChangeSchema.parse(await readJson(request)),
        );
        writeJson(response, 200, { applied: true });
      } catch (error) {
        writeJson(response, 409, {
          error:
            error instanceof Error ? error.message : "market_update_failed",
        });
      }
      return;
    }
    if (path === "/v1/messages/search" && request.method === "GET") {
      const keyword = (url.searchParams.get("keyword") ?? "").trim();
      const page = Number(url.searchParams.get("page") ?? "0");
      const pageSize = Number(url.searchParams.get("page_size") ?? "20");
      const sessionId = url.searchParams.get("session_id")?.trim() || undefined;
      if (
        keyword === "" ||
        keyword.length > 200 ||
        !Number.isInteger(page) ||
        page < 0 ||
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100
      ) {
        writeJson(response, 400, { error: "invalid_message_search" });
        return;
      }
      const items = [...this.#sessions.entries()]
        .filter(([, record]) => record.internal !== true)
        .flatMap(([sessionId, record]) =>
          this.#messages.list(sessionId).map((message) => ({
            session: {
              id: sessionId,
              engine: record.engine,
              title: record.title,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              workspaceId: record.workspaceId,
              preset: record.preset,
              ...branchMetadata(record),
            },
            message,
          })),
        );
      writeJson(
        response,
        200,
        searchRuntimeMessages(items, keyword, page, pageSize, sessionId),
      );
      return;
    }
    if (path === "/v1/sessions" && request.method === "GET") {
      writeJson(
        response,
        200,
        [...this.#sessions.entries()]
          .filter(([, value]) => value.internal !== true)
          .map(([id, value]) => ({
            id,
            engine: value.engine,
            title: value.title,
            createdAt: value.createdAt,
            updatedAt: value.updatedAt,
            activity: value.activity ?? { state: "idle" },
            lastTurn: value.lastTurn,
            workspaceId: value.workspaceId,
            ...(value.modelId === undefined ? {} : { modelId: value.modelId }),
            ...(value.thinkingEffort === undefined
              ? {}
              : { thinkingEffort: value.thinkingEffort }),
            ...(value.permissionMode === undefined
              ? {}
              : { permissionMode: value.permissionMode }),
            preset: value.preset,
            ...branchMetadata(value),
          })),
      );
      return;
    }
    if (path === "/v1/sessions" && request.method === "POST") {
      await this.#create(request, response);
      return;
    }
    const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(path);
    if (sessionMatch !== null) {
      const id = decodeURIComponent(sessionMatch[1] ?? "");
      const record = this.#sessions.get(id);
      if (record === undefined || record.internal === true) {
        writeJson(response, 404, { error: "session_not_found" });
        return;
      }
      if (request.method === "PATCH") {
        const input = await readJson(request);
        if (
          typeof input.title !== "string" ||
          input.title.trim() === "" ||
          input.title.length > 200
        ) {
          writeJson(response, 400, { error: "invalid_title" });
          return;
        }
        record.title = input.title.trim();
        record.updatedAt = new Date().toISOString();
        this.#persist(id, record);
        writeJson(response, 200, {
          id,
          engine: record.engine,
          title: record.title,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          workspaceId: record.workspaceId,
          ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
          ...(record.thinkingEffort === undefined
            ? {}
            : { thinkingEffort: record.thinkingEffort }),
          ...(record.permissionMode === undefined
            ? {}
            : { permissionMode: record.permissionMode }),
          preset: record.preset,
          ...branchMetadata(record),
        });
        return;
      }
      if (request.method === "GET") {
        writeJson(response, 200, {
          id,
          activity: record.activity ?? { state: "idle" },
          lastTurn: record.lastTurn,
          ...(record.queue === undefined ? {} : { queue: record.queue }),
          engine: record.engine,
          title: record.title,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          workspaceId: record.workspaceId,
          ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
          ...(record.thinkingEffort === undefined
            ? {}
            : { thinkingEffort: record.thinkingEffort }),
          ...(record.permissionMode === undefined
            ? {}
            : { permissionMode: record.permissionMode }),
          preset: record.preset,
          ...branchMetadata(record),
        });
        return;
      }
      if (request.method === "DELETE") {
        try {
          await this.#deleteSession(id, record);
        } catch (error) {
          console.error("workagent-runtime-api: session close failed", error);
          writeJson(response, 503, { error: "session_close_failed" });
          return;
        }
        response.writeHead(204);
        response.end();
        return;
      }
      writeJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    const match =
      /^\/v1\/sessions\/([^/]+)\/(turns|steer|queue|cancel|events|resume|messages|question-reply|fork|side-chat|configuration|commands|capabilities\/reload)$/.exec(
        path,
      );
    if (match === null) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    const id = decodeURIComponent(match[1] ?? "");
    const record = this.#sessions.get(id);
    if (record === undefined || record.internal === true) {
      writeJson(response, 404, { error: "session_not_found" });
      return;
    }
    if (match[2] === "commands" && request.method === "GET") {
      try {
        await this.#activate(id, record);
        writeJson(
          response,
          200,
          record.native?.commands?.() ?? {
            supported: false,
            revision: 0,
            items: [],
          },
        );
      } catch (error) {
        writeJson(response, 409, {
          error:
            error instanceof Error
              ? error.message
              : "engine_commands_unavailable",
        });
      }
      return;
    }
    if (match[2] === "question-reply" && request.method === "POST") {
      const input = await readJson(request);
      if (
        typeof input.questionId !== "string" ||
        typeof input.content !== "string" ||
        !input.content.trim()
      )
        return writeJson(response, 400, { error: "invalid_question_reply" });
      const messages = this.#messages.list(id);
      const question = messages.find(
        (row) =>
          row.id === input.questionId &&
          row.role === "assistant" &&
          row.kind === "question",
      );
      if (!question)
        return writeJson(response, 404, { error: "question_not_found" });
      const answer = input.content.trim();
      const existing = messages.find(
        (row) => row.role === "user" && row.replyTo?.id === question.id,
      );
      if (existing)
        return existing.text === answer
          ? writeJson(response, 200, { message: existing })
          : writeJson(response, 409, { error: "question_already_answered" });
      const messageId = `message-question-${question.id}`;
      try {
        await this.#deliverInput(
          id,
          record,
          {
            messageId,
            content: `以下是用户对当前任务中补充问题的回答，请结合这些信息继续当前任务。\n\n原问题：\n${question.text}\n\n用户回答：\n${answer}`,
            displayContent: answer,
            replyTo: { id: question.id, text: question.text },
          },
          !!record.activity && record.activity.state !== "idle",
        );
        writeJson(response, 200, {
          message: this.#messages.list(id).find((row) => row.id === messageId),
        });
      } catch (error) {
        writeJson(response, 409, {
          error:
            error instanceof Error ? error.message : "question_reply_failed",
        });
      }
      return;
    }
    if (match[2] === "capabilities/reload" && request.method === "POST") {
      if (
        record.inputPending ||
        record.activating ||
        (record.activity && record.activity.state !== "idle")
      )
        return writeJson(response, 409, { error: "session_input_pending" });
      record.inputPending = true;
      const previous = record.preset;
      try {
        const fresh = this.#presets.resolve(previous.presetId).resolvedSnapshot;
        const preset = {
          ...previous,
          resolvedSnapshot: {
            ...previous.resolvedSnapshot,
            skillIds: fresh.skillIds,
            mcpServerIds: fresh.mcpServerIds,
            resolvedSkills: fresh.resolvedSkills,
            resolvedMcpServers: fresh.resolvedMcpServers,
            resolvedAt: fresh.resolvedAt,
          },
        };
        this.#validateMcpCompatibility(
          record.engine,
          this.#resolvedMcpServers(preset),
        );
        this.#validateSkillCompatibility(
          record.engine,
          this.#resolvedSkills(preset),
        );
        await record.native?.close();
        await record.handle?.dispose();
        record.native = undefined;
        record.handle = undefined;
        record.preset = preset;
        await this.#activate(id, record);
        this.#persist(id, record);
        writeJson(response, 200, { id, preset });
      } catch (error) {
        record.preset = previous;
        writeJson(response, 409, {
          error:
            error instanceof Error ? error.message : "capability_reload_failed",
        });
      } finally {
        record.inputPending = false;
      }
      return;
    }
    if (match[2] === "configuration" && request.method === "PATCH") {
      const input = await readJson(request);
      if (
        !["read_only", "workspace_write", "full_access"].includes(
          String(input.permissionMode),
        )
      )
        return writeJson(response, 400, { error: "invalid_permission_mode" });
      if (record.engine === "harness")
        return writeJson(response, 400, { error: "native_session_required" });
      if (
        record.inputPending ||
        record.activating ||
        (record.activity && record.activity.state !== "idle")
      )
        return writeJson(response, 409, { error: "session_input_pending" });
      record.inputPending = true;
      const previous = record.permissionMode;
      try {
        await record.native?.close();
        record.native = undefined;
        if (this.#sessions.get(id) !== record)
          throw new Error("session_not_found");
        record.permissionMode = input.permissionMode as NonNullable<
          SessionRecord["permissionMode"]
        >;
        record.requirePermission = true;
        await this.#activate(id, record);
        if (this.#sessions.get(id) !== record)
          throw new Error("session_not_found");
        this.#persist(id, record);
        writeJson(response, 200, { permissionMode: record.permissionMode });
      } catch (error) {
        await record.native?.close().catch(() => undefined);
        record.native = undefined;
        if (previous === undefined) delete record.permissionMode;
        else record.permissionMode = previous;
        writeJson(response, 409, {
          error:
            error instanceof Error ? error.message : "permission_update_failed",
        });
      } finally {
        delete record.requirePermission;
        record.inputPending = false;
      }
      return;
    }
    if (
      (match[2] === "fork" || match[2] === "side-chat") &&
      request.method === "POST"
    ) {
      const input = await readJson(request);
      if (
        (input.messageId !== undefined &&
          (typeof input.messageId !== "string" ||
            input.messageId.length === 0 ||
            input.messageId.length > 200)) ||
        (input.replacementContent !== undefined &&
          typeof input.messageId !== "string") ||
        (input.replacementContent !== undefined &&
          (typeof input.replacementContent !== "string" ||
            input.replacementContent.trim() === ""))
      ) {
        writeJson(response, 400, { error: "invalid_fork_request" });
        return;
      }
      if (record.inputPending) {
        writeJson(response, 409, { error: "session_input_pending" });
        return;
      }
      const editing = input.replacementContent !== undefined;
      if (editing) record.inputPending = true;
      try {
        const forked = await this.#forkSession(
          id,
          record,
          typeof input.messageId === "string" ? input.messageId : undefined,
          typeof input.replacementContent === "string"
            ? input.replacementContent
            : undefined,
          match[2] === "side-chat"
            ? "side_chat"
            : input.replacementContent === undefined
              ? "fork"
              : "edit",
        );
        writeJson(response, 201, forked);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "session_fork_failed";
        writeJson(
          response,
          message.startsWith("engine_capability_unsupported:") ||
            message === "message_turn_unavailable" ||
            message === "fork_message_not_found"
            ? 409
            : 503,
          { error: message },
        );
      } finally {
        if (editing) record.inputPending = false;
      }
      return;
    }
    if (match[2] === "queue" && request.method === "GET") {
      writeJson(response, 200, record.queue ?? []);
      return;
    }
    if (match[2] === "queue" && request.method === "POST") {
      const input = await readJson(request);
      if (input.action !== undefined) {
        const item = record.queue?.find(
          (row) => row.messageId === input.messageId,
        );
        if (!item) {
          writeJson(response, 404, { error: "queued_message_not_found" });
          return;
        }
        if (!["steer", "send", "remove"].includes(String(input.action))) {
          writeJson(response, 400, { error: "invalid_queue_action" });
          return;
        }
        if (record.inputPending) {
          writeJson(response, 409, { error: "session_input_pending" });
          return;
        }
        if (input.action === "remove") {
          record.queue = record.queue!.filter((row) => row !== item);
          this.#queueChanged(id, record);
        } else {
          try {
            await this.#deliverInput(
              id,
              record,
              item,
              input.action === "steer",
            );
          } catch (error) {
            item.error =
              error instanceof Error
                ? quotaMessage(error.message)
                : "engine_turn_rejected";
            this.#queueChanged(id, record);
            writeJson(response, 409, { error: item.error });
            return;
          }
        }
        writeJson(response, 200, record.queue ?? []);
        return;
      }
      if (
        typeof input.content !== "string" ||
        !input.content.trim() ||
        (input.messageId !== undefined &&
          (typeof input.messageId !== "string" ||
            !input.messageId ||
            input.messageId.length > 200))
      ) {
        writeJson(response, 400, { error: "content_required" });
        return;
      }
      const item: QueuedInput = {
        messageId:
          typeof input.messageId === "string"
            ? input.messageId
            : `message-${randomUUID()}`,
        content: input.content,
      };
      record.queue ??= [];
      if (!record.queue.some((row) => row.messageId === item.messageId))
        record.queue.push(item);
      this.#queueChanged(id, record);
      void this.#drainQueue(id, record);
      writeJson(response, 202, { accepted: true });
      return;
    }
    if (
      match[2] !== "events" &&
      match[2] !== "messages" &&
      match[2] !== "cancel"
    ) {
      try {
        await this.#activate(id, record);
      } catch (error) {
        console.error("workagent-runtime-api: session resume failed", error);
        if (error instanceof ExecutionConfigurationError) {
          writeJson(response, 400, { error: error.message });
          return;
        }
        writeJson(response, 503, { error: "session_resume_failed" });
        return;
      }
    }
    if (match[2] === "configuration" && request.method === "GET") {
      writeJson(response, 200, {
        permissionMode:
          record.permissionMode ??
          record.native?.permissionMode ??
          (record.engine === "harness" ? "workspace_write" : undefined),
      });
      return;
    }
    if (match[2] === "messages" && request.method === "GET") {
      writeJson(response, 200, this.#messages.list(id));
      return;
    }
    if (
      (match[2] === "turns" || match[2] === "steer") &&
      request.method === "POST"
    ) {
      const input = await readJson(request);
      if (
        typeof input.content !== "string" ||
        input.content.trim() === "" ||
        (input.displayContent !== undefined &&
          (typeof input.displayContent !== "string" ||
            input.displayContent.trim() === "")) ||
        (input.messageId !== undefined &&
          (typeof input.messageId !== "string" ||
            input.messageId.length === 0 ||
            input.messageId.length > 200))
      ) {
        writeJson(response, 400, { error: "content_required" });
        return;
      }
      try {
        await this.#deliverInput(
          id,
          record,
          {
            messageId:
              typeof input.messageId === "string"
                ? input.messageId
                : `message-${randomUUID()}`,
            content: input.content,
            ...(typeof input.displayContent === "string"
              ? { displayContent: input.displayContent }
              : {}),
          },
          match[2] === "steer",
        );
      } catch (error) {
        writeJson(response, 409, {
          error:
            error instanceof Error ? error.message : "engine_turn_rejected",
        });
        return;
      }
      writeJson(response, 202, { accepted: true });
      return;
    }
    if (match[2] === "resume" && request.method === "POST") {
      writeJson(response, 200, {
        id,
        engine: record.engine,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        workspaceId: record.workspaceId,
        ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
        ...(record.thinkingEffort === undefined
          ? {}
          : { thinkingEffort: record.thinkingEffort }),
        ...(record.permissionMode === undefined
          ? {}
          : { permissionMode: record.permissionMode }),
        preset: record.preset,
        ...branchMetadata(record),
      });
      return;
    }
    if (match[2] === "cancel" && request.method === "POST") {
      if (record.handle !== undefined)
        record.handle.agent.cancel({ kind: "user" });
      else {
        try {
          if (record.activating) await record.activating;
          await record.native?.cancel();
        } catch {
          writeJson(response, 503, { error: "engine_cancel_failed" });
          return;
        }
      }
      response.writeHead(204);
      response.end();
      return;
    }
    if (match[2] === "events" && request.method === "GET") {
      this.#connectEvents(id, record, request, response);
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed" });
  }

  async #deleteSession(id: string, record: SessionRecord): Promise<void> {
    const pending = this.#sessionDeletions.get(id);
    if (pending) return pending;
    const removal = (async () => {
      if (record.creation)
        this.#index.cancelOperation(record.creation.operationId);
      // Removing live admission first prevents a queued/resuming request from
      // starting a turn while the engine is being closed.
      this.#sessions.delete(id);
      this.#toolScopes.delete(id);
      try {
        await record.activating?.catch(() => undefined);
        if (record.handle) await record.handle.dispose();
        if (record.native) await record.native.close();
        // Cancelled sessions are intentionally not reopened at startup. Delete
        // their canonical stream by ID even when no message projection exists.
        if (record.engine !== "harness" && !record.internal)
          this.#nativeLog?.delete(id);
        this.#messages.delete(id);
        // Keep the identity until every message owner has finished cleanup so
        // a disk failure can resume through the persisted delete operation.
        this.#index.delete(id);
      } catch (error) {
        this.#sessions.set(id, record);
        throw error;
      }
      this.#awareness.release(id);
      void this.#conversationQuota
        .releaseSession(id)
        .catch((error) =>
          console.error("conversation quota settlement failed", error),
        );
      for (const subscriber of this.#subscribers.get(id) ?? [])
        subscriber.end();
      this.#subscribers.delete(id);
    })().finally(() => this.#sessionDeletions.delete(id));
    this.#sessionDeletions.set(id, removal);
    return removal;
  }

  async #sessionOperation(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!authorized(request, this.#token))
      return writeJson(response, 401, { error: "authentication_required" });
    const path = new URL(request.url ?? "/", "http://runtime.local").pathname;
    const match = /^\/v1\/session-operations\/([A-Za-z0-9_-]{1,160})$/.exec(
      path,
    );
    if (!match)
      return writeJson(response, 400, { error: "invalid_operation_id" });
    const operationId = match[1]!;
    if (request.method === "DELETE") {
      try {
        this.#index.cancelOperation(operationId);
        const operation = this.#index.lookupOperation(operationId)!;
        const stored = operation.session;
        if (stored) {
          const record =
            this.#sessions.get(stored.id) ?? this.#record(stored, "default");
          await this.#deleteSession(stored.id, record);
        }
        response.writeHead(204);
        response.end();
      } catch {
        writeJson(response, 503, { error: "session_close_failed" });
      }
      return;
    }
    if (request.method !== "GET")
      return writeJson(response, 405, { error: "method_not_allowed" });
    const operation = this.#index.lookupOperation(operationId);
    if (!operation)
      return writeJson(response, 404, { error: "operation_not_found" });
    const stored = operation.session;
    writeJson(response, 200, {
      operation: { id: operationId, state: operation.state },
      ...(operation.state === "ready" && stored
        ? {
            session: this.#createdSession(
              stored.id,
              this.#sessions.get(stored.id) ?? this.#record(stored, "default"),
            ),
          }
        : {}),
    });
  }

  async #create(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (this.#draining)
      return writeJson(response, 503, { error: "runtime_draining" });
    const input = await readJson(request);
    // The gateway injects workspace=<shared:projectId> plus the resolved
    // absolute workspacePath for collaboration sessions; clients never send
    // either directly. workspacePath is meaningless without a shared workspace.
    const sharedProjectId =
      typeof input.workspace === "string" &&
      input.workspace.startsWith("shared:")
        ? input.workspace.slice("shared:".length)
        : undefined;
    if (
      (input.engine !== "harness" &&
        input.engine !== "codex" &&
        input.engine !== "kimi" &&
        input.engine !== "acp") ||
      (input.engine === "acp"
        ? typeof input.acpCatalogId !== "string" ||
          !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.acpCatalogId)
        : input.acpCatalogId !== undefined) ||
      typeof input.title !== "string" ||
      input.title.trim() === "" ||
      input.title.length > 200 ||
      typeof input.workspace !== "string" ||
      (input.operationId !== undefined &&
        (typeof input.operationId !== "string" ||
          !/^[A-Za-z0-9_-]{1,160}$/.test(input.operationId))) ||
      (input.workspacePath !== undefined &&
        (typeof input.workspacePath !== "string" ||
          sharedProjectId === undefined ||
          !isAbsoluteWorkspacePath(input.workspacePath))) ||
      (sharedProjectId !== undefined &&
        (sharedProjectId === "" || input.workspacePath === undefined)) ||
      (input.modelId !== undefined &&
        (typeof input.modelId !== "string" ||
          input.modelId.trim() === "" ||
          input.modelId.length > 200)) ||
      (input.thinkingEffort !== undefined &&
        (typeof input.thinkingEffort !== "string" ||
          !input.thinkingEffort.trim() ||
          input.thinkingEffort.length > 80)) ||
      (input.permissionMode !== undefined &&
        input.permissionMode !== "read_only" &&
        input.permissionMode !== "workspace_write" &&
        input.permissionMode !== "full_access")
    ) {
      writeJson(response, 400, { error: "invalid_session" });
      return;
    }
    const workspaceId =
      sharedProjectId !== undefined
        ? input.workspace
        : input.workspace === "default"
          ? "default"
          : this.#workspaces.get(input.workspace)?.id;
    if (workspaceId === undefined) {
      writeJson(response, 400, { error: "workspace_not_found" });
      return;
    }
    const creation: SessionCreation | undefined =
      typeof input.operationId === "string"
        ? {
            operationId: input.operationId,
            input: {
              engine: input.engine,
              ...(typeof input.acpCatalogId === "string"
                ? { acpCatalogId: input.acpCatalogId }
                : {}),
              title: input.title.trim(),
              workspace: workspaceId,
              presetId:
                typeof input.presetId === "string"
                  ? input.presetId
                  : input.engine === "harness"
                    ? "builtin-general"
                    : `builtin-${input.engine}`,
              ...(typeof input.modelId === "string"
                ? { modelId: input.modelId.trim() }
                : {}),
              ...(typeof input.thinkingEffort === "string"
                ? { thinkingEffort: input.thinkingEffort }
                : {}),
              ...(input.permissionMode === undefined
                ? {}
                : { permissionMode: input.permissionMode }),
            },
          }
        : undefined;
    if (creation) {
      try {
        const existing = this.#index.operation(creation);
        if (existing) {
          this.#writeCreatedSession(
            response,
            existing.id,
            this.#sessions.get(existing.id) ??
              this.#record(existing, workspaceId),
          );
          return;
        }
      } catch (error) {
        writeJson(response, 409, { error: (error as Error).message });
        return;
      }
    }
    const publicId = creation
      ? `session-op-${creation.operationId}`
      : `session-${randomUUID()}`;
    const now = new Date().toISOString();
    let preset: PresetBinding;
    try {
      preset = this.#presets.resolve(
        typeof input.presetId === "string"
          ? input.presetId
          : input.engine === "harness"
            ? "builtin-general"
            : `builtin-${input.engine}`,
      );
    } catch (error) {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : "invalid_preset",
      });
      return;
    }
    preset = projectCapabilityBinding(
      preset,
      await runtimeMarketCapabilities(workspaceId),
    );
    if (preset.resolvedSnapshot.engine !== input.engine) {
      writeJson(response, 400, { error: "preset_engine_mismatch" });
      return;
    }
    let resolvedSkills: readonly ResolvedSkill[];
    try {
      resolvedSkills = this.#resolvedSkills(preset);
      this.#validateSkillCompatibility(input.engine, resolvedSkills);
    } catch (error) {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : "invalid_skill_binding",
      });
      return;
    }
    let mcpServers: readonly ResolvedMcpServer[];
    try {
      mcpServers = this.#resolvedMcpServers(preset, workspaceId);
      this.#validateMcpCompatibility(input.engine, mcpServers);
    } catch (error) {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : "invalid_mcp_binding",
      });
      return;
    }
    const record: SessionRecord = {
      activating: undefined,
      engine: input.engine,
      ...(typeof input.acpCatalogId === "string"
        ? { acpCatalogId: input.acpCatalogId }
        : {}),
      events: [],
      handle: undefined,
      native: undefined,
      nativeId: publicId,
      nextEventSequence: 1,
      title: input.title.trim(),
      createdAt: now,
      updatedAt: now,
      workspaceId,
      ...(input.workspacePath === undefined
        ? {}
        : { workspacePath: input.workspacePath }),
      ...(typeof input.modelId !== "string"
        ? {}
        : { modelId: input.modelId.trim() }),
      ...(input.thinkingEffort === undefined
        ? {}
        : { thinkingEffort: input.thinkingEffort }),
      ...(input.permissionMode === undefined
        ? {}
        : { permissionMode: input.permissionMode }),
      preset,
      ...(creation ? { creation } : {}),
    };
    if (record.workspaceId.startsWith("shared:") && !record.internal) {
      record.pendingContext =
        (record.pendingContext ?? "") +
        "当前目录是协作项目的共享文件夹，你对文件的新增、修改和删除会立即对所有项目成员可见。修改文件前先读取其最新内容。\n\n";
    }
    // Persist the operation and frozen binding before invoking any engine.
    // The normal activation path materializes this empty session on first use.
    try {
      await this.#prepareAcp(record);
      this.#executionConfiguration(record);
    } catch (error) {
      if (record.engine === "acp" && error instanceof Error) {
        writeJson(response, 409, { error: error.message });
        return;
      }
      if (!(error instanceof ExecutionConfigurationError)) throw error;
      writeJson(response, 400, { error: error.message });
      return;
    }
    if (creation) {
      try {
        const stored = this.#index.createOnce({
          id: publicId,
          nativeId: publicId,
          engine: record.engine,
          ...branchMetadata(record),
          title: record.title,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          workspaceId,
          ...(record.workspacePath
            ? { workspacePath: record.workspacePath }
            : {}),
          ...(record.modelId ? { modelId: record.modelId } : {}),
          ...(record.thinkingEffort
            ? { thinkingEffort: record.thinkingEffort }
            : {}),
          ...(record.permissionMode
            ? { permissionMode: record.permissionMode }
            : {}),
          preset,
          creation,
          ...(record.pendingContext
            ? { pendingContext: record.pendingContext }
            : {}),
        });
        const frozen =
          this.#sessions.get(publicId) ?? this.#record(stored, workspaceId);
        this.#sessions.set(publicId, frozen);
        this.#persist(publicId, frozen);
        this.#writeCreatedSession(response, publicId, frozen);
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "session_persist_failed";
        writeJson(
          response,
          code === "operation_conflict" || code === "operation_deleted"
            ? 409
            : 503,
          { error: code },
        );
      }
      return;
    }
    try {
      if (input.engine === "harness") {
        record.handle = await this.#createHarness(
          publicId,
          this.#engineWorkspace(record),
          mcpServers,
          resolvedSkills,
          record,
        );
      } else {
        const credentialError = nativeCredentialError(
          input.engine,
          this.#credentials.statusFor(`${input.engine}-native`),
        );
        if (credentialError !== undefined) {
          writeJson(response, 409, { error: credentialError });
          return;
        }
        const bridge = await this.#bridge(record);
        if (bridge === undefined) {
          writeJson(response, 503, { error: "engine_unavailable" });
          return;
        }
        record.native = await bridge.create(
          this.#engineWorkspace(record),
          (event) => {
            this.#publish(record, this.#nativeEvent(publicId, record, event));
          },
          {
            mcpServers: this.#sessionMcpServers(publicId, mcpServers),
            ...this.#nativeSkillOptions(resolvedSkills, record),
            requestApproval: (approval) =>
              this.#approvals.requestNative(publicId, approval),
            ...(record.modelId === undefined
              ? {}
              : { modelId: record.modelId }),
            ...(record.thinkingEffort === undefined
              ? {}
              : { thinkingEffort: record.thinkingEffort }),
            ...(record.permissionMode === undefined
              ? {}
              : { permissionMode: record.permissionMode }),
          },
        );
        record.nativeId = record.native.nativeId;
      }
    } catch {
      writeJson(response, 503, { error: "engine_start_failed" });
      return;
    }
    this.#sessions.set(publicId, record);
    this.#persist(publicId, record);
    this.#writeCreatedSession(response, publicId, record);
  }

  #writeCreatedSession(
    response: ServerResponse,
    publicId: string,
    record: SessionRecord,
  ): void {
    writeJson(response, 201, this.#createdSession(publicId, record));
  }

  #createdSession(publicId: string, record: SessionRecord) {
    return {
      ...branchMetadata(record),
      id: publicId,
      engine: record.engine,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      workspaceId: record.workspaceId,
      ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
      ...(record.thinkingEffort === undefined
        ? {}
        : { thinkingEffort: record.thinkingEffort }),
      ...(record.permissionMode === undefined
        ? {}
        : { permissionMode: record.permissionMode }),
      preset: record.preset,
    };
  }

  async #executeAutomation(request: AutomationExecution): Promise<{
    sessionId: string;
    result?: string;
    skillSuggestionPath?: string;
  }> {
    if (this.#draining) throw new Error("runtime_draining");
    const definition = request.definition;
    const skillPrompt = automationSkillPrompt(
      definition,
      request.automationRunId,
      this.#skills,
    );
    const sessionId =
      this.#automationTargets.get(request.automationRunId) ??
      automationTargetSessionId(request.automationRunId, definition);
    if (definition.engine !== "harness") {
      const credentialError = nativeCredentialError(
        definition.engine,
        this.#credentials.statusFor(`${definition.engine}-native`),
      );
      if (credentialError !== undefined) throw new Error(credentialError);
    }
    const record =
      definition.executionMode === "existing"
        ? await this.#existingAutomationSession(sessionId, definition)
        : await this.#startAutomationSession(sessionId, request);
    request.onSessionStarted?.(sessionId);
    const admission = this.admit(request);
    const terminal = this.#submittedTurn(sessionId, request.onSubmitted);
    try {
      await this.#deliverInput(
        sessionId,
        record,
        {
          messageId: `message-${request.automationRunId}`,
          content: (request.executionContext ?? "") + skillPrompt.input,
          displayContent: definition.input,
        },
        false,
        { executionId: request.automationRunId },
      );
    } catch (error) {
      terminal.cancel();
      admission.release();
      throw error;
    }
    let result: { sessionId: string; result?: string };
    try {
      result = await terminal.promise;
    } finally {
      admission.release();
    }
    const skillSuggestionPath = await validatedSkillSuggestion(
      this.#workspaces,
      record.workspaceId,
      skillPrompt.path,
    );
    return {
      ...result,
      ...(skillSuggestionPath ? { skillSuggestionPath } : {}),
    };
  }

  async #executeSharedTurn(
    request: SharedTurnRuntimeRequest,
  ): Promise<SharedTurnResult> {
    if (this.#draining) throw new Error("runtime_draining");
    const sessionId =
      request.sessionKey ?? `session-shared-${request.conversationId}`;
    const assistantId =
      request.assistantId ||
      (request.engine === "harness"
        ? "builtin-general"
        : `builtin-${request.engine}`);
    this.#sharedTurnTargets.set(request.runId, sessionId);
    let record = this.#sessions.get(sessionId);
    if (
      record !== undefined &&
      (record.preset.presetId !== assistantId ||
        record.engine !== request.engine)
    )
      throw new Error("shared_turn_assistant_identity_mismatch");
    if (record !== undefined && request.capabilities) {
      const next = projectCapabilityBinding(
        this.#presets.resolve(assistantId),
        request.capabilities,
      );
      if (
        JSON.stringify(next.resolvedSnapshot.skillIds) !==
          JSON.stringify(record.preset.resolvedSnapshot.skillIds) ||
        JSON.stringify(next.resolvedSnapshot.mcpServerIds) !==
          JSON.stringify(record.preset.resolvedSnapshot.mcpServerIds)
      ) {
        if (record.activity && record.activity.state !== "idle")
          throw new Error("session_input_pending");
        this.#validateSkillCompatibility(
          record.engine,
          this.#resolvedSkills(next),
        );
        this.#validateMcpCompatibility(
          record.engine,
          this.#resolvedMcpServers(next),
        );
        await record.handle?.dispose();
        await record.native?.close();
        record.handle = undefined;
        record.native = undefined;
        record.preset = next;
        this.#persist(sessionId, record);
      }
    }
    if (
      record !== undefined &&
      (record.modelId !== request.modelId ||
        record.thinkingEffort !== request.thinkingEffort)
    ) {
      if (record.activity && record.activity.state !== "idle")
        throw new Error("session_input_pending");
      const previous = {
        modelId: record.modelId,
        thinkingEffort: record.thinkingEffort,
      };
      if (record.handle !== undefined) await record.handle.dispose();
      if (record.native !== undefined) await record.native.close();
      record.handle = undefined;
      record.native = undefined;
      record.modelId = request.modelId;
      record.thinkingEffort = request.thinkingEffort;
      try {
        // Resume the same native identity with new settings; keep its transcript.
        await this.#activate(sessionId, record);
        this.#persist(sessionId, record);
      } catch (error) {
        Object.assign(record, previous);
        throw error;
      }
    }
    const recovered =
      record === undefined && request.runtimeSessionId !== undefined;
    if (record === undefined) {
      const preset = projectCapabilityBinding(
        this.#presets.resolve(assistantId),
        request.capabilities,
      );
      if (preset.resolvedSnapshot.engine !== request.engine)
        throw new Error("shared_turn_preset_engine_mismatch");
      const resolvedSkills = this.#resolvedSkills(preset);
      this.#validateSkillCompatibility(request.engine, resolvedSkills);
      const mcpServers = this.#resolvedMcpServers(
        preset,
        `shared:${request.projectId}`,
      );
      this.#validateMcpCompatibility(request.engine, mcpServers);
      const now = new Date().toISOString();
      record = {
        activating: undefined,
        engine: request.engine,
        events: [],
        handle: undefined,
        native: undefined,
        nativeId: sessionId,
        nextEventSequence: 1,
        title: `Shared ${request.conversationId}`,
        createdAt: now,
        updatedAt: now,
        workspaceId: `shared:${request.projectId}`,
        workspacePath: request.workspacePath,
        internal: true,
        modelId: request.modelId,
        thinkingEffort: request.thinkingEffort,
        preset,
      };
      if (request.engine === "harness") {
        record.handle = await this.#createHarness(
          sessionId,
          request.workspacePath,
          mcpServers,
          resolvedSkills,
          record,
        );
      } else {
        const assistantContext = channelAssistantContext("", resolvedSkills);
        if (assistantContext) record.pendingContext = assistantContext + "\n\n";
        const credentialError = nativeCredentialError(
          request.engine,
          this.#credentials.statusFor(`${request.engine}-native`),
        );
        if (credentialError !== undefined) throw new Error(credentialError);
        const bridge = await this.#bridge(record);
        if (bridge === undefined) throw new Error("engine_unavailable");
        record.native = await bridge.create(
          request.workspacePath,
          (event) =>
            this.#publish(
              record!,
              this.#nativeEvent(sessionId, record!, event),
            ),
          {
            mcpServers,
            modelId: request.modelId,
            ...this.#nativeSkillOptions(resolvedSkills, record),
            requestApproval: (approval) =>
              record!.internal
                ? Promise.resolve("cancel")
                : this.#approvals.requestNative(sessionId, approval),
            thinkingEffort: request.thinkingEffort,
          },
        );
        record.nativeId = record.native.nativeId;
      }
      this.#sessions.set(sessionId, record);
      this.#persist(sessionId, record);
    } else {
      if (
        record.internal !== true ||
        record.engine !== request.engine ||
        record.workspacePath !== request.workspacePath
      )
        throw new Error("shared_turn_session_mismatch");
      if (record.handle === undefined && record.native?.connected !== true)
        await this.#activate(sessionId, record);
    }
    const terminal = this.#waitForTerminal(sessionId);
    this.#sharedFiles?.moves.drain(request.projectId);
    const sharedChanges = this.#sharedFiles?.moves.context(
      request.projectId,
      record.fileRevision,
    );
    const awareness = this.#sharedAwarenessContext(sessionId, record);
    record.activity = { state: "running" };
    const input =
      (record.pendingContext ?? "") +
      (awareness?.text ?? "") +
      (sharedChanges?.text ?? "") +
      (recovered ? request.recoveryContext : request.context);
    record.updatedAt = new Date().toISOString();
    try {
      if (record.handle !== undefined) {
        record.handle.agent.followup(
          createUserMessage({
            content: [{ type: "text", text: input }],
            source: { kind: "user" },
          }),
        );
      } else await record.native!.send(input);
      record.pendingContext = undefined;
      if (sharedChanges) record.fileRevision = sharedChanges.revision;
      if (awareness) record.sharedCursor = awareness.cursor;
      this.#persist(sessionId, record);
    } catch (error) {
      this.#publish(record, {
        eventId: `${sessionId}-${record.nextEventSequence++}`,
        occurredAt: new Date().toISOString(),
        sessionId,
        type: "turn.failed",
        turnId: request.runId,
        code: "engine_turn_rejected",
        message:
          error instanceof Error ? error.message : "engine_turn_rejected",
      });
    }
    const result = await terminal;
    return {
      runId: request.runId,
      runtimeSessionId: sessionId,
      assistantBody: result.result ?? "",
      recovered,
    };
  }

  async #existingAutomationSession(
    sessionId: string,
    definition: AutomationExecution["definition"],
  ): Promise<SessionRecord> {
    const record = this.#sessions.get(sessionId);
    if (record === undefined)
      throw new Error("automation_conversation_not_found");
    if (record.engine !== definition.engine)
      throw new Error("automation_conversation_engine_mismatch");
    if (record.workspaceId !== definition.workspaceId)
      throw new Error("automation_conversation_workspace_mismatch");
    if (record.preset.presetId !== definition.presetId)
      throw new Error("automation_conversation_preset_mismatch");
    if (record.handle === undefined && record.native?.connected !== true)
      await this.#activate(sessionId, record);
    return record;
  }

  async #startAutomationSession(
    publicId: string,
    request: AutomationExecution,
  ): Promise<SessionRecord> {
    const existing = this.#sessions.get(publicId);
    if (existing !== undefined) return existing;
    const definition = request.definition;
    const workspace = this.#workspaces.get(definition.workspaceId);
    if (workspace === undefined) throw new Error("workspace_not_found");
    const preset = this.#presets.resolve(definition.presetId);
    if (preset.resolvedSnapshot.engine !== definition.engine)
      throw new Error("preset_engine_mismatch");
    const resolvedSkills = this.#resolvedSkills(preset);
    this.#validateSkillCompatibility(definition.engine, resolvedSkills);
    const mcpServers = this.#resolvedMcpServers(preset);
    this.#validateMcpCompatibility(definition.engine, mcpServers);
    const now = new Date().toISOString();
    const record: SessionRecord = {
      activating: undefined,
      engine: definition.engine,
      events: [],
      handle: undefined,
      native: undefined,
      nativeId: publicId,
      nextEventSequence: 1,
      title: definition.name,
      createdAt: now,
      updatedAt: now,
      workspaceId: workspace.id,
      preset,
    };
    if (definition.engine === "harness") {
      record.handle = await this.#createHarness(
        publicId,
        this.#workspaces.engineRoot(record.workspaceId),
        mcpServers,
        resolvedSkills,
        record,
      );
    } else {
      const bridge = await this.#bridge(record);
      if (bridge === undefined) throw new Error("engine_unavailable");
      record.native = await bridge.create(
        this.#workspaces.engineRoot(record.workspaceId),
        (event) =>
          this.#publish(record, this.#nativeEvent(publicId, record, event)),
        {
          mcpServers: this.#sessionMcpServers(publicId, mcpServers),
          ...this.#nativeSkillOptions(resolvedSkills, record),
          requestApproval: (approval) =>
            this.#approvals.requestNative(publicId, approval),
        },
      );
      record.nativeId = record.native.nativeId;
    }
    this.#sessions.set(publicId, record);
    this.#persist(publicId, record);
    return record;
  }

  #submittedTurn(sessionId: string, onSubmitted?: (turnId: string) => void) {
    let turnId: string | undefined;
    let result: string | undefined;
    let cleanup = () => {};
    const promise = new Promise<{ sessionId: string; result?: string }>(
      (resolve, reject) => {
        const listener = (event: PublicEvent) => {
          if (
            event.type === "turn.started" &&
            turnId === undefined &&
            typeof event.turnId === "string"
          ) {
            turnId = event.turnId;
            onSubmitted?.(turnId);
          }
          if (!turnId || !("turnId" in event) || event.turnId !== turnId)
            return;
          if (
            event.type === "assistant.completed" &&
            typeof event.content === "string"
          )
            result = event.content;
          if (event.type === "turn.completed") {
            cleanup();
            resolve({ sessionId, ...(result === undefined ? {} : { result }) });
          }
          if (event.type === "turn.failed" || event.type === "turn.cancelled") {
            cleanup();
            reject(
              new Error(
                event.type === "turn.failed"
                  ? String(event.message ?? "engine_turn_failed")
                  : "engine_turn_cancelled",
              ),
            );
          }
        };
        const listeners = this.#eventListeners.get(sessionId) ?? new Set();
        listeners.add(listener);
        this.#eventListeners.set(sessionId, listeners);
        cleanup = () => {
          listeners.delete(listener);
          if (!listeners.size) this.#eventListeners.delete(sessionId);
        };
      },
    );
    // Synchronous native terminal events can precede the send acknowledgement.
    void promise.catch(() => undefined);
    return { promise, cancel: cleanup };
  }

  #waitForTerminal(
    sessionId: string,
  ): Promise<{ sessionId: string; result?: string }> {
    return new Promise((resolve, reject) => {
      let result: string | undefined;
      const cleanup = () => {
        const listeners = this.#eventListeners.get(sessionId);
        listeners?.delete(listener);
        if (listeners?.size === 0) this.#eventListeners.delete(sessionId);
      };
      const listener = (event: PublicEvent) => {
        if (
          event.type === "assistant.completed" &&
          typeof event.content === "string"
        ) {
          result = event.content;
          return;
        }
        if (event.type === "turn.completed") {
          cleanup();
          resolve(result === undefined ? { sessionId } : { sessionId, result });
          return;
        }
        if (event.type === "turn.failed") {
          cleanup();
          reject(
            new Error(
              typeof event.message === "string"
                ? event.message
                : "automation_turn_failed",
            ),
          );
          return;
        }
        if (event.type === "turn.cancelled") {
          cleanup();
          reject(new Error("automation_turn_cancelled"));
        }
      };
      const listeners = this.#eventListeners.get(sessionId) ?? new Set();
      listeners.add(listener);
      this.#eventListeners.set(sessionId, listeners);
    });
  }

  #connectEvents(
    id: string,
    record: SessionRecord,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    response.writeHead(200, {
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    response.write(": connected\n\n");
    const lastEventId = request.headers["last-event-id"];
    for (const normalized of eventsAfterLastId(
      record.events,
      typeof lastEventId === "string" ? lastEventId : undefined,
    )) {
      response.write(
        `id: ${normalized.eventId}\ndata: ${JSON.stringify(normalized)}\n\n`,
      );
    }
    const subscribers = this.#subscribers.get(id) ?? new Set<ServerResponse>();
    subscribers.add(response);
    this.#subscribers.set(id, subscribers);
    request.once("close", () => {
      subscribers.delete(response);
      if (subscribers.size === 0) this.#subscribers.delete(id);
    });
  }

  #nativeEvent(
    sessionId: string,
    record: SessionRecord,
    event: BridgeEvent,
  ): EngineEvent {
    return {
      ...event,
      eventId: `${sessionId}-${record.nextEventSequence++}`,
      occurredAt: new Date().toISOString(),
      sessionId,
    };
  }

  async #forkSession(
    sourceId: string,
    source: SessionRecord,
    messageId: string | undefined,
    replacementContent?: string,
    kind: "fork" | "edit" | "side_chat" = "fork",
  ): Promise<RuntimeSession> {
    const messages = this.#messages.list(sourceId);
    const plan =
      messageId === undefined
        ? {
            copiedMessages: messages,
            selectedTurnId: undefined,
            previousTurnId: undefined,
            hasLaterUser: false,
          }
        : planMessageFork(
            messages,
            messageId,
            replacementContent !== undefined,
            false,
          );
    if (
      replacementContent !== undefined &&
      source.activity &&
      source.activity.state !== "idle"
    ) {
      await this.#stopForEdit(sourceId, source);
    }
    // ACP cannot fork at historical turns. Transcript branches also preserve
    // exact message boundaries when steering placed several inputs in one turn.
    const nativeFork =
      source.engine === "codex" &&
      source.contextMode !== "transcript" &&
      kind !== "side_chat" &&
      source.activity?.state !== "running" &&
      source.activity?.state !== "retrying" &&
      (messageId === undefined || plan.selectedTurnId !== undefined) &&
      !(
        replacementContent !== undefined &&
        plan.previousTurnId === plan.selectedTurnId
      ) &&
      !messages
        .slice(plan.copiedMessages.length)
        .some(
          (message) =>
            message.nativeTurnId ===
            (replacementContent === undefined
              ? plan.selectedTurnId
              : plan.previousTurnId),
        );

    const mcpServers = this.#resolvedMcpServers(
      source.preset,
      source.workspaceId,
    );
    const resolvedSkills = this.#resolvedSkills(source.preset);
    const workspace = this.#engineWorkspace(source);
    const publicId = `session-${randomUUID()}`;
    const options = {
      mcpServers: this.#sessionMcpServers(publicId, mcpServers),
      ...this.#nativeSkillOptions(resolvedSkills, source),
      requestApproval: (approval: NativeApprovalRequest) =>
        this.#approvals.requestNative(publicId, approval),
      ...(source.modelId === undefined ? {} : { modelId: source.modelId }),
      ...(source.thinkingEffort === undefined
        ? {}
        : { thinkingEffort: source.thinkingEffort }),
      ...(source.permissionMode === undefined
        ? {}
        : { permissionMode: source.permissionMode }),
    };
    const now = new Date().toISOString();
    const record: SessionRecord = {
      activating: undefined,
      engine: source.engine,
      ...(source.acpSnapshot
        ? {
            acpCatalogId: source.acpSnapshot.id,
            acpCatalogRevision: source.acpSnapshot.revision,
            acpSnapshot: source.acpSnapshot,
          }
        : {}),
      events: [],
      handle: undefined,
      native: undefined,
      nativeId: publicId,
      nextEventSequence: 1,
      title:
        `${source.title} · ${kind === "side_chat" ? "侧聊" : kind === "edit" ? "修订" : "分支"}`.slice(
          0,
          200,
        ),
      parentSessionId: sourceId,
      branchKind: kind,
      ...(messageId ? { anchorMessageId: messageId } : {}),
      contextMode: nativeFork ? "native" : "transcript",
      ...(nativeFork
        ? {}
        : { pendingContext: branchTranscript(plan.copiedMessages) }),
      createdAt: now,
      updatedAt: now,
      workspaceId: source.workspaceId,
      ...(source.workspacePath === undefined
        ? {}
        : { workspacePath: source.workspacePath }),
      ...(source.modelId === undefined ? {} : { modelId: source.modelId }),
      ...(source.thinkingEffort === undefined
        ? {}
        : { thinkingEffort: source.thinkingEffort }),
      ...(source.permissionMode === undefined
        ? {}
        : { permissionMode: source.permissionMode }),
      preset: source.preset,
    };
    const onEvent = (event: BridgeEvent) =>
      this.#publish(record, this.#nativeEvent(publicId, record, event));
    if (source.engine === "harness") {
      record.handle = await this.#createHarness(
        publicId,
        workspace,
        mcpServers,
        resolvedSkills,
        record,
      );
    } else if (nativeFork || replacementContent !== undefined) {
      const bridge = await this.#bridge(source);
      if (bridge === undefined) throw new Error("engine_unavailable");
      record.native =
        !nativeFork ||
        (replacementContent !== undefined && plan.previousTurnId === undefined)
          ? await bridge.create(workspace, onEvent, options)
          : await bridge.fork(
              source.nativeId,
              workspace,
              onEvent,
              options,
              source.engine === "codex"
                ? replacementContent === undefined
                  ? plan.selectedTurnId
                  : plan.previousTurnId
                : undefined,
            );
      record.nativeId = record.native.nativeId;
    }
    this.#sessions.set(publicId, record);
    try {
      for (const message of kind === "side_chat" ? [] : plan.copiedMessages)
        this.#messages.append({ ...message, sessionId: publicId });
      if (replacementContent !== undefined) {
        await this.#deliverInput(
          publicId,
          record,
          {
            messageId: `message-${randomUUID()}`,
            content: replacementContent,
          },
          false,
        );
      }
      this.#persist(publicId, record);
    } catch (error) {
      this.#sessions.delete(publicId);
      this.#messages.delete(publicId);
      if (record.handle !== undefined)
        await record.handle.dispose().catch(() => undefined);
      if (record.native !== undefined)
        await record.native.close().catch(() => undefined);
      throw error;
    }
    return {
      id: publicId,
      engine: record.engine,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      workspaceId: record.workspaceId,
      preset: record.preset,
      ...branchMetadata(record),
    };
  }

  async #stopForEdit(id: string, record: SessionRecord): Promise<void> {
    const listeners = this.#eventListeners.get(id) ?? new Set();
    this.#eventListeners.set(id, listeners);
    let listener!: (event: PublicEvent) => void;
    let timeout: ReturnType<typeof setTimeout>;
    const stopped = new Promise<void>((resolve, reject) => {
      listener = (event) => {
        if (
          ["turn.completed", "turn.cancelled", "turn.failed"].includes(
            event.type,
          )
        )
          resolve();
      };
      listeners.add(listener);
      timeout = setTimeout(
        () => reject(new Error("edit_stop_timeout")),
        15_000,
      );
    });
    try {
      const cancel = record.handle
        ? Promise.resolve(record.handle.agent.cancel({ kind: "user" }))
        : record.native!.cancel();
      await Promise.all([cancel, stopped]);
    } finally {
      clearTimeout(timeout!);
      listeners.delete(listener);
      if (listeners.size === 0) this.#eventListeners.delete(id);
    }
  }

  #queueChanged(id: string, record: SessionRecord): void {
    this.#persist(id, record);
    this.#publish(record, {
      type: "queue.changed",
      sessionId: id,
      eventId: `${id}-queue-${record.nextEventSequence++}`,
      occurredAt: new Date().toISOString(),
    });
  }

  async #drainQueue(id: string, record: SessionRecord): Promise<void> {
    const item = record.queue?.[0];
    if (
      !item ||
      item.error ||
      record.inputPending ||
      (record.activity && record.activity.state !== "idle") ||
      this.#sessions.get(id) !== record
    )
      return;
    try {
      await this.#deliverInput(id, record, item, false);
    } catch (error) {
      item.error =
        error instanceof Error
          ? quotaMessage(error.message)
          : "engine_turn_rejected";
      this.#queueChanged(id, record);
    }
  }

  async #deliverInput(
    id: string,
    record: SessionRecord,
    input: QueuedInput,
    steering: boolean,
    background?: {
      executionId: string;
      onSubmitted?: (turnId: string) => void;
    },
  ): Promise<void> {
    const checkBackgroundCancellation = () => {
      if (background && this.#cancelledBackground.has(background.executionId))
        throw new Error("background_execution_cancelled");
    };
    checkBackgroundCancellation();
    if (!background && !steering && this.#teamInputHandler?.(id, input)) {
      if (record.queue?.includes(input)) {
        record.queue = record.queue.filter((row) => row !== input);
        this.#queueChanged(id, record);
      }
      return;
    }
    const known = this.#messages
      .list(id)
      .find((row) => row.id === input.messageId);
    if (known) {
      if (known.text !== (input.displayContent ?? input.content))
        throw new Error("message_id_conflict");
      return;
    }
    if (this.#draining) throw new Error("runtime_draining");
    const running = !!record.activity && record.activity.state !== "idle";
    const admitted =
      background &&
      this.#backgroundAdmissions.get(id) === background.executionId;
    if (
      (!admitted &&
        (record.inputPending || this.#backgroundAdmissions.has(id))) ||
      (!steering && running)
    )
      throw new SessionBusyError(id);
    if (steering && !running) throw new Error("no_active_turn");
    if (!running) this.#workspaces.moves.drain(record.workspaceId);
    record.inputPending = true;
    let quotaRunId: string | undefined;
    let completedBeforeAcknowledgement = false;
    const previousActivity = record.activity;
    const reservedActivity = { state: "running" };
    if (!steering) record.activity = reservedActivity;
    try {
      if (!steering) {
        const next = projectCapabilityBinding(
          record.preset,
          await runtimeMarketCapabilities(record.workspaceId),
        );
        if (JSON.stringify(next) !== JSON.stringify(record.preset)) {
          this.#validateSkillCompatibility(
            record.engine,
            this.#resolvedSkills(next),
          );
          this.#validateMcpCompatibility(
            record.engine,
            this.#resolvedMcpServers(next),
          );
          await record.handle?.dispose();
          await record.native?.close();
          record.handle = undefined;
          record.native = undefined;
          record.preset = next;
        }
      }
      await this.#activate(id, record);
      let nativeTurnId: string | undefined;
      const fileChanges = this.#workspaces.moves.context(
        record.workspaceId,
        record.fileRevision,
      );
      const awareness = this.#sharedAwarenessContext(id, record);
      const content =
        (record.pendingContext ?? "") +
        (awareness?.text ?? "") +
        fileChanges.text +
        nativeFileInput(
          this.#workspaces,
          record.workspaceId,
          input.content,
          record.workspacePath,
        );
      if (!background) {
        let modelId =
          record.engine === "acp"
            ? record.acpSnapshot?.billingModelId
            : record.modelId;
        if (record.engine === "harness")
          modelId = String(this.#harnessSelection(record).model);
        if (!modelId || ["codex-native", "kimi-native"].includes(modelId)) {
          const models = await (await this.#bridge(record)).listModels();
          modelId = models.find((model) => model.isDefault)?.id;
        }
        if (!modelId) throw new Error("quota_not_configured");
        // Kimi presents a provider-qualified model ID, whereas the gateway
        // records the model name accepted by its OpenAI-compatible endpoint.
        if (record.engine === "kimi")
          modelId = modelId.replace(/^kimi-code\//, "");
        const activeTurn =
          steering && record.engine !== "kimi"
            ? record.events.findLast((event) => event.type === "turn.started")
                ?.turnId
            : undefined;
        quotaRunId = await this.#conversationQuota.begin(
          id,
          modelId,
          content,
          typeof activeTurn === "string" ? activeTurn : undefined,
          record.engine,
        );
      }
      if (this.#sessions.get(id) !== record) {
        if (quotaRunId) await this.#conversationQuota.release(quotaRunId);
        return;
      }
      if (record.handle) {
        checkBackgroundCancellation();
        record.handle.agent[steering ? "steer" : "followup"](
          createUserMessage({
            content: [{ type: "text", text: content }],
            source: { kind: "user" },
          }),
        );
      } else {
        const images = await nativeImages(
          this.#workspaces,
          record.workspaceId,
          input.content,
          record.workspacePath,
        );
        checkBackgroundCancellation();
        nativeTurnId = await record.native![steering ? "steer" : "send"](
          content,
          images,
        );
      }
      if (this.#sessions.get(id) !== record) {
        if (quotaRunId) await this.#conversationQuota.release(quotaRunId);
        return;
      }
      const submittedTurnId =
        nativeTurnId ??
        record.events.findLast((event) => event.type === "turn.started")
          ?.turnId;
      if (typeof submittedTurnId === "string")
        background?.onSubmitted?.(submittedTurnId);
      record.pendingContext = undefined;
      record.fileRevision = fileChanges.revision;
      if (awareness) record.sharedCursor = awareness.cursor;
      record.updatedAt = new Date().toISOString();
      this.#messages.append({
        id: input.messageId,
        sessionId: id,
        role: "user",
        text: input.displayContent ?? input.content,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        createdAt: record.updatedAt,
        ...(nativeTurnId === undefined ? {} : { nativeTurnId }),
      });
      if (record.queue?.includes(input)) {
        record.queue = record.queue.filter((row) => row !== input);
        this.#queueChanged(id, record);
      } else this.#persist(id, record);
      this.#publish(record, {
        type: "message.created",
        sessionId: id,
        eventId: `${id}-input-${record.nextEventSequence++}`,
        occurredAt: record.updatedAt,
      });
      completedBeforeAcknowledgement =
        nativeTurnId !== undefined &&
        record.lastTurn?.id === nativeTurnId &&
        record.lastTurn.status === "completed";
    } catch (error) {
      if (quotaRunId)
        await this.#conversationQuota
          .release(quotaRunId)
          .catch((settlementError) =>
            console.error(
              "conversation quota settlement failed",
              settlementError,
            ),
          );
      if (record.activity === reservedActivity)
        record.activity = previousActivity ?? { state: "idle" };
      if (
        error instanceof Error &&
        (error.message.startsWith("quota_") ||
          error.message.startsWith("platform_quota_") ||
          error.message.startsWith("acp_catalog_") ||
          error.message === "acp_credentials_required")
      )
        throw error;
      throw new Error(
        steering ? "engine_steer_rejected" : "engine_turn_rejected",
      );
    } finally {
      record.inputPending = false;
      if (completedBeforeAcknowledgement)
        setTimeout(() => void this.#drainQueue(id, record), 0);
    }
  }

  #publish(record: SessionRecord, event: PublicEvent): void {
    if (
      this.#sessions.get(event.sessionId) === record &&
      !record.workspaceId.startsWith("shared:") &&
      event.type === "assistant.completed" &&
      typeof event.content === "string"
    ) {
      event = {
        ...event,
        content: event.content
          .split(
            /(^ {0,3}(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}(?:`{3,}|~{3,})\s*$)/gm,
          )
          .map((chunk, index) =>
            index % 2
              ? chunk
              : chunk.replace(
                  /(`+)[\s\S]*?\1|(!?\[[^\]\n]*\]\()(<[^>]+>|[^)\n]+)(\))/g,
                  (whole, code, start, target, end) => {
                    if (code) return whole;
                    try {
                      const anchor =
                        /#L?\d+(?:-L?\d+)?$/.exec(
                          target.replace(/^<|>$/g, ""),
                        )?.[0] ?? "";
                      const reference = decodeURIComponent(
                        target
                          .replace(/^<|>$/g, "")
                          .replace(/^sandbox:|^file:\/\//, ""),
                      ).replace(/#L?\d+(?:-L?\d+)?$/, "");
                      const file = this.#workspaces.locate(
                        record.workspaceId,
                        reference,
                      );
                      return `${start}${encodeURI(file.path).replaceAll("(", "%28").replaceAll(")", "%29")}?workagentFileId=${file.fileId}${anchor}${end}`;
                    } catch {
                      return whole;
                    }
                  },
                ),
          )
          .join(""),
      };
      const known = new Set(
        this.#workspaces
          .listAssets(record.workspaceId, event.sessionId)
          .map((asset) => asset.path),
      );
      for (const match of (event.content as string).matchAll(
        /\[[^\]\n]+\]\((<[^>]+>|[^)\n]+)\)/g,
      )) {
        try {
          const reference = decodeURIComponent(
            match[1]!.replace(/^<|>$/g, "").replace(/^sandbox:|^file:\/\//, ""),
          ).replace(/#L?\d+(?:-L?\d+)?$/, "");
          if (/^[a-z]+:\/\//i.test(reference)) continue;
          const file = this.#workspaces.locate(
            record.workspaceId,
            reference.replace(/\?workagentFileId=[a-zA-Z0-9-]+$/, ""),
          );
          if (!known.has(file.path)) {
            this.#workspaces.registerArtifact(
              record.workspaceId,
              event.sessionId,
              file.path,
            );
            known.add(file.path);
          }
        } catch {
          /* A result link is an artifact only while it resolves inside this workspace. */
        }
      }
    }
    if (event.type === "turn.started" && typeof event.turnId === "string") {
      this.#preferences.started(event.sessionId, event.turnId, async () => {
        if (this.#sessions.get(event.sessionId) !== record) return;
        if (record.handle) record.handle.agent.cancel({ kind: "user" });
        else await record.native?.cancel();
      });
    } else if (
      ["turn.completed", "turn.failed", "turn.cancelled"].includes(
        event.type,
      ) &&
      typeof event.turnId === "string"
    )
      this.#preferences.ended(event.sessionId, event.turnId);
    if (event.type === "turn.started" && typeof event.turnId === "string")
      this.#conversationQuota.started(event.sessionId, event.turnId);
    if (
      ["turn.completed", "turn.failed", "turn.cancelled"].includes(
        event.type,
      ) &&
      typeof event.turnId === "string"
    ) {
      void this.#conversationQuota
        .ended(event.sessionId, event.turnId)
        .catch((error) =>
          console.error("conversation quota settlement failed", error),
        );
    }
    // Late engine callbacks may settle quota, but cannot restore deleted data.
    if (this.#sessions.get(event.sessionId) !== record) return;
    this.#openNativeLog(event.sessionId, record);
    if (this.#nativeLog?.get(event.sessionId)) {
      this.#nativeLog.appendEvent(event.sessionId, event as NativeSessionEvent);
    }
    // Activity must outlive the bounded replay log during long streamed turns.
    if (activityEventTypes.has(event.type))
      record.activity = sessionActivity([event]);
    if (
      ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type)
    ) {
      record.lastTurn = {
        id: typeof event.turnId === "string" ? event.turnId : event.eventId,
        completedAt: event.occurredAt,
        status: event.type.slice(5) as "completed" | "failed" | "cancelled",
      };
      record.updatedAt = event.occurredAt;
      this.#persist(event.sessionId, record);
    }
    if (event.type === "turn.failed" && event.code === "codex_disconnected")
      record.native = undefined;
    if (event.type === "turn.completed")
      setTimeout(() => void this.#drainQueue(event.sessionId, record), 0);
    record.events.push(event);
    if (event.type === "turn.completed" && !record.internal) {
      const turnStart = record.events.findLastIndex(
        (row) => row.type === "turn.started",
      );
      const turnEvents = record.events.slice(Math.max(0, turnStart));
      const reply = turnEvents.findLast(
        (row) => row.type === "assistant.completed",
      )?.content;
      void this.#completionNotifications
        .complete({
          sessionId: event.sessionId,
          source: this.#channelRuns.has(event.sessionId) ? "im" : "web",
          turnId:
            typeof event.turnId === "string" ? event.turnId : event.eventId,
          title: record.title,
          reply: typeof reply === "string" ? reply : "",
          workspaceId: record.workspaceId,
          startedAt: turnEvents[0]?.occurredAt ?? event.occurredAt,
          ...(this.#automationNotifications.get(event.sessionId)
            ? {
                notification: this.#automationNotifications.get(
                  event.sessionId,
                )!,
              }
            : {}),
        })
        .catch((error) =>
          console.error("completion notification failed", error),
        );
    }
    if (record.events.length > 2_000) record.events.shift();
    if (
      event.type === "assistant.completed" &&
      typeof event.content === "string"
    ) {
      this.#messages.append({
        id:
          typeof event.messageId === "string"
            ? event.messageId
            : typeof event.turnId === "string"
              ? event.turnId
              : event.eventId,
        sessionId: event.sessionId,
        role: "assistant",
        text: event.content,
        createdAt: event.occurredAt,
        ...(event.kind === "commentary" ||
        event.kind === "question" ||
        event.kind === "answer"
          ? { kind: event.kind }
          : {}),
        ...(typeof event.turnId === "string"
          ? { nativeTurnId: event.turnId }
          : {}),
      });
    }
    if (event.type === "turn.failed" && typeof event.message === "string") {
      this.#messages.append({
        id: `${typeof event.turnId === "string" ? event.turnId : event.eventId}-failed`,
        sessionId: event.sessionId,
        role: "assistant",
        text: /high demand|overloaded|server.*busy/i.test(event.message)
          ? "模型服务当前繁忙，本次请求未完成。请稍后重试，或在模型设置中选择其他模型。"
          : `本次请求未完成：${event.message}`,
        createdAt: event.occurredAt,
      });
    }
    for (const listener of this.#eventListeners.get(event.sessionId) ?? [])
      listener(event);
    for (const response of this.#subscribers.get(event.sessionId) ?? []) {
      response.write(
        `id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    }
  }

  async #prepareAcp(record: SessionRecord): Promise<void> {
    const presetId = record.preset.resolvedSnapshot.acpCatalogId;
    if (record.engine !== "acp") {
      if (record.acpCatalogId || presetId)
        throw new Error("acp_catalog_forbidden");
      return;
    }
    const id = record.acpCatalogId ?? presetId;
    if (!id || (presetId && presetId !== id))
      throw new Error("preset_acp_catalog_mismatch");
    const approved = await this.#acp.resolve(id, record.acpCatalogRevision);
    if (
      record.acpSnapshot &&
      JSON.stringify({
        ...record.acpSnapshot,
        resolvedCommand: undefined,
        enabled: true,
      }) !==
        JSON.stringify({
          ...approved,
          resolvedCommand: undefined,
          enabled: true,
        })
    )
      throw new Error("acp_catalog_revision_changed");
    record.acpCatalogId = id;
    record.acpCatalogRevision = approved.revision;
    record.acpSnapshot ??= (({
      resolvedCommand: _resolvedCommand,
      ...snapshot
    }) => snapshot)(approved);
  }

  async #bridge(record: SessionRecord): Promise<EngineBridge> {
    await this.#prepareAcp(record);
    if (record.engine === "acp") return this.#acp.bridge(record.acpSnapshot!);
    if (record.engine === "harness") throw new Error("engine_not_native");
    const bridge = this.#bridges.get(record.engine);
    if (!bridge) throw new Error("engine_unavailable");
    return bridge;
  }

  async #activate(id: string, record: SessionRecord): Promise<void> {
    await this.#prepareAcp(record);
    if (
      record.creation &&
      this.#index.lookupOperation(record.creation.operationId)?.state !==
        "ready"
    )
      throw new Error("session_deleted");
    if (record.handle !== undefined || record.native?.connected === true)
      return;
    record.activating ??= this.#resume(id, record).finally(() => {
      record.activating = undefined;
    });
    await record.activating;
  }

  async #resume(id: string, record: SessionRecord): Promise<void> {
    if (record.workspaceId.startsWith("shared:"))
      this.#resolveSharedWorkspacePath(record);
    const mcpServers = this.#resolvedMcpServers(
      record.preset,
      record.workspaceId,
    );
    this.#validateMcpCompatibility(record.engine, mcpServers);
    const resolvedSkills = this.#resolvedSkills(record.preset);
    if (!id.startsWith("session-channel-"))
      this.#validateSkillCompatibility(record.engine, resolvedSkills);
    if (record.engine === "harness") {
      const configuration = this.#executionConfiguration(record);
      const selection = this.#harnessSelection(record);
      try {
        record.handle = await this.#ctx.agents.resume({
          resumeSessionId: SessionId(record.nativeId),
          agentOptions: {
            provider: selection.provider,
            model: selection.model,
          },
          setup: async (agentContext) => {
            this.#applyHarnessConfiguration(agentContext, configuration);
            installModelSelection(agentContext, {
              current: selection,
              assembled: undefined,
            });
            for (const config of projectHarnessMcpServers(
              mcpServers,
              this.#engineWorkspace(record),
            ))
              await installMcp(agentContext, config);
            this.#installHarnessSkills(agentContext, resolvedSkills);
          },
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== `session "${record.nativeId}" not found`
        )
          throw error;
        record.handle = await this.#createHarness(
          record.nativeId,
          this.#engineWorkspace(record),
          mcpServers,
          resolvedSkills,
          record,
        );
      }
      return;
    }
    const bridge = await this.#bridge(record);
    if (bridge === undefined) throw new Error("engine unavailable");
    const onEvent = (event: BridgeEvent) =>
      this.#publish(record, this.#nativeEvent(id, record, event));
    const options = {
      ...(record.requirePermission ? { requirePermission: true } : {}),
      mcpServers: this.#sessionMcpServers(id, mcpServers),
      ...this.#nativeSkillOptions(resolvedSkills, record),
      requestApproval: (approval: NativeApprovalRequest) =>
        // Internal shared tasks have no interactive approval surface.
        record.internal
          ? Promise.resolve("cancel" as const)
          : this.#approvals.requestNative(id, approval),
      ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
      ...(record.thinkingEffort === undefined
        ? {}
        : { thinkingEffort: record.thinkingEffort }),
      ...(record.permissionMode === undefined
        ? {}
        : { permissionMode: record.permissionMode }),
    };
    let resumed: BridgeSession;
    try {
      resumed =
        record.nativeId === id
          ? await bridge.create(this.#engineWorkspace(record), onEvent, options)
          : await bridge.resume(
              record.nativeId,
              this.#engineWorkspace(record),
              onEvent,
              options,
            );
    } catch (error) {
      const session = this.#nativeLog?.get(id);
      // Codex does not persist an unused thread. After unsubscribe/restart,
      // only a proven original blank session can acquire a replacement thread.
      // Never replace a missing transcript or inherited fork context.
      if (
        record.engine !== "codex" ||
        !(error instanceof Error) ||
        error.message !== `no rollout found for thread id ${record.nativeId}` ||
        !session ||
        record.parentSessionId ||
        session.header.parentSession ||
        record.lastTurn ||
        this.#messages.list(id).length > 0 ||
        session.events.some(
          (event) =>
            event.type === "turn/start" ||
            event.type === "user/message" ||
            event.type === "workagent/native/message",
        )
      )
        throw error;
      if (this.#sessions.get(id) !== record)
        throw new Error("session_not_found");
      resumed = await bridge.create(
        this.#engineWorkspace(record),
        onEvent,
        options,
      );
    }
    if (this.#sessions.get(id) !== record) {
      await resumed.close();
      throw new Error("session_not_found");
    }
    record.native = resumed;
    record.nativeId = record.native.nativeId;
    this.#persist(id, record);
  }

  #executionConfiguration(
    record: Pick<
      SessionRecord,
      | "engine"
      | "preset"
      | "workspaceId"
      | "workspacePath"
      | "modelId"
      | "thinkingEffort"
      | "permissionMode"
      | "acpSnapshot"
    >,
  ) {
    return resolveExecutionConfiguration({
      engine: record.engine,
      preset: record.preset,
      overrides: record,
      ...(record.acpSnapshot
        ? { acpBillingModelId: record.acpSnapshot.billingModelId }
        : {}),
      workspace:
        record.workspacePath ?? this.#workspaces.engineRoot(record.workspaceId),
      workspaceAssigned:
        record.workspaceId !== "default" ||
        (record.workspacePath !== undefined &&
          resolvePath(record.workspacePath) !==
            resolvePath(this.#workspaces.engineRoot("default"))),
    });
  }

  #nativeSkillOptions(skills: readonly ResolvedSkill[], record: SessionRecord) {
    const configuration = this.#executionConfiguration(record);
    return {
      skills,
      systemPrompt: configuration.systemPrompt,
      ...(record.engine !== "acp" ||
      record.permissionMode !== undefined ||
      record.acpSnapshot?.permissionModes?.[configuration.permissionMode]
        ? { permissionMode: configuration.permissionMode }
        : {}),
      approvalPolicy: configuration.approvalPolicy,
      requirePermission:
        record.engine !== "acp" || record.permissionMode !== undefined,
      ...(configuration.engineModelId
        ? { modelId: configuration.engineModelId }
        : {}),
      ...(configuration.thinkingEffort
        ? { thinkingEffort: configuration.thinkingEffort }
        : {}),
      nativeSkillPaths: this.#skills.nativeSkillPaths,
      catalogSkills: this.#skills
        .listSkills()
        .filter((skill) => skill.referenceDirectory && skill.enabled)
        .map((skill) => this.#skills.resolveSkill(skill.id)!),
      nativeMcpNames: this.#mcp.nativeNames,
      nativeMcpConfig: this.#mcp.nativeConfig,
    };
  }

  async #applyMarketChange(change: MarketChange): Promise<void> {
    const affected = [...this.#sessions].filter(
      ([id, record]) =>
        (change.urgent || !record.workspaceId.startsWith("shared:")) &&
        (record.preset.resolvedSnapshot.skillIds.some(
          (id) => id in change.skills,
        ) ||
          record.preset.resolvedSnapshot.mcpServerIds.some(
            (id) => id in change.mcp,
          ) ||
          record.preset.presetId in change.assistants),
    );
    if (
      !change.urgent &&
      affected.some(
        ([, r]) =>
          r.inputPending || (r.activity && r.activity.state !== "idle"),
      )
    )
      throw new Error("market_update_session_busy");
    if (!change.urgent) {
      for (const [, r] of affected) {
        const next = change.assistants[r.preset.presetId]
          ? this.#presets.resolve(change.assistants[r.preset.presetId]!)
          : {
              ...r.preset,
              resolvedSnapshot: {
                ...r.preset.resolvedSnapshot,
                skillIds: remapCapabilityIds(
                  r.preset.resolvedSnapshot.skillIds,
                  change.skills,
                ),
                mcpServerIds: remapCapabilityIds(
                  r.preset.resolvedSnapshot.mcpServerIds,
                  change.mcp,
                ),
                resolvedMcpServers: undefined,
              },
            };
        try {
          if (next.resolvedSnapshot.engine !== r.engine)
            throw new Error("engine_changed");
          this.#validateSkillCompatibility(
            r.engine,
            this.#resolvedSkills(next),
          );
          this.#validateMcpCompatibility(
            r.engine,
            this.#resolvedMcpServers(next),
          );
        } catch {
          throw new Error("market_capability_incompatible");
        }
      }
    }
    for (const [id, r] of affected) {
      if (change.urgent) {
        r.inputPending = true;
        if (r.queue)
          for (const q of r.queue) q.error = "能力已由管理员变更，请检查后重试";
        if (r.activity && r.activity.state !== "idle")
          await this.#stopForEdit(id, r);
      }
      await r.handle?.dispose();
      await r.native?.close();
      r.handle = undefined;
      r.native = undefined;
      const snapshot = {
        ...r.preset.resolvedSnapshot,
        skillIds: remapCapabilityIds(
          r.preset.resolvedSnapshot.skillIds,
          change.skills,
        ),
        mcpServerIds: remapCapabilityIds(
          r.preset.resolvedSnapshot.mcpServerIds,
          change.mcp,
        ),
      };
      delete snapshot.resolvedMcpServers;
      r.preset = {
        ...r.preset,
        resolvedSnapshot: snapshot,
        ...(r.preset.projectBase
          ? {
              projectBase: {
                ...r.preset.projectBase,
                skillIds: remapCapabilityIds(
                  r.preset.projectBase.skillIds,
                  change.skills,
                ),
                mcpServerIds: remapCapabilityIds(
                  r.preset.projectBase.mcpServerIds,
                  change.mcp,
                ),
                resolvedMcpServers: undefined,
              },
            }
          : {}),
      };
      if (change.assistants[r.preset.presetId])
        r.preset = this.#presets.resolve(change.assistants[r.preset.presetId]!);
      r.inputPending = false;
      this.#persist(id, r);
    }
    for (const p of this.#presets.list()) {
      if (p.source !== "user") continue;
      if (p.id in change.assistants) {
        this.#presets.update(p.id, { enabled: false });
        continue;
      }
      if (
        !p.skillIds.some((id) => id in change.skills) &&
        !p.mcpServerIds.some((id) => id in change.mcp)
      )
        continue;
      this.#presets.update(p.id, {
        skillIds: remapCapabilityIds(p.skillIds, change.skills),
        mcpServerIds: remapCapabilityIds(p.mcpServerIds, change.mcp),
      });
    }
  }

  #resolvedMcpServers(
    binding: PresetBinding,
    workspaceId?: string,
  ): readonly ResolvedMcpServer[] {
    const snapshot = binding.resolvedSnapshot;
    const ids =
      snapshot.resolvedMcpServers?.map((server) => server.id) ??
      snapshot.mcpServerIds;
    const servers = ids.map((id) => {
      const server = this.#mcp.resolveServer(id);
      if (server === undefined)
        throw new Error(`invalid_mcp_binding:${id}:not_found`);
      return server;
    });
    if (
      binding.presetId === "builtin-puxin-butler" ||
      snapshot.systemPrompt.startsWith("你是 AI管家，") ||
      snapshot.systemPrompt.startsWith("你是 PuxinAI 管家，")
    )
      servers.push(butlerServer());
    servers.push(messageServer());
    if (workspaceId?.startsWith("shared:"))
      servers.push(sharedTrashServer(workspaceId.slice("shared:".length)));
    return servers;
  }

  #resolvedSkills(binding: PresetBinding): readonly ResolvedSkill[] {
    return binding.resolvedSnapshot.skillIds.map((id) => {
      const skill = this.#skills.resolveSkill(id);
      if (skill === undefined)
        throw new Error(`invalid_skill_binding:${id}:not_found`);
      return skill;
    });
  }

  #validateSkillCompatibility(
    engine: SessionRecord["engine"],
    skills: readonly ResolvedSkill[],
  ): void {
    if (
      skills.some(
        (skill) => skill.entry.compatibleEngines?.includes(engine) === false,
      )
    )
      throw new Error(`unsupported_skill_binding:${engine}`);
    if (
      skills.some(
        (skill) =>
          !skill.entry.referenceDirectory && skill.entry.source !== "market",
      ) &&
      engine !== "harness"
    )
      throw new Error(`unsupported_skill_binding:${engine}`);
  }

  #installHarnessSkills(
    agentContext: Context,
    skills: readonly ResolvedSkill[],
  ): void {
    for (const skill of skills)
      installSkillProvider(agentContext, {
        providerName: `workagent-${skill.entry.id}`,
        includeDefaultRoots: false,
        customSkillDirs: [],
        bundledSkillDir: skill.root,
        watch: false,
        watchFollowSymlinks: false,
      });
  }

  #validateMcpCompatibility(
    engine: SessionRecord["engine"],
    servers: readonly ResolvedMcpServer[],
  ): void {
    for (const projection of servers) {
      const { server } = projection;
      if (projection.state !== "ready")
        throw new Error(`invalid_mcp_binding:${server.id}:${projection.state}`);
      if (engine !== "codex" && server.toolPolicy !== "all")
        throw new Error(`unsupported_mcp_tool_policy:${server.id}`);
      if (server.transport.kind === "sse" && engine !== "kimi")
        throw new Error(`unsupported_mcp_transport:${engine}:sse:${server.id}`);
    }
  }

  #record(session: StoredSession, defaultWorkspaceId: string): SessionRecord {
    return {
      ...session,
      activating: undefined,
      events: [],
      handle: undefined,
      native: undefined,
      nextEventSequence: 1,
      workspaceId: session.workspaceId ?? defaultWorkspaceId,
      preset:
        session.preset ??
        this.#presets.resolve(
          session.engine === "harness"
            ? "builtin-general"
            : `builtin-${session.engine}`,
        ),
    };
  }

  #persist(id: string, record: SessionRecord): void {
    // Pending inputs and queue failures may finish after deletion.
    if (this.#sessions.get(id) !== record) return;
    this.#openNativeLog(id, record);
    this.#index.set({
      id,
      ...(record.channelKey ? { channelKey: record.channelKey } : {}),
      ...(record.creation ? { creation: record.creation } : {}),
      nativeId: record.nativeId,
      engine: record.engine,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      workspaceId: record.workspaceId,
      ...(record.workspacePath === undefined
        ? {}
        : { workspacePath: record.workspacePath }),
      ...(record.internal === undefined ? {} : { internal: record.internal }),
      ...(record.modelId === undefined ? {} : { modelId: record.modelId }),
      ...(record.thinkingEffort === undefined
        ? {}
        : { thinkingEffort: record.thinkingEffort }),
      ...(record.permissionMode === undefined
        ? {}
        : { permissionMode: record.permissionMode }),
      preset: record.preset,
      ...branchMetadata(record),
      lastTurn: record.lastTurn,
      ...(record.queue === undefined ? {} : { queue: record.queue }),
      ...(record.fileRevision === undefined
        ? {}
        : { fileRevision: record.fileRevision }),
      ...(record.sharedCursor === undefined
        ? {}
        : { sharedCursor: record.sharedCursor }),
      ...(record.pendingContext === undefined
        ? {}
        : { pendingContext: record.pendingContext }),
    });
    this.#publishNativeMetadata(id, record);
  }

  #engineWorkspace(record: SessionRecord): string {
    return (
      record.workspacePath ?? this.#workspaces.engineRoot(record.workspaceId)
    );
  }

  /**
   * Re-resolve a shared project's folder at (re)materialization time: after an
   * ownership transfer the folder lives under a different owner's root, so the
   * stored path may be stale. Fails the resume when the project is gone.
   */
  #resolveSharedWorkspacePath(record: SessionRecord): void {
    const sharedRoot = process.env.WORKAGENT_SHARED_ROOT;
    if (sharedRoot === undefined) return;
    const resolved = resolveSharedProjectRoot(
      dirname(sharedRoot),
      record.workspaceId.slice("shared:".length),
    );
    if (resolved !== record.workspacePath) record.workspacePath = resolved;
  }

  /**
   * Collaborator-change context for sessions on shared workspaces; undefined
   * for personal workspaces (zero overhead) and empty text when nothing
   * changed. The cursor persists on the record like `fileRevision`.
   */
  #sharedAwarenessContext(
    id: string,
    record: SessionRecord,
  ): { text: string; cursor: number } | undefined {
    if (
      !record.workspaceId.startsWith("shared:") ||
      record.workspacePath === undefined
    )
      return undefined;
    const result = this.#awareness.changes(
      id,
      record.workspacePath,
      record.sharedCursor ?? 0,
    );
    return { text: sharedChangesText(result.paths), cursor: result.cursor };
  }

  /**
   * Record own file observations (read/write/edit outcomes) for shared
   * harness sessions so the change feed can exclude the session's own writes.
   * The cordis fs/observed event carries the tool-execution actor; the cordis
   * session id equals `record.nativeId`. Native engines write directly from
   * their CLIs, so their own edits stay visible in the feed — harmless.
   */
  #observeSharedFile(
    target: { displayPath: string },
    observation: { kind: "present" | "absent" },
    actor: unknown,
  ): void {
    const cordisId = (
      actor as { agent?: { session?: { id?: unknown } } } | undefined
    )?.agent?.session?.id;
    if (cordisId === undefined) return;
    const entry = [...this.#sessions].find(
      ([, record]) =>
        record.engine === "harness" && record.nativeId === String(cordisId),
    );
    if (entry === undefined) return;
    const [id, record] = entry;
    if (
      !record.workspaceId.startsWith("shared:") ||
      record.workspacePath === undefined
    )
      return;
    if (observation.kind === "absent") {
      this.#awareness.forgetOwn(id, record.workspacePath, target.displayPath);
      return;
    }
    try {
      const stat = statSync(target.displayPath);
      if (stat.isFile())
        this.#awareness.observeOwn(
          id,
          record.workspacePath,
          target.displayPath,
          {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
          },
        );
    } catch {
      // The file vanished between the operation and the observation.
    }
  }

  #createHarness(
    id: string,
    workspace: string,
    mcpServers: readonly ResolvedMcpServer[],
    skills: readonly ResolvedSkill[],
    record: Pick<
      SessionRecord,
      | "engine"
      | "preset"
      | "workspaceId"
      | "workspacePath"
      | "modelId"
      | "thinkingEffort"
      | "permissionMode"
    >,
  ): Promise<AgentHandle> {
    const configuration = this.#executionConfiguration(record);
    const selection = this.#harnessSelection(record);
    return this.#ctx.agents.create({
      sessionId: SessionId(id),
      meta: { cwd: workspace },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentContext) => {
        this.#applyHarnessConfiguration(agentContext, configuration);
        installModelSelection(agentContext, {
          current: selection,
          assembled: undefined,
        });
        for (const config of projectHarnessMcpServers(
          this.#sessionMcpServers(id, mcpServers),
          workspace,
        ))
          await installMcp(agentContext, config);
        this.#installHarnessSkills(agentContext, skills);
      },
    });
  }

  #harnessSelection(record: Pick<SessionRecord, "modelId" | "thinkingEffort">) {
    const current = this.#ctx.agentDefaultModel.currentSelection();
    return {
      ...current,
      ...(record.modelId && record.modelId !== "harness-default"
        ? { model: record.modelId }
        : {}),
      ...(record.thinkingEffort
        ? { reasoningEffort: ReasoningEffortId(record.thinkingEffort) }
        : {}),
    };
  }

  #applyHarnessConfiguration(
    agentContext: Context,
    configuration: ReturnType<typeof resolveExecutionConfiguration>,
  ) {
    installHarnessPrompt(agentContext, configuration.systemPrompt);
    const permissions = (
      this.#ctx as Context & {
        permissionPresets: {
          set(
            session: NonNullable<Context["agent"]>["session"],
            preset: string,
          ): void;
        };
      }
    ).permissionPresets;
    permissions.set(
      agentContext.agent!.session,
      configuration.permissionMode === "read_only"
        ? "read-only"
        : configuration.permissionMode === "full_access"
          ? "danger-full-access"
          : "workspace-write",
    );
  }
}
