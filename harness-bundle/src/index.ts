import { authorized, createHealthHandler } from "./runtime-http.js";
import { PersonalQuotaSettlements } from "./quota-settlement.js";
// Preserve the package entry exports for existing integrations.
export { authorized, createHealthHandler } from "./runtime-http.js";
import { join } from "node:path";
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
import { SessionTools, mountSessionTools } from "./session-tools.js";
import { InboxController } from "./inbox-api.js";
import { InboxStore } from "./inbox-store.js";
import { PlatformQuotaClient } from "./quota-client.js";
import { PlatformSharedTrashClient } from "./shared-trash-client.js";
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
  const sharedRoot = process.env.WORKAGENT_SHARED_ROOT;
  const sharedTrash = PlatformSharedTrashClient.fromEnvironment();
  const sharedFiles = sharedRoot
    ? new WorkspaceStore(
        sharedRoot,
        join(dshHome, "shared-files"),
        true,
        sharedTrash
          ? (projectId, path) =>
              sharedTrash.operate(
                { projectId, operation: "recycle", path },
                "workspace-store",
              )
          : undefined,
      )
    : undefined;
  if (sharedFiles) {
    new WorkspaceController(
      ctx,
      token,
      sharedFiles,
      () => undefined,
      "/v1/shared-workspaces",
    );
  }
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
  if (sharedFiles) runtime.setSharedFileStore(sharedFiles);
  runtime.mount();
  ctx.provide("workagentSessions", runtime.nativeSessionPort);
  ctx.provide("workagentChannels", runtime.channelService());
  const platformQuota = PlatformQuotaClient.fromEnvironment();
  const personalQuotaSettlements =
    platformQuota === undefined
      ? undefined
      : new PersonalQuotaSettlements(dshHome, platformQuota);
  if (personalQuotaSettlements) {
    ctx.effect(
      () => personalQuotaSettlements.startRecovery(),
      "personal quota recovery",
    );
  }
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
    ctx.effect(() => sharedTurnRunner.startRecovery(), "shared quota recovery");
    new SharedTurnController(ctx, token, sharedTurnRunner);
  }
  const automations = new AutomationStore(dshHome);
  const automationRunner =
    platformQuota === undefined
      ? new FailClosedAutomationRunner(runtime)
      : new QuotaAutomationRunner(
          runtime,
          presets,
          platformQuota,
          personalQuotaSettlements,
        );
  const scheduler = new AutomationScheduler(automations, automationRunner);
  new AutomationController(ctx, token, automations, scheduler);
  const teams = new TeamStore(dshHome);
  const teamRunner =
    platformQuota === undefined
      ? new FailClosedTeamRunner(runtime)
      : new QuotaTeamRunner(
          runtime,
          presets,
          platformQuota,
          personalQuotaSettlements,
        );
  const orchestrator = new TeamOrchestrator(teams, teamRunner);
  new TeamController(ctx, token, teams, orchestrator, runtime);
  mountSessionTools(
    ctx,
    token,
    new SessionTools(
      runtime,
      automations,
      scheduler,
      teams,
      orchestrator,
      presets,
    ),
  );
  runtime.setTeamInputHandler((sessionId, input) => {
    const context = teams.contextForSession(sessionId);
    if (!context) return false;
    teams.operation(`user:${sessionId}:${input.messageId}`, input, () =>
      teams.startRun(context.team.id, input.content, context.member.id),
    );
    void orchestrator.tick();
    return true;
  });
  const inbox = new InboxStore(dshHome);
  new InboxController(ctx, token, inbox, runtime);
  runtime.setActivityProvider(() => {
    const definitions = automations.list();
    return {
      active:
        inbox.hasProcessing() ||
        definitions.some((definition) =>
          automations
            .history(definition.id)
            .some(
              (run) => run.status === "pending" || run.status === "running",
            ),
        ) ||
        teams.hasActiveWork(),
      nextWakeAt:
        [automations.nextWakeAt(), teams.nextWakeAt()]
          .filter((value): value is string => value !== null)
          .sort()[0] ?? null,
    };
  });
  new WorkspaceController(ctx, token, workspaces, (sessionId) =>
    runtime.workspaceForSession(sessionId),
  );
}
