import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionTools, type SessionToolPort } from "./session-tools.js";
import { AutomationStore, AutomationScheduler } from "./automation-store.js";
import { TeamStore, TeamOrchestrator } from "./team-store.js";
import { McpCatalogStore, SkillCatalogStore } from "./capability-store.js";
import { PresetStore } from "./preset-store.js";
import { ModelAccessStore } from "./model-access-store.js";

const roots: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "workagent-session-tools-"));
  roots.push(home);
  const presets = new PresetStore(
    home,
    new ModelAccessStore(home),
    new SkillCatalogStore(),
    new McpCatalogStore(),
  );
  const automations = new AutomationStore(home),
    teams = new TeamStore(home);
  const scheduler = new AutomationScheduler(automations, { execute: vi.fn() });
  const orchestrator = new TeamOrchestrator(teams, {
    executeTeamTask: vi.fn(),
  });
  vi.spyOn(scheduler, "tick").mockResolvedValue();
  vi.spyOn(orchestrator, "tick").mockResolvedValue();
  const runtime: SessionToolPort = {
    validateToolScope: (_id, token) => token === "scope",
    sessionToolContext: (sessionId) => ({
      sessionId,
      engine: "codex",
      presetId: "builtin-codex",
      workspaceId: "workspace-a",
    }),
  };
  const service = new SessionTools(
    runtime,
    automations,
    scheduler,
    teams,
    orchestrator,
    presets,
  );
  const call = (name: string, args: unknown = {}, sessionId = "conversation") =>
    service.handle({
      method: "tools/call",
      sessionId,
      scopeToken: "scope",
      name,
      arguments: args,
    });
  return { home, service, call, teams, automations };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("creates and updates a schedule from the conversation with durable idempotence and version checks", async () => {
  const { call, automations } = fixture();
  const input = {
    operationId: "create-1",
    name: "Tomorrow",
    input: "Prepare summary",
    schedule: { kind: "once", at: "2099-01-01T09:00:00+08:00" },
    executionMode: "existing",
  };
  const first = await call("automation_create", input);
  expect(await call("automation_create", input)).toEqual(first);
  expect(automations.list()).toHaveLength(1);
  const task = automations.list()[0]!;
  expect(task).toMatchObject({
    conversationId: "conversation",
    workspaceId: "workspace-a",
    presetId: "builtin-codex",
    engine: "codex",
  });
  await call("automation_update", {
    operationId: "pause-1",
    id: task.id,
    expectedVersion: task.version,
    enabled: false,
  });
  expect(automations.get(task.id)?.enabled).toBe(false);
  await expect(
    call("automation_update", {
      operationId: "stale",
      id: task.id,
      expectedVersion: task.version,
      name: "Stale edit",
    }),
  ).rejects.toThrow("automation_version_conflict");
  await expect(
    call("automation_create", { ...input, input: "Changed duplicate" }),
  ).rejects.toThrow("operation_id_conflict");
});

it("advertises only applicable tools and rejects a different session scope", async () => {
  const { service, call } = fixture();
  const list = (await service.handle({
    sessionId: "conversation",
    scopeToken: "scope",
    method: "tools/list",
  })) as { tools: { name: string }[] };
  expect(list.tools.every((tool) => tool.name.startsWith("automation_"))).toBe(
    true,
  );
  await expect(
    call("team_spawn_agent", {
      operationId: "spawn",
      name: "Intruder",
      presetId: "builtin-codex",
    }),
  ).rejects.toThrow("team_session_required");
  await expect(
    service.handle({
      sessionId: "conversation",
      scopeToken: "wrong",
      method: "tools/list",
    }),
  ).rejects.toThrow("session_scope_expired");
});

it("allows the lead to recruit once and prevents a member from impersonating the lead", async () => {
  const { teams, call } = fixture();
  const team = teams.create({
    name: "Review",
    workspaceId: "workspace-a",
    lead: { name: "Lead", engine: "codex", presetId: "builtin-codex" },
  });
  const lead = team.members[0]!;
  teams.startRun(team.id, "Review the files");
  teams.beginDispatch(teams.queuedDispatches()[0]!.id);
  const args = {
    operationId: "spawn-worker",
    name: "Worker",
    presetId: "builtin-kimi",
  };
  await call("team_spawn_agent", args, lead.sessionId!);
  await call("team_spawn_agent", args, lead.sessionId!);
  expect(teams.get(team.id)?.members).toHaveLength(2);
  const worker = teams.get(team.id)!.members[1]!;
  await call(
    "team_task_create",
    {
      operationId: "work",
      memberId: worker.id,
      title: "Review",
      input: "Check the files",
    },
    lead.sessionId!,
  );
  const queued = teams
    .queuedDispatches()
    .find((item) => item.memberId === worker.id)!;
  teams.beginDispatch(queued.id);
  await expect(
    call(
      "team_spawn_agent",
      { operationId: "forbidden", name: "Other", presetId: "builtin-codex" },
      worker.sessionId!,
    ),
  ).rejects.toThrow("team_lead_required");
  teams.controlRun(team.id, teams.runs(team.id)[0]!.id, "cancel");
  await expect(
    call(
      "team_send_message",
      { operationId: "late", toMemberId: lead.id, body: "Late" },
      worker.sessionId!,
    ),
  ).rejects.toThrow("team_dispatch_expired_or_paused");
});
