import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-session";
import { RuntimeController } from "./runtime.js";
import { WorkspaceController } from "./workspace-api.js";
import { ENGINE_CAPABILITIES } from "./engine-registry.js";
import { WorkspaceStore } from "./workspace-store.js";
import { RUNTIME_MODULES } from "./module-manifests.js";

export const name = "workagent-runtime-api";
export const inject = [
  "agentDefaultModel",
  "agents",
  "approval",
  "sessions",
  "webServer",
];

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

export const authorized = (
  request: IncomingMessage,
  expectedToken: string,
): boolean => {
  const provided = request.headers.authorization;
  if (provided === undefined || !provided.startsWith("Bearer ")) return false;
  const actual = Buffer.from(provided.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const createHealthHandler =
  (token: string) =>
  (request: IncomingMessage, response: ServerResponse): void => {
    if (!authorized(request, token)) {
      json(response, 401, { error: "authentication_required" });
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return;
    }
    json(response, 200, { status: "healthy" });
  };

export function apply(ctx: Context): void {
  const token = process.env.WORKAGENT_RUNTIME_TOKEN;
  if (token === undefined || token.length < 22) {
    throw new Error(
      "workagent-runtime-api: WORKAGENT_RUNTIME_TOKEN is required",
    );
  }
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/health",
        handler: createHealthHandler(token),
      }),
    "workagent-runtime-api: health route",
  );
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/v1/capabilities",
        handler: (request, response) => {
          if (!authorized(request, token)) {
            json(response, 401, { error: "authentication_required" });
            return;
          }
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          json(response, 200, {
            engines: ENGINE_CAPABILITIES,
            modules: RUNTIME_MODULES,
          });
        },
      }),
    "workagent-runtime-api: capability route",
  );
  const dshHome = process.env.DSH_HOME;
  const workspaceRoot = process.env.WORKAGENT_WORKSPACE_ROOT;
  if (dshHome === undefined || workspaceRoot === undefined) {
    throw new Error("workagent-runtime-api: private roots are required");
  }
  const workspaces = new WorkspaceStore(workspaceRoot, dshHome);
  const runtime = new RuntimeController(ctx, token, workspaces);
  runtime.mount();
  new WorkspaceController(ctx, token, workspaces, (sessionId) =>
    runtime.workspaceForSession(sessionId),
  );
}
