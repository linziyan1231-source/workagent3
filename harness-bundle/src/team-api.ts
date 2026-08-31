import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { engineIdSchema, teamCreateSchema } from "@workagent/contracts";
import { authorized } from "./index.js";
import { TeamOrchestrator, TeamStore } from "./team-store.js";

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

export const createTeamHandler =
  (token: string, store: TeamStore, orchestrator: TeamOrchestrator) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!authorized(request, token))
      return json(response, 401, { error: "authentication_required" });
    try {
      const url = new URL(request.url ?? "/", "http://runtime");
      const path = url.pathname;
      if (path === "/v1/teams") {
        if (request.method === "GET") return json(response, 200, store.list());
        if (request.method === "POST")
          return json(
            response,
            201,
            store.create(teamCreateSchema.parse(await body(request))),
          );
        return method(response, "GET, POST");
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
          return json(
            response,
            200,
            store.rename(
              teamId,
              Number(input.version),
              text(input.name, "name"),
            ),
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
          return json(
            response,
            201,
            store.addMember(teamId, {
              name: text(input.name, "name"),
              engine: engineIdSchema.parse(input.engine),
              presetId: text(input.presetId, "preset"),
            }),
          );
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
        if (!request.headers.accept?.includes("text/event-stream"))
          return json(response, 200, store.events(teamId, after));
        response.writeHead(200, {
          "cache-control": "no-store",
          connection: "keep-alive",
          "content-type": "text/event-stream",
        });
        let sequence = Number.isSafeInteger(after) && after >= 0 ? after : 0;
        const publish = () => {
          for (const event of store.events(teamId, sequence)) {
            sequence = event.sequence;
            response.write(
              `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );
          }
        };
        publish();
        const timer = setInterval(publish, 250);
        timer.unref();
        request.once("close", () => clearInterval(timer));
        return;
      }
      return method(response, "GET");
    } catch (error) {
      const code = error instanceof Error ? error.message : "invalid_request";
      const status = code.endsWith("_not_found")
        ? 404
        : code.includes("conflict") ||
            code.includes("busy") ||
            code.includes("cancellable") ||
            code.includes("active") ||
            code.includes("cannot")
          ? 409
          : code === "request_too_large"
            ? 413
            : 400;
      json(response, status, {
        error: code.startsWith("team_") ? code : "invalid_request",
      });
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
  ) {
    const handler = createTeamHandler(token, store, orchestrator);
    ctx.effect(
      () =>
        ctx.webServer.register({ kind: "prefix", path: "/v1/teams", handler }),
      "workagent-ai-team: routes",
    );
  }
}
