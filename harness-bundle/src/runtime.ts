import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import {
  installModelSelection,
  type AgentHandle,
} from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { apply as installMcp } from "@deepseek-ai/dsh-mcp-client";
import { apply as installSkillProvider } from "@deepseek-ai/dsh-skill-filesystem";
import {
  SessionId,
  type Session,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import { CodexBridge } from "./engines/codex.js";
import { KimiBridge } from "./engines/kimi.js";
import type {
  BridgeEvent,
  BridgeSession,
  EngineBridge,
} from "./engines/types.js";
import { authorized } from "./index.js";
import { ApprovalBridge } from "./approval-bridge.js";
import { SessionIndex, type StoredSession } from "./session-index.js";
import { ENGINE_CAPABILITIES } from "./engine-registry.js";
import { WorkspaceStore } from "./workspace-store.js";
import { MessageStore } from "./message-store.js";
import type {
  AutomationExecution,
  AutomationRunnerPort,
} from "./automation-store.js";
import type { PresetBinding } from "@workagent/contracts";
import type { PresetStore } from "./preset-store.js";
import type { McpCatalogStore, SkillCatalogStore } from "./capability-store.js";
import type { ResolvedMcpServer } from "./mcp-projection.js";
import type { ResolvedSkill } from "./skill-projection.js";
import type { TeamExecution, TeamRunnerPort } from "./team-store.js";
import type { InboxExecution, InboxRunnerPort } from "./inbox-api.js";
import { projectHarnessMcpServers } from "./engines/harness-mcp.js";

type SessionRecord = {
  createdAt: string;
  engine: "harness" | "codex" | "kimi";
  events: PublicEvent[];
  handle: AgentHandle | undefined;
  native: BridgeSession | undefined;
  nativeId: string;
  nextEventSequence: number;
  activating: Promise<void> | undefined;
  title: string;
  updatedAt: string;
  workspaceId: string;
  preset: PresetBinding;
};

type PublicEvent = Record<string, unknown> & {
  eventId: string;
  occurredAt: string;
  sessionId: string;
  type: string;
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
): PublicEvent | undefined => {
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
  implements AutomationRunnerPort, TeamRunnerPort, InboxRunnerPort
{
  readonly #ctx: Context;
  readonly #token: string;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #subscribers = new Map<string, Set<ServerResponse>>();
  readonly #eventListeners = new Map<
    string,
    Set<(event: PublicEvent) => void>
  >();
  readonly #automationExecutions = new Map<
    string,
    Promise<{ sessionId: string; result?: string }>
  >();
  readonly #bridges = new Map<"codex" | "kimi", EngineBridge>();
  readonly #index: SessionIndex;
  readonly #workspaces: WorkspaceStore;
  readonly #messages: MessageStore;
  readonly #presets: PresetStore;
  readonly #mcp: McpCatalogStore;
  readonly #skills: SkillCatalogStore;

  constructor(
    ctx: Context,
    token: string,
    workspaces: WorkspaceStore,
    presets: PresetStore,
    mcp: McpCatalogStore,
    skills: SkillCatalogStore,
  ) {
    this.#ctx = ctx;
    this.#token = token;
    const dshHome = process.env.DSH_HOME;
    if (dshHome === undefined)
      throw new Error("workagent-runtime-api: DSH_HOME is required");
    this.#index = new SessionIndex(dshHome);
    this.#messages = new MessageStore(dshHome);
    this.#workspaces = workspaces;
    this.#presets = presets;
    this.#mcp = mcp;
    this.#skills = skills;
    const defaultWorkspace = workspaces.ensureDefault();
    this.#bridges.set("codex", new CodexBridge());
    this.#bridges.set("kimi", new KimiBridge());
    for (const session of this.#index.list()) {
      const record = this.#record(session, defaultWorkspace.id);
      this.#sessions.set(session.id, record);
      if (session.workspaceId === undefined || session.preset === undefined)
        this.#persist(session.id, record);
    }
    new ApprovalBridge(ctx, token, dshHome, (sessionId, event) => {
      const record = this.#sessions.get(sessionId);
      if (record === undefined) return;
      this.#publish(record, {
        ...event,
        eventId: `${sessionId}-interaction-${record.nextEventSequence++}`,
        occurredAt: new Date().toISOString(),
        sessionId,
      });
    });
  }

  workspaceForSession(sessionId: string): string | undefined {
    return this.#sessions.get(sessionId)?.workspaceId;
  }

  execute(
    request: AutomationExecution,
  ): Promise<{ sessionId: string; result?: string }> {
    const active = this.#automationExecutions.get(request.automationRunId);
    if (active !== undefined) return active;
    const execution = this.#executeAutomation(request).finally(() => {
      this.#automationExecutions.delete(request.automationRunId);
    });
    this.#automationExecutions.set(request.automationRunId, execution);
    return execution;
  }

  executeTeamTask(
    request: TeamExecution,
  ): Promise<{ sessionId: string; result?: string }> {
    const now = new Date().toISOString();
    return this.execute({
      automationRunId: request.taskId,
      definition: {
        id: `team-${request.teamId}-${request.memberId}`,
        version: 1,
        name: request.name,
        enabled: false,
        schedule: { kind: "interval", everyMinutes: 1 },
        presetId: request.presetId,
        engine: request.engine,
        workspaceId: request.workspaceId,
        input: request.input,
        notificationPolicy: "none",
        nextRunAt: null,
        lastRunAt: null,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  async executeInbox(request: InboxExecution): Promise<{ sessionId: string }> {
    const messageId = `message-${request.receiptId}`;
    if (
      this.#messages
        .list(request.sessionId)
        .some((message) => message.id === messageId)
    ) {
      return { sessionId: request.sessionId };
    }
    const now = new Date().toISOString();
    const workspaceId = this.#workspaces.ensureDefault().id;
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
      nextRunAt: null,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const record = await this.#startAutomationSession(request.sessionId, {
      automationRunId: request.receiptId,
      definition,
    });
    if (record.handle === undefined && record.native === undefined)
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
    record.updatedAt = now;
    if (record.handle !== undefined) {
      record.handle.agent.followup(
        createUserMessage({
          content: [{ type: "text", text: runtimeInput }],
          source: { kind: "user" },
        }),
      );
    } else {
      await record.native!.send(runtimeInput);
    }
    this.#messages.append({
      id: messageId,
      sessionId: request.sessionId,
      role: "user",
      text: runtimeInput,
      createdAt: now,
    });
    this.#persist(request.sessionId, record);
    await terminal;
    return { sessionId: request.sessionId };
  }

  cancelTeamTask(taskId: string): Promise<void> {
    return this.cancel(taskId);
  }

  async cancel(automationRunId: string): Promise<void> {
    const sessionId = this.#automationSessionId(automationRunId);
    const record = this.#sessions.get(sessionId);
    if (record === undefined) return;
    await this.#activate(sessionId, record);
    if (record.handle !== undefined) {
      record.handle.agent.cancel({ kind: "user" });
      return;
    }
    await record.native!.cancel();
  }

  mount(): void {
    this.#ctx.effect(
      () => () =>
        Promise.all(
          [...this.#bridges.values()].map((bridge) => bridge.close()),
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
          kind: "prefix",
          path: "/v1/sessions",
          handler: (request, response) => this.#handle(request, response),
        }),
      "workagent-runtime-api: session routes",
    );
    this.#ctx.effect(
      () =>
        this.#ctx.on("session/event", (session, event) => {
          const normalized = normalizeEvent(session, event);
          if (normalized === undefined) return;
          const record = this.#sessions.get(String(session.id));
          if (record !== undefined) this.#publish(record, normalized);
        }),
      "workagent-runtime-api: normalized session events",
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
    const path = new URL(request.url ?? "/", "http://runtime").pathname;
    if (path === "/v1/sessions" && request.method === "GET") {
      writeJson(
        response,
        200,
        [...this.#sessions.entries()].map(([id, value]) => ({
          id,
          engine: value.engine,
          title: value.title,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt,
          workspaceId: value.workspaceId,
          preset: value.preset,
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
      if (record === undefined) {
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
          preset: record.preset,
        });
        return;
      }
      if (request.method === "GET") {
        writeJson(response, 200, {
          id,
          engine: record.engine,
          title: record.title,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          workspaceId: record.workspaceId,
          preset: record.preset,
        });
        return;
      }
      if (request.method === "DELETE") {
        try {
          if (record.activating !== undefined) await record.activating;
          if (record.handle !== undefined) await record.handle.dispose();
          if (record.native !== undefined) await record.native.close();
        } catch (error) {
          console.error("workagent-runtime-api: session close failed", error);
          writeJson(response, 503, { error: "session_close_failed" });
          return;
        }
        this.#sessions.delete(id);
        this.#index.delete(id);
        this.#messages.delete(id);
        for (const subscriber of this.#subscribers.get(id) ?? []) {
          subscriber.end();
        }
        this.#subscribers.delete(id);
        response.writeHead(204);
        response.end();
        return;
      }
      writeJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    const match =
      /^\/v1\/sessions\/([^/]+)\/(turns|cancel|events|resume|messages)$/.exec(
        path,
      );
    if (match === null) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    const id = decodeURIComponent(match[1] ?? "");
    const record = this.#sessions.get(id);
    if (record === undefined) {
      writeJson(response, 404, { error: "session_not_found" });
      return;
    }
    if (match[2] !== "events" && match[2] !== "messages") {
      try {
        await this.#activate(id, record);
      } catch (error) {
        console.error("workagent-runtime-api: session resume failed", error);
        writeJson(response, 503, { error: "session_resume_failed" });
        return;
      }
    }
    if (match[2] === "messages" && request.method === "GET") {
      writeJson(response, 200, this.#messages.list(id));
      return;
    }
    if (match[2] === "turns" && request.method === "POST") {
      const input = await readJson(request);
      if (
        typeof input.content !== "string" ||
        input.content.trim() === "" ||
        (input.displayContent !== undefined &&
          (typeof input.displayContent !== "string" ||
            input.displayContent.trim() === ""))
      ) {
        writeJson(response, 400, { error: "content_required" });
        return;
      }
      record.updatedAt = new Date().toISOString();
      if (record.handle !== undefined) {
        record.handle.agent.followup(
          createUserMessage({
            content: [{ type: "text", text: input.content }],
            source: { kind: "user" },
          }),
        );
      } else {
        try {
          await record.native!.send(input.content);
        } catch {
          writeJson(response, 409, { error: "engine_turn_rejected" });
          return;
        }
      }
      this.#messages.append({
        id: `message-${randomUUID()}`,
        sessionId: id,
        role: "user",
        text:
          typeof input.displayContent === "string"
            ? input.displayContent
            : input.content,
        createdAt: new Date().toISOString(),
      });
      this.#persist(id, record);
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
        preset: record.preset,
      });
      return;
    }
    if (match[2] === "cancel" && request.method === "POST") {
      if (record.handle !== undefined)
        record.handle.agent.cancel({ kind: "user" });
      else {
        try {
          await record.native!.cancel();
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

  async #create(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const input = await readJson(request);
    if (
      (input.engine !== "harness" &&
        input.engine !== "codex" &&
        input.engine !== "kimi") ||
      typeof input.title !== "string" ||
      input.title.trim() === "" ||
      input.title.length > 200 ||
      typeof input.workspace !== "string"
    ) {
      writeJson(response, 400, { error: "invalid_session" });
      return;
    }
    const workspace =
      input.workspace === "default"
        ? this.#workspaces.ensureDefault()
        : this.#workspaces.get(input.workspace);
    if (workspace === undefined) {
      writeJson(response, 400, { error: "workspace_not_found" });
      return;
    }
    const publicId = `session-${randomUUID()}`;
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
      mcpServers = this.#resolvedMcpServers(preset);
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
      events: [],
      handle: undefined,
      native: undefined,
      nativeId: publicId,
      nextEventSequence: 1,
      title: input.title.trim(),
      createdAt: now,
      updatedAt: now,
      workspaceId: workspace.id,
      preset,
    };
    try {
      if (input.engine === "harness") {
        record.handle = await this.#createHarness(
          publicId,
          this.#workspaces.engineRoot(record.workspaceId),
          mcpServers,
          resolvedSkills,
        );
      } else {
        const bridge = this.#bridges.get(input.engine);
        if (bridge === undefined) {
          writeJson(response, 503, { error: "engine_unavailable" });
          return;
        }
        record.native = await bridge.create(
          this.#workspaces.engineRoot(record.workspaceId),
          (event) => {
            this.#publish(record, this.#nativeEvent(publicId, record, event));
          },
          { mcpServers },
        );
        record.nativeId = record.native.nativeId;
      }
    } catch {
      writeJson(response, 503, { error: "engine_start_failed" });
      return;
    }
    this.#sessions.set(publicId, record);
    this.#persist(publicId, record);
    writeJson(response, 201, {
      id: publicId,
      engine: input.engine,
      title: input.title.trim(),
      createdAt: now,
      updatedAt: now,
      workspaceId: workspace.id,
      preset,
    });
  }

  async #executeAutomation(
    request: AutomationExecution,
  ): Promise<{ sessionId: string; result?: string }> {
    const definition = request.definition;
    const sessionId = this.#automationSessionId(request.automationRunId);
    const record = await this.#startAutomationSession(sessionId, request);
    const terminal = this.#waitForTerminal(sessionId);
    record.updatedAt = new Date().toISOString();
    try {
      if (record.handle !== undefined) {
        record.handle.agent.followup(
          createUserMessage({
            content: [{ type: "text", text: definition.input }],
            source: { kind: "user" },
          }),
        );
      } else {
        await record.native!.send(definition.input);
      }
    } catch (error) {
      this.#publish(record, {
        eventId: `${sessionId}-${record.nextEventSequence++}`,
        occurredAt: new Date().toISOString(),
        sessionId,
        type: "turn.failed",
        turnId: `turn-${request.automationRunId}`,
        code: "engine_turn_rejected",
        message:
          error instanceof Error ? error.message : "engine_turn_rejected",
      });
    }
    this.#messages.append({
      id: `message-${request.automationRunId}`,
      sessionId,
      role: "user",
      text: definition.input,
      createdAt: new Date().toISOString(),
    });
    this.#persist(sessionId, record);
    return terminal;
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
      );
    } else {
      const bridge = this.#bridges.get(definition.engine);
      if (bridge === undefined) throw new Error("engine_unavailable");
      record.native = await bridge.create(
        this.#workspaces.engineRoot(record.workspaceId),
        (event) =>
          this.#publish(record, this.#nativeEvent(publicId, record, event)),
        { mcpServers },
      );
      record.nativeId = record.native.nativeId;
    }
    this.#sessions.set(publicId, record);
    this.#persist(publicId, record);
    return record;
  }

  #automationSessionId(automationRunId: string): string {
    return `session-${automationRunId}`;
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
  ): PublicEvent {
    return {
      ...event,
      eventId: `${sessionId}-${record.nextEventSequence++}`,
      occurredAt: new Date().toISOString(),
      sessionId,
    };
  }

  #publish(record: SessionRecord, event: PublicEvent): void {
    record.events.push(event);
    if (record.events.length > 2_000) record.events.shift();
    if (
      event.type === "assistant.completed" &&
      typeof event.content === "string"
    ) {
      this.#messages.append({
        id: typeof event.turnId === "string" ? event.turnId : event.eventId,
        sessionId: event.sessionId,
        role: "assistant",
        text: event.content,
        createdAt: event.occurredAt,
      });
    }
    if (event.type === "turn.failed" && typeof event.message === "string") {
      this.#messages.append({
        id: `${typeof event.turnId === "string" ? event.turnId : event.eventId}-failed`,
        sessionId: event.sessionId,
        role: "assistant",
        text: `I couldn't finish that request: ${event.message}`,
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

  async #activate(id: string, record: SessionRecord): Promise<void> {
    if (record.handle !== undefined || record.native !== undefined) return;
    record.activating ??= this.#resume(id, record).finally(() => {
      record.activating = undefined;
    });
    await record.activating;
  }

  async #resume(id: string, record: SessionRecord): Promise<void> {
    const mcpServers = this.#resolvedMcpServers(record.preset);
    this.#validateMcpCompatibility(record.engine, mcpServers);
    const resolvedSkills = this.#resolvedSkills(record.preset);
    this.#validateSkillCompatibility(record.engine, resolvedSkills);
    if (record.engine === "harness") {
      const selection = this.#ctx.agentDefaultModel.currentSelection();
      try {
        record.handle = await this.#ctx.agents.resume({
          resumeSessionId: SessionId(record.nativeId),
          agentOptions: {
            provider: selection.provider,
            model: selection.model,
          },
          setup: async (agentContext) => {
            installModelSelection(agentContext, {
              current: selection,
              assembled: undefined,
            });
            for (const config of projectHarnessMcpServers(
              mcpServers,
              this.#workspaces.engineRoot(record.workspaceId),
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
          this.#workspaces.engineRoot(record.workspaceId),
          mcpServers,
          resolvedSkills,
        );
      }
      return;
    }
    const bridge = this.#bridges.get(record.engine);
    if (bridge === undefined) throw new Error("engine unavailable");
    record.native = await bridge.resume(
      record.nativeId,
      this.#workspaces.engineRoot(record.workspaceId),
      (event) => this.#publish(record, this.#nativeEvent(id, record, event)),
      { mcpServers },
    );
  }

  #resolvedMcpServers(binding: PresetBinding): readonly ResolvedMcpServer[] {
    const snapshot = binding.resolvedSnapshot;
    const ids =
      snapshot.resolvedMcpServers?.map((server) => server.id) ??
      snapshot.mcpServerIds;
    return ids.map((id) => {
      const server = this.#mcp.resolveServer(id);
      if (server === undefined)
        throw new Error(`invalid_mcp_binding:${id}:not_found`);
      return server;
    });
  }

  #resolvedSkills(binding: PresetBinding): readonly ResolvedSkill[] {
    return binding.resolvedSnapshot.skillIds.map((id) => {
      const skill = this.#skills.resolveSkill(id);
      if (skill === undefined)
        throw new Error(`invalid_skill_binding:${id}:not_found`);
      if (!skill.entry.enabled)
        throw new Error(`invalid_skill_binding:${id}:disabled`);
      return skill;
    });
  }

  #validateSkillCompatibility(
    engine: SessionRecord["engine"],
    skills: readonly ResolvedSkill[],
  ): void {
    if (skills.length !== 0 && engine !== "harness")
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
    this.#index.set({
      id,
      nativeId: record.nativeId,
      engine: record.engine,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      workspaceId: record.workspaceId,
      preset: record.preset,
    });
  }

  #createHarness(
    id: string,
    workspace: string,
    mcpServers: readonly ResolvedMcpServer[],
    skills: readonly ResolvedSkill[],
  ): Promise<AgentHandle> {
    const selection = this.#ctx.agentDefaultModel.currentSelection();
    return this.#ctx.agents.create({
      sessionId: SessionId(id),
      meta: { cwd: workspace },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentContext) => {
        installModelSelection(agentContext, {
          current: selection,
          assembled: undefined,
        });
        for (const config of projectHarnessMcpServers(mcpServers, workspace))
          await installMcp(agentContext, config);
        this.#installHarnessSkills(agentContext, skills);
      },
    });
  }
}
