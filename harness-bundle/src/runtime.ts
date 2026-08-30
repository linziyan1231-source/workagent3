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
import { authorized } from "./index.js";

type SessionRecord = {
  createdAt: string;
  handle: AgentHandle;
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

  constructor(ctx: Context, token: string) {
    this.#ctx = ctx;
    this.#token = token;
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
          for (const response of this.#subscribers.get(String(session.id)) ??
            []) {
            response.write(
              `id: ${normalized.eventId}\ndata: ${JSON.stringify(normalized)}\n\n`,
            );
          }
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
          engine: "harness",
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
      record.handle.agent.followup(
        createUserMessage({
          content: [{ type: "text", text: input.content }],
          source: { kind: "user" },
        }),
      );
      writeJson(response, 202, { accepted: true });
      return;
    }
    if (match[2] === "cancel" && request.method === "POST") {
      record.handle.agent.cancel({ kind: "user" });
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
      input.engine !== "harness" ||
      typeof input.title !== "string" ||
      input.title.trim() === ""
    ) {
      writeJson(response, 400, { error: "invalid_session" });
      return;
    }
    const sessionId = SessionId(`session-${randomUUID()}`);
    const selection = this.#ctx.agentDefaultModel.currentSelection();
    const handle = await this.#ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentContext) => {
        installModelSelection(agentContext, {
          current: selection,
          assembled: undefined,
        });
      },
    });
    const now = new Date().toISOString();
    this.#sessions.set(String(sessionId), {
      handle,
      title: input.title.trim(),
      createdAt: now,
      updatedAt: now,
    });
    writeJson(response, 201, {
      id: String(sessionId),
      engine: "harness",
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
    const normalizedEvents = record.handle.agent.session.events.flatMap(
      (event) => {
        const normalized = normalizeEvent(record.handle.agent.session, event);
        return normalized === undefined ? [] : [normalized];
      },
    );
    const lastEventId = request.headers["last-event-id"];
    for (const normalized of eventsAfterLastId(
      normalizedEvents,
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
}
