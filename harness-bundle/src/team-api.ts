import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  engineIdSchema,
  teamCreateSchema,
  type TeamEvent,
} from "@workagent/contracts";
import { authorized } from "./runtime-http.js";
import {
  TeamOrchestrator,
  type TeamSessionPort,
  TeamStore,
} from "./team-store.js";

const json = (
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
const body = async (
  request: IncomingMessage,
): Promise<Record<string, unknown>> => {
  let value = "";
  for await (const chunk of request) {
    value += String(chunk);
    if (value.length > 64 * 1024) throw new Error("request_too_large");
  }
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid_request");
  return parsed as Record<string, unknown>;
};
const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`invalid_${name}`);
  return value;
};

const streamEvents = (
  request: IncomingMessage,
  response: ServerResponse,
  collect: (after: number) => TeamEvent[],
  after: number,
  signal?: AbortSignal,
): void => {
  response.writeHead(200, {
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  let sequence = after;
  const timer = setInterval(publish, 250);
  timer.unref();
  const close = () => {
    clearInterval(timer);
    request.removeListener("close", close);
    signal?.removeEventListener("abort", close);
    response.end();
  };
  request.once("close", close);
  signal?.addEventListener("abort", close, { once: true });
  if (signal?.aborted) return close();
  function publish(): void {
    let events: TeamEvent[];
    try {
      events = collect(sequence);
    } catch {
      close();
      return;
    }
    for (const event of events) {
      sequence = event.sequence;
      response.write(
        `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      );
    }
  }
  publish();
};

export const createTeamHandler =
  (
    token: string,
    store: TeamStore,
    orchestrator: TeamOrchestrator,
    sessions: TeamSessionPort,
    signal?: AbortSignal,
  ) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!authorized(request, token))
      return json(response, 401, { error: "authentication_required" });
    try {
      const url = new URL(request.url ?? "/", "http://runtime");
      const path = url.pathname;
      if (path === "/v1/teams") {
        if (request.method === "GET") return json(response, 200, store.list());
        if (request.method === "POST") {
          const input = teamCreateSchema.parse(await body(request));
          const team = store.create(input);
          const lead = team.members[0]!;
          try {
            await sessions.openTeamSession({
              sessionId: lead.sessionId!,
              title: `${team.name} · ${lead.name}`,
              engine: lead.engine,
              presetId: lead.presetId,
              workspaceId: team.workspaceId,
              ...(input.lead.modelId === undefined
                ? {}
                : { modelId: input.lead.modelId }),
              ...(input.lead.thinkingEffort === undefined
                ? {}
                : { thinkingEffort: input.lead.thinkingEffort }),
              ...(input.lead.permissionMode === undefined
                ? {}
                : { permissionMode: input.lead.permissionMode }),
            });
          } catch (error) {
            store.delete(team.id);
            throw error;
          }
          return json(response, 201, team);
        }
        return method(response, "GET, POST");
      }
      if (path === "/v1/teams/events") {
        if (request.method !== "GET") return method(response, "GET");
        const after = Number(
          url.searchParams.get("after") ??
            request.headers["last-event-id"] ??
            "0",
        );
        const since = Number.isSafeInteger(after) && after >= 0 ? after : 0;
        if (!request.headers.accept?.includes("text/event-stream"))
          return json(response, 200, store.allEvents(since));
        streamEvents(
          request,
          response,
          store.allEvents.bind(store),
          since,
          signal,
        );
        return;
      }
      const match =
        /^\/v1\/teams\/([^/]+)(?:\/(members|tasks|messages|events)(?:\/([^/]+)(?:\/(cancel))?)?)?$/.exec(
          path,
        );
      if (match === null) return json(response, 404, { error: "not_found" });
      const teamId = decodeURIComponent(match[1] ?? "");
      const resource = match[2];
      const childId =
        match[3] === undefined ? undefined : decodeURIComponent(match[3]);
      if (resource === undefined) {
        if (request.method === "GET") {
          const team = store.get(teamId);
          return team === undefined
            ? json(response, 404, { error: "team_not_found" })
            : json(response, 200, team);
        }
        if (request.method === "PATCH") {
          const input = await body(request);
          const mutation: {
            name?: string;
            sessionMode?: string | null;
            memberIds?: string[];
          } = {};
          if (input.memberIds !== undefined) {
            if (
              !Array.isArray(input.memberIds) ||
              input.memberIds.some((value) => typeof value !== "string")
            )
              throw new Error("invalid_member_order");
            mutation.memberIds = input.memberIds as string[];
          }
          if (input.name !== undefined)
            mutation.name = text(input.name, "name");
          if (input.sessionMode !== undefined)
            mutation.sessionMode =
              input.sessionMode === null
                ? null
                : text(input.sessionMode, "session_mode");
          return json(
            response,
            200,
            store.update(teamId, Number(input.version), mutation),
          );
        }
        if (request.method === "DELETE") {
          store.delete(teamId);
          response.writeHead(204);
          response.end();
          return;
        }
        return method(response, "GET, PATCH, DELETE");
      }
      if (resource === "members") {
        if (childId === undefined && request.method === "POST") {
          const input = await body(request);
          const team = store.addMember(teamId, {
            name: text(input.name, "name"),
            engine: engineIdSchema.parse(input.engine),
            presetId: text(input.presetId, "preset"),
          });
          const member = team.members[team.members.length - 1]!;
          try {
            await sessions.openTeamSession({
              sessionId: member.sessionId!,
              title: `${team.name} · ${member.name}`,
              engine: member.engine,
              presetId: member.presetId,
              workspaceId: team.workspaceId,
            });
          } catch (error) {
            store.removeMember(teamId, member.id);
            throw error;
          }
          return json(response, 201, team);
        }
        if (childId !== undefined && request.method === "PATCH") {
          const input = await body(request);
          const mutation: {
            name?: string;
            engine?: "harness" | "codex" | "kimi";
            presetId?: string;
          } = {};
          if (input.name !== undefined)
            mutation.name = text(input.name, "name");
          if (input.engine !== undefined)
            mutation.engine = engineIdSchema.parse(input.engine);
          if (input.presetId !== undefined)
            mutation.presetId = text(input.presetId, "preset");
          return json(
            response,
            200,
            store.updateMember(teamId, childId, mutation),
          );
        }
        if (childId !== undefined && request.method === "DELETE")
          return json(response, 200, store.removeMember(teamId, childId));
        return method(
          response,
          childId === undefined ? "POST" : "PATCH, DELETE",
        );
      }
      if (resource === "tasks") {
        if (childId === undefined && request.method === "GET")
          return json(response, 200, store.tasks(teamId));
        if (childId === undefined && request.method === "POST") {
          const input = await body(request);
          const task = store.queueTask(teamId, {
            memberId: text(input.memberId, "member"),
            title: text(input.title, "title"),
            input: text(input.input, "input"),
          });
          void orchestrator.tick();
          return json(response, 202, task);
        }
        if (
          childId !== undefined &&
          match[4] === "cancel" &&
          request.method === "POST"
        )
          return json(
            response,
            200,
            await orchestrator.cancel(teamId, childId),
          );
        return method(response, childId === undefined ? "GET, POST" : "POST");
      }
      if (resource === "messages") {
        if (childId === undefined && request.method === "GET")
          return json(
            response,
            200,
            store.messages(
              teamId,
              url.searchParams.get("memberId") ?? undefined,
            ),
          );
        if (childId === undefined && request.method === "POST") {
          const input = await body(request);
          return json(
            response,
            201,
            store.sendMessage(teamId, {
              fromMemberId:
                input.fromMemberId === null
                  ? null
                  : text(input.fromMemberId, "from_member"),
              toMemberId:
                input.toMemberId === null || input.toMemberId === undefined
                  ? null
                  : text(input.toMemberId, "to_member"),
              body: text(input.body, "body"),
            }),
          );
        }
        return method(response, "GET, POST");
      }
      if (
        resource === "events" &&
        childId === undefined &&
        request.method === "GET"
      ) {
        const after = Number(
          url.searchParams.get("after") ??
            request.headers["last-event-id"] ??
            "0",
        );
        const since = Number.isSafeInteger(after) && after >= 0 ? after : 0;
        if (!request.headers.accept?.includes("text/event-stream"))
          return json(response, 200, store.events(teamId, since));
        streamEvents(
          request,
          response,
          (sequence) => store.events(teamId, sequence),
          since,
          signal,
        );
        return;
      }
      return method(response, "GET");
    } catch (error) {
      // Validation failures keep the stable client-facing code; every other
      // failure propagates its real code/message so the actual cause (for
      // example an engine that failed to start) is visible upstream.
      const code =
        error instanceof Error &&
        !(error instanceof SyntaxError) &&
        error.name !== "ZodError"
          ? error.message
          : "invalid_request";
      const status = code.endsWith("_not_found")
        ? 404
        : code.includes("conflict") ||
            code.includes("busy") ||
            code.includes("cancellable") ||
            code.includes("active") ||
            code.includes("cannot") ||
            code.startsWith("credential_needs_auth:")
          ? 409
          : code === "request_too_large"
            ? 413
            : code.startsWith("engine_")
              ? 503
              : 400;
      if (status >= 500)
        console.error("workagent-team-api: request failed", error);
      json(response, status, { error: code });
    }
  };
const method = (response: ServerResponse, allow: string): void => {
  response.writeHead(405, { allow });
  response.end();
};

export class TeamController {
  constructor(
    ctx: Context,
    token: string,
    store: TeamStore,
    orchestrator: TeamOrchestrator,
    sessions: TeamSessionPort,
  ) {
    ctx.effect(() => {
      const controller = new AbortController();
      const handler = createTeamHandler(
        token,
        store,
        orchestrator,
        sessions,
        controller.signal,
      );
      const unregister = ctx.webServer.register({
        kind: "prefix",
        path: "/v1/teams",
        handler,
      });
      orchestrator.start();
      return async () => {
        unregister();
        controller.abort();
        await orchestrator.stop();
      };
    }, "workagent-ai-team: routes and scheduler");
  }
}
