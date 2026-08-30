import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { automationMutationSchema } from "@workagent/contracts";
import { authorized } from "./index.js";
import { AutomationScheduler, AutomationStore } from "./automation-store.js";

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

const body = async (request: IncomingMessage): Promise<unknown> => {
  let value = "";
  for await (const chunk of request) {
    value += String(chunk);
    if (value.length > 64 * 1024) throw new Error("request_too_large");
  }
  return JSON.parse(value);
};

const errorResponse = (response: ServerResponse, error: unknown): void => {
  const code = error instanceof Error ? error.message : "invalid_request";
  if (code === "automation_not_found" || code === "automation_run_not_found")
    return json(response, 404, { error: code });
  if (code === "automation_version_conflict")
    return json(response, 409, { error: code });
  if (code === "automation_has_active_run")
    return json(response, 409, { error: code });
  if (code === "request_too_large") return json(response, 413, { error: code });
  if (
    code === "automation_run_not_cancellable" ||
    code === "automation_run_not_pending" ||
    code === "automation_run_not_running"
  )
    return json(response, 409, { error: code });
  json(response, 400, { error: "invalid_request" });
};

export const createAutomationHandler =
  (token: string, store: AutomationStore, scheduler: AutomationScheduler) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!authorized(request, token)) {
      json(response, 401, { error: "authentication_required" });
      return;
    }
    try {
      const path = new URL(request.url ?? "/", "http://runtime").pathname;
      if (path === "/v1/automations") {
        if (request.method === "GET") return json(response, 200, store.list());
        if (request.method === "POST")
          return json(
            response,
            201,
            store.create(automationMutationSchema.parse(await body(request))),
          );
        response.writeHead(405, { allow: "GET, POST" });
        response.end();
        return;
      }
      const match =
        /^\/v1\/automations\/([^/]+)(?:\/(run|runs)(?:\/([^/]+)\/cancel)?)?$/.exec(
          path,
        );
      if (match === null) return json(response, 404, { error: "not_found" });
      const id = decodeURIComponent(match[1] ?? "");
      const action = match[2];
      if (action === "run" && request.method === "POST") {
        const run = store.runNow(id);
        void scheduler.tick();
        return json(response, 202, run);
      }
      if (
        action === "runs" &&
        match[3] === undefined &&
        request.method === "GET"
      )
        return json(response, 200, store.history(id));
      if (
        action === "runs" &&
        match[3] !== undefined &&
        request.method === "POST"
      )
        return json(
          response,
          200,
          await scheduler.cancel(id, decodeURIComponent(match[3])),
        );
      if (action !== undefined)
        return json(response, 405, { error: "method_not_allowed" });
      if (request.method === "GET") {
        const value = store.get(id);
        return value === undefined
          ? json(response, 404, { error: "automation_not_found" })
          : json(response, 200, value);
      }
      if (request.method === "PATCH") {
        const input = await body(request);
        if (input === null || typeof input !== "object" || Array.isArray(input))
          throw new Error("invalid_request");
        const { version, ...mutation } = input as Record<string, unknown>;
        if (!Number.isInteger(version)) throw new Error("invalid_request");
        return json(
          response,
          200,
          store.update(id, version as number, mutation),
        );
      }
      if (request.method === "DELETE") {
        store.delete(id);
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(405, { allow: "GET, PATCH, DELETE" });
      response.end();
    } catch (error) {
      errorResponse(response, error);
    }
  };

export class AutomationController {
  constructor(
    ctx: Context,
    token: string,
    store: AutomationStore,
    scheduler: AutomationScheduler,
  ) {
    const handler = createAutomationHandler(token, store, scheduler);
    ctx.effect(() => {
      const unregister = ctx.webServer.register({
        kind: "prefix",
        path: "/v1/automations",
        handler,
      });
      scheduler.start();
      return () => {
        scheduler.stop();
        unregister();
      };
    }, "workagent-automation: routes and scheduler");
  }
}
