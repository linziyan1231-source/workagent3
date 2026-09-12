import type { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
import { automationScheduleSchema, type EngineId } from "@workagent/contracts";
import { authorized } from "./runtime-http.js";
import { AutomationStore, AutomationScheduler } from "./automation-store.js";
import { TeamStore, TeamOrchestrator } from "./team-store.js";
import type { PresetStore } from "./preset-store.js";

export type SessionToolContext = {
  sessionId: string;
  engine: EngineId;
  acpCatalogId?: string;
  presetId: string;
  workspaceId: string;
};
export interface SessionToolPort {
  validateToolScope(sessionId: string, scopeToken: string): boolean;
  sessionToolContext(sessionId: string): SessionToolContext;
}
const text = z.string().trim().min(1).max(65536);
const write = { operationId: z.string().regex(/^[A-Za-z0-9_:@.-]{1,160}$/) };
const schemas = {
  automation_list: z.object({}),
  automation_get: z.object({ id: text }),
  automation_create: z.object({
    ...write,
    name: text.max(200),
    input: text,
    schedule: automationScheduleSchema,
    executionMode: z
      .enum(["new_conversation", "existing"])
      .default("new_conversation"),
    notificationPolicy: z
      .enum(["none", "on_failure", "always"])
      .default("always"),
    presetId: text.optional(),
    workspaceId: text.optional(),
  }),
  automation_update: z.object({
    ...write,
    id: text,
    expectedVersion: z.number().int().positive(),
    name: text.max(200).optional(),
    input: text.optional(),
    schedule: automationScheduleSchema.optional(),
    enabled: z.boolean().optional(),
    notificationPolicy: z.enum(["none", "on_failure", "always"]).optional(),
  }),
  team_members: z.object({}),
  team_list_assistants: z.object({}),
  team_spawn_agent: z.object({ ...write, name: text.max(120), presetId: text }),
  team_send_message: z.object({
    ...write,
    toMemberId: text.nullable().default(null),
    body: text,
  }),
  team_task_list: z.object({}),
  team_task_create: z.object({
    ...write,
    memberId: text,
    title: text.max(200),
    input: text,
    dependsOnIds: z.array(text).default([]),
  }),
  team_task_update: z.object({
    ...write,
    taskId: text,
    expectedVersion: z.number().int().positive(),
    title: text.max(200).optional(),
    input: text.optional(),
    dependsOnIds: z.array(text).optional(),
    status: z.enum(["succeeded", "failed"]).optional(),
    result: text.optional(),
  }),
  team_rename: z.object({ ...write, name: text.max(120) }),
  team_shutdown: z.object({ ...write }),
};
const descriptions: Record<keyof typeof schemas, string> = {
  automation_list: "查看当前员工的定时任务、版本与下次时间。",
  automation_get: "查看一个定时任务及执行历史。",
  automation_create:
    "按用户要求创建定时任务。时间必须明确，once.at带时区；existing继续当前对话，默认每次新对话。相同请求重试复用operationId。",
  automation_update:
    "修改或启停定时任务。先查询版本，expectedVersion必须匹配；只传要修改的字段。重复调用复用operationId。",
  team_members: "查询本团队成员、当前运行、剩余预算和当前成员身份。",
  team_list_assistants:
    "查询已启用的助手目录。招募必须选择实际目录中的presetId。",
  team_spawn_agent:
    "仅组长可按任务需要招募持久成员。返回成员ID后创建任务或发送消息才能让其执行。",
  team_send_message:
    "给团队成员发送工作消息并自动唤醒；成员忙时排队。toMemberId为null表示广播。避免无新内容的互相确认。",
  team_task_list: "查看本团队任务及依赖、结果、版本。",
  team_task_create:
    "创建并自动分派任务，可指定同团队依赖；依赖全部成功后执行。",
  team_task_update:
    "更新自己任务或由组长更新任务；先读取版本。运行后的输入与依赖不可改。",
  team_rename: "组长修改本团队名称。",
  team_shutdown:
    "仅组长可暂停本轮团队后续调度，等待用户继续。已发送的成员回合允许结束，文件及外部操作不会自动回滚。返回后向用户汇报。",
};

export class SessionTools {
  constructor(
    readonly runtime: SessionToolPort,
    readonly automations: AutomationStore,
    readonly scheduler: AutomationScheduler,
    readonly teams: TeamStore,
    readonly orchestrator: TeamOrchestrator,
    readonly presets: PresetStore,
  ) {}

  async handle(input: {
    sessionId: string;
    scopeToken: string;
    method: string;
    name?: string;
    arguments?: unknown;
  }): Promise<unknown> {
    if (!this.runtime.validateToolScope(input.sessionId, input.scopeToken))
      throw new Error("session_scope_expired");
    const teamContext = this.teams.contextForSession(input.sessionId);
    if (input.method === "tools/list")
      return {
        tools: Object.entries(schemas)
          .filter(([name]) => teamContext || name.startsWith("automation_"))
          .map(([name, schema]) => ({
            name,
            description: descriptions[name as keyof typeof schemas],
            inputSchema: z.toJSONSchema(schema),
            annotations: {
              readOnlyHint: !Object.hasOwn(schema.shape, "operationId"),
            },
          })),
      };
    if (
      input.method !== "tools/call" ||
      !input.name ||
      !Object.hasOwn(schemas, input.name)
    )
      throw new Error("unknown_session_tool");
    const name = input.name as keyof typeof schemas;
    const args = schemas[name].parse(input.arguments ?? {}) as Record<
      string,
      unknown
    >;
    const context = this.runtime.sessionToolContext(input.sessionId);
    if (name === "automation_list") return this.automations.list();
    if (name === "automation_get")
      return {
        definition: this.automations.get(String(args.id)),
        runs: this.automations.history(String(args.id)),
      };
    if (name.startsWith("automation_")) {
      const result = this.automations.operation(
        `${context.sessionId}:${args.operationId}`,
        { name, args },
        () => {
          if (name === "automation_create") {
            const preset = this.presets.resolve(
              String(args.presetId ?? context.presetId),
            ).resolvedSnapshot;
            if (!preset.enabled) throw new Error("preset_disabled");
            if (
              args.executionMode === "existing" &&
              (preset.id !== context.presetId ||
                (args.workspaceId && args.workspaceId !== context.workspaceId))
            )
              throw new Error("automation_existing_context_mismatch");
            return this.automations.create({
              name: String(args.name),
              input: String(args.input),
              enabled: true,
              schedule: automationScheduleSchema.parse(args.schedule),
              presetId: preset.id,
              engine: preset.engine,
              acpCatalogId: preset.acpCatalogId,
              workspaceId: String(args.workspaceId ?? context.workspaceId),
              executionMode: args.executionMode as
                | "existing"
                | "new_conversation",
              conversationId:
                args.executionMode === "existing" ? context.sessionId : null,
              notificationPolicy: args.notificationPolicy as
                | "always"
                | "none"
                | "on_failure",
            });
          }
          const {
            id,
            expectedVersion,
            operationId: _operationId,
            ...mutation
          } = args;
          return this.automations.update(
            String(id),
            Number(expectedVersion),
            mutation,
          );
        },
      );
      void this.scheduler.tick();
      return result;
    }
    if (!teamContext) throw new Error("team_session_required");
    const { team, member, dispatch, run } = teamContext;
    if (name === "team_members")
      return {
        team,
        currentMemberId: member.id,
        run,
        limits: {
          maxDispatches: 64,
          maxDepth: 8,
          maxFanout: 4,
          maxConcurrent: 4,
          maxRecruited: 8,
        },
      };
    if (name === "team_task_list") return this.teams.tasks(team.id);
    if (name === "team_list_assistants")
      return this.presets
        .list()
        .filter((preset) => preset.enabled)
        .map(({ id, name, description, engine, acpCatalogId }) => ({
          id,
          name,
          description,
          engine,
          acpCatalogId,
        }));
    if (!dispatch || !run || run.status !== "running")
      throw new Error("team_dispatch_expired_or_paused");
    if (
      (name === "team_spawn_agent" ||
        name === "team_rename" ||
        name === "team_shutdown") &&
      member.role !== "lead"
    )
      throw new Error("team_lead_required");
    const result = this.teams.operation(
      `${team.id}:${member.id}:${args.operationId}`,
      { name, args },
      () => {
        if (name === "team_spawn_agent") {
          const preset = this.presets.resolve(
            String(args.presetId),
          ).resolvedSnapshot;
          if (!preset.enabled) throw new Error("preset_disabled");
          return this.teams.recruit(team.id, dispatch.id, {
            name: String(args.name),
            engine: preset.engine,
            ...(preset.acpCatalogId
              ? { acpCatalogId: preset.acpCatalogId }
              : {}),
            presetId: preset.id,
          });
        }
        if (name === "team_send_message")
          return this.teams.sendMessage(
            team.id,
            {
              fromMemberId: member.id,
              toMemberId: args.toMemberId as string | null,
              body: String(args.body),
            },
            dispatch.id,
          );
        if (name === "team_task_create")
          return this.teams.queueTask(
            team.id,
            {
              memberId: String(args.memberId),
              title: String(args.title),
              input: String(args.input),
              dependsOnIds: args.dependsOnIds as string[],
              createdByMemberId: member.id,
            },
            dispatch.id,
          );
        if (name === "team_rename")
          return this.teams.update(team.id, team.version, {
            name: String(args.name),
          });
        if (name === "team_shutdown")
          return this.teams.controlRun(team.id, run.id, "pause");
        const {
          taskId,
          expectedVersion,
          operationId: _operationId,
          ...mutation
        } = args;
        return this.teams.updateTask(
          team.id,
          String(taskId),
          Number(expectedVersion),
          mutation,
          member.id,
        );
      },
    );
    void this.orchestrator.tick();
    return result;
  }
}

export function mountSessionTools(
  ctx: Context,
  token: string,
  service: SessionTools,
) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/v1/session-tools",
        handler: async (request, response) => {
          const send = (status: number, value: unknown) => {
            response.writeHead(status, {
              "content-type": "application/json",
              "cache-control": "no-store",
            });
            response.end(JSON.stringify(value));
          };
          if (!authorized(request, token))
            return send(401, { error: "authentication_required" });
          if (request.method !== "POST")
            return send(405, { error: "method_not_allowed" });
          try {
            let value = "";
            for await (const chunk of request) {
              value += String(chunk);
              if (value.length > 128 * 1024)
                throw new Error("request_too_large");
            }
            send(200, await service.handle(JSON.parse(value)));
          } catch (error) {
            send(400, {
              error:
                error instanceof Error ? error.message : "session_tool_failed",
            });
          }
        },
      }),
    "workagent session tools",
  );
}
