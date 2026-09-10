import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import type {} from "@deepseek-ai/dsh-host-webserver";
import type {} from "@deepseek-ai/dsh-web-app";
import type {} from "@deepseek-ai/dsh-session";
import { RuntimeController } from "./runtime.js";
import type {} from "./native-session-persistence.js";
import { WorkspaceController } from "./workspace-api.js";
import { ENGINE_CAPABILITIES } from "./engine-registry.js";
import { WorkspaceStore } from "./workspace-store.js";
import { RUNTIME_MODULES } from "./module-manifests.js";
import {
  CredentialStatusStore,
  ModelAccessStore,
} from "./model-access-store.js";
import { PresetStore } from "./preset-store.js";
import { RuntimeServicesController } from "./runtime-services-api.js";
import { McpCatalogStore, SkillCatalogStore } from "./capability-store.js";
import { AutomationController } from "./automation-api.js";
import { AutomationScheduler, AutomationStore } from "./automation-store.js";
import { TeamController } from "./team-api.js";
import { TeamOrchestrator, TeamStore } from "./team-store.js";
import { InboxController } from "./inbox-api.js";
import { InboxStore } from "./inbox-store.js";
import { PlatformQuotaClient } from "./quota-client.js";
import {
  FailClosedAutomationRunner,
  FailClosedSharedTurnRunner,
  FailClosedTeamRunner,
  QuotaAutomationRunner,
  QuotaSharedTurnRunner,
  QuotaTeamRunner,
  SharedTurnQuotaJournal,
} from "./quota-runner.js";
import { SharedTurnController } from "./shared-turn-api.js";
import { createManagedProviderCredentialHandler } from "./provider-credential-api.js";
import { createManagedProviderHealthHandler } from "./provider-health-api.js";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "workagent-runtime-api";
export const inject = [
  "agentDefaultModel",
  "agents",
  "approval",
  "credentials",
  "llm",
  "sessions",
  "webServer",
  "workagentNativeLog",
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
  const dshHome = process.env.DSH_HOME;
  const workspaceRoot = process.env.WORKAGENT_WORKSPACE_ROOT;
  if (dshHome === undefined || workspaceRoot === undefined) {
    throw new Error("workagent-runtime-api: private roots are required");
  }
  const workspaces = new WorkspaceStore(workspaceRoot, dshHome);
  const models = new ModelAccessStore(dshHome);
  const skills = new SkillCatalogStore();
  const mcp = new McpCatalogStore();
  const presets = new PresetStore(dshHome, models, skills, mcp);
  const credentials = new CredentialStatusStore(dshHome);
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
        path: "/internal/providers/deepseek-official/test",
        handler: createManagedProviderHealthHandler(token, async (signal) => {
          const selection = ctx.agentDefaultModel.currentSelection();
          for await (const chunk of ctx.llm.stream({
            provider: selection.provider,
            model: selection.model,
            messages: [
              createUserMessage({
                content: [{ type: "text", text: "Reply OK." }],
                source: { kind: "user" },
              }),
            ],
            maxTokens: 1,
            signal,
          })) {
            if (chunk.type !== "finish") continue;
            if (
              chunk.reason.kind === "error" ||
              chunk.reason.kind === "aborted"
            ) {
              models.setProviderHealth("harness", "unavailable");
              return {
                status: "unhealthy" as const,
                message: `provider_${chunk.reason.failure.code.toLowerCase()}`,
              };
            }
            models.setProviderHealth("harness", "healthy");
            return {
              status: "healthy" as const,
              message: "provider_request_succeeded",
            };
          }
          models.setProviderHealth("harness", "unavailable");
          return {
            status: "unhealthy" as const,
            message: "provider_stream_incomplete",
          };
        }),
      }),
    "workagent-runtime-api: managed Provider health route",
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
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/internal/provider-credentials/deepseek-official",
        handler: createManagedProviderCredentialHandler(token, ctx.credentials),
      }),
    "workagent-runtime-api: managed Provider credential route",
  );
  new RuntimeServicesController(
    ctx,
    token,
    models,
    credentials,
    presets,
    skills,
    mcp,
  );
  const runtime = new RuntimeController(
    ctx,
    token,
    workspaces,
    presets,
    mcp,
    skills,
    credentials,
    undefined,
    ctx.workagentNativeLog,
  );
  runtime.mount();
  ctx.provide("workagentSessions", runtime.nativeSessionPort);
  ctx.provide("workagentChannels", runtime.channelService());
  const platformQuota = PlatformQuotaClient.fromEnvironment();
  // Fail-closed run entries: without the platform quota channel no run can be
  // reserved or settled, so automation, team, and shared runs refuse to start
  // instead of running unbilled.
  if (platformQuota === undefined) {
    console.error(
      "workagent-runtime-api: platform quota is not configured; automation, team, and shared AI runs are disabled",
    );
    new SharedTurnController(
      ctx,
      token,
      new FailClosedSharedTurnRunner(runtime),
    );
  } else {
    const sharedTurnRunner = new QuotaSharedTurnRunner(
      runtime,
      platformQuota,
      new SharedTurnQuotaJournal(dshHome),
    );
    void sharedTurnRunner.reconcileInterrupted().catch(() => undefined);
    new SharedTurnController(ctx, token, sharedTurnRunner);
  }
  const automations = new AutomationStore(dshHome);
  const automationRunner =
    platformQuota === undefined
      ? new FailClosedAutomationRunner(runtime)
      : new QuotaAutomationRunner(runtime, presets, platformQuota);
  new AutomationController(
    ctx,
    token,
    automations,
    new AutomationScheduler(automations, automationRunner),
  );
  const teams = new TeamStore(dshHome);
  const teamRunner =
    platformQuota === undefined
      ? new FailClosedTeamRunner(runtime)
      : new QuotaTeamRunner(runtime, presets, platformQuota);
  new TeamController(
    ctx,
    token,
    teams,
    new TeamOrchestrator(teams, teamRunner),
    runtime,
  );
  const inbox = new InboxStore(dshHome);
  new InboxController(ctx, token, inbox, runtime);
  runtime.setActivityProvider(() => {
    const definitions=automations.list();
    return { active: inbox.hasProcessing() || definitions.some((definition)=>automations.history(definition.id).some((run)=>run.status==="pending"||run.status==="running")) || teams.list().some((team)=>teams.tasks(team.id).some((task)=>task.status==="queued"||task.status==="running")), nextWakeAt: definitions.filter((definition)=>definition.enabled&&definition.nextRunAt).map((definition)=>definition.nextRunAt!).sort()[0] ?? null };
  });
  new WorkspaceController(ctx, token, workspaces, (sessionId) =>
    runtime.workspaceForSession(sessionId),
  );
}
