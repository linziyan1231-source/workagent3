import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import {
  installModelSelection,
  type AgentHandle,
} from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
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

type SessionRecord = {
  createdAt: string;
  engine: "harness" | "codex" | "kimi";
  events: PublicEvent[];
  handle: AgentHandle | undefined;
  native: BridgeSession | undefined;
  nextEventSequence: number;
  title: string;
  updatedAt: string;
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
      return undefined;
    default:
      return undefined;
  }
};

export class RuntimeController {
  readonly #ctx: Context;
  readonly #token: string;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #subscribers = new Map<string, Set<ServerResponse>>();
  readonly #bridges = new Map<"codex" | "kimi", EngineBridge>();

  constructor(ctx: Context, token: string) {
    this.#ctx = ctx;
    this.#token = token;
    this.#bridges.set("codex", new CodexBridge());
    this.#bridges.set("kimi", new KimiBridge());
  }

  mount(): void {
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
        })),
      );
      return;
    }
    if (path === "/v1/sessions" && request.method === "POST") {
      await this.#create(request, response);
      return;
    }
    const match = /^\/v1\/sessions\/([^/]+)\/(turns|cancel|events)$/.exec(path);
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
    if (match[2] === "turns" && request.method === "POST") {
      const input = await readJson(request);
      if (typeof input.content !== "string" || input.content.trim() === "") {
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
      writeJson(response, 202, { accepted: true });
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
      input.title.length > 200
    ) {
      writeJson(response, 400, { error: "invalid_session" });
      return;
    }
    const publicId = `session-${randomUUID()}`;
    const now = new Date().toISOString();
    const record: SessionRecord = {
      engine: input.engine,
      events: [],
      handle: undefined,
      native: undefined,
      nextEventSequence: 1,
      title: input.title.trim(),
      createdAt: now,
      updatedAt: now,
    };
    try {
      if (input.engine === "harness") {
        const sessionId = SessionId(publicId);
        const selection = this.#ctx.agentDefaultModel.currentSelection();
        record.handle = await this.#ctx.agents.create({
          sessionId,
          meta: { cwd: process.cwd() },
          agentOptions: {
            provider: selection.provider,
            model: selection.model,
          },
          setup: (agentContext) => {
            installModelSelection(agentContext, {
              current: selection,
              assembled: undefined,
            });
          },
        });
      } else {
        const bridge = this.#bridges.get(input.engine);
        if (bridge === undefined) {
          writeJson(response, 503, { error: "engine_unavailable" });
          return;
        }
        record.native = await bridge.create(process.cwd(), (event) => {
          this.#publish(record, this.#nativeEvent(publicId, record, event));
        });
      }
    } catch {
      writeJson(response, 503, { error: "engine_start_failed" });
      return;
    }
    this.#sessions.set(publicId, record);
    writeJson(response, 201, {
      id: publicId,
      engine: input.engine,
      title: input.title.trim(),
      createdAt: now,
      updatedAt: now,
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
    for (const response of this.#subscribers.get(event.sessionId) ?? []) {
      response.write(
        `id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    }
  }
}
