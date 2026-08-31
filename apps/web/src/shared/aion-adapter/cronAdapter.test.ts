import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AutomationDefinition,
  AutomationRun,
  PresetDefinition,
} from "@workagent/contracts";
import {
  cronBridge,
  toAutomationSchedule,
  toRendererCronSchedule,
} from "./cronAdapter.js";

const now = "2026-08-31T01:00:00.000Z";
const workspace = {
  id: "workspace-1",
  name: "Default",
  createdAt: now,
};

const preset: PresetDefinition = {
  id: "preset-codex",
  version: 1,
  source: "builtin",
  name: "Codex",
  description: "",
  avatar: null,
  enabled: true,
  engine: "codex",
  modelId: "gpt-5",
  systemPrompt: "",
  workspacePolicy: "optional",
  skillIds: ["documents"],
  mcpServerIds: ["filesystem"],
  toolAllowlist: [],
  approvalPolicy: "on_risk",
  createdAt: now,
  updatedAt: now,
};

const definition: AutomationDefinition = {
  id: "automation-1",
  version: 2,
  name: "Morning brief",
  enabled: true,
  schedule: {
    kind: "cron",
    expression: "15 9 * * MON-FRI",
    timezone: "Asia/Shanghai",
  },
  presetId: preset.id,
  engine: "codex",
  workspaceId: "workspace-1",
  input: "Summarize the project",
  notificationPolicy: "on_failure",
  executionMode: "existing",
  conversationId: "conversation-1",
  nextRunAt: "2026-09-01T01:15:00.000Z",
  lastRunAt: now,
  createdAt: now,
  updatedAt: now,
};

const run: AutomationRun = {
  id: "run-1",
  automationId: definition.id,
  definitionSnapshot: definition,
  trigger: "manual",
  scheduledFor: now,
  status: "succeeded",
  attempt: 1,
  sessionId: "conversation-1",
  result: "done",
  error: null,
  createdAt: now,
  startedAt: now,
  finishedAt: now,
};

const json = (value: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );

afterEach(() => vi.unstubAllGlobals());

describe("formal Renderer cron adapter", () => {
  it("preserves cron expressions and timezone at the WorkAgent3 boundary", () => {
    expect(toRendererCronSchedule(definition.schedule)).toEqual({
      kind: "cron",
      expr: "15 9 * * MON-FRI",
      tz: "Asia/Shanghai",
      description: "15 9 * * MON-FRI",
    });
    expect(
      toAutomationSchedule({
        kind: "cron",
        expr: "15 9 * * MON-FRI",
        tz: "Asia/Shanghai",
        description: "Weekdays",
      }),
    ).toEqual(definition.schedule);
  });

  it("maps SID-private definitions, history and preset metadata to formal jobs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/runtime/v1/automations") return json([definition]);
        if (url === "/api/runtime/v1/presets") return json([preset]);
        if (url === "/api/runtime/v1/automations/automation-1/runs")
          return json([run]);
        throw new Error(`unexpected:${url}`);
      }),
    );

    await expect(cronBridge.listJobs.invoke()).resolves.toEqual([
      expect.objectContaining({
        id: definition.id,
        name: definition.name,
        target: {
          payload: { kind: "message", text: definition.input },
          execution_mode: "existing",
        },
        metadata: expect.objectContaining({
          conversation_id: "conversation-1",
          agent_type: "codex",
          agent_config: expect.objectContaining({
            assistant_id: preset.id,
            workspace: "workspace-1",
          }),
        }),
        state: expect.objectContaining({
          last_status: "ok",
          run_count: 1,
        }),
      }),
    ]);
  });

  it("creates an existing-conversation automation without changing the formal payload", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/runtime/v1/presets") return json([preset]);
      if (url === "/api/runtime/v1/workspaces") return json([workspace]);
      if (url === "/api/runtime/v1/automations" && init?.method === "POST")
        return json(definition);
      if (url === "/api/runtime/v1/automations/automation-1/runs")
        return json([]);
      throw new Error(`unexpected:${url}:${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await cronBridge.addJob.invoke({
      name: definition.name,
      schedule: {
        kind: "cron",
        expr: "15 9 * * MON-FRI",
        tz: "Asia/Shanghai",
        description: "Weekdays",
      },
      prompt: definition.input,
      conversation_id: "conversation-1",
      created_by: "user",
      execution_mode: "existing",
      agent_config: {
        name: preset.name,
        assistant_id: preset.id,
        workspace: "workspace-1",
      },
    });

    const post = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === "/api/runtime/v1/automations" && init?.method === "POST",
    );
    expect(JSON.parse(String(post?.[1]?.body))).toEqual(
      expect.objectContaining({
        presetId: preset.id,
        engine: "codex",
        workspaceId: "workspace-1",
        executionMode: "existing",
        conversationId: "conversation-1",
        schedule: definition.schedule,
      }),
    );
  });

  it("returns the real run conversation after run-now completes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (
          url === "/api/runtime/v1/automations/automation-1/run" &&
          init?.method === "POST"
        )
          return json({ ...run, status: "pending", sessionId: null });
        if (url === "/api/runtime/v1/automations/automation-1/runs")
          return json([run]);
        throw new Error(`unexpected:${url}`);
      }),
    );

    await expect(
      cronBridge.runNow.invoke({ job_id: "automation-1" }),
    ).resolves.toEqual({ conversation_id: "conversation-1" });
  });

  it("surfaces an actionable runtime failure instead of reporting trigger success", async () => {
    const failed = {
      ...run,
      status: "failed" as const,
      sessionId: null,
      result: null,
      error: "credential_needs_auth:codex",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (
          url === "/api/runtime/v1/automations/automation-1/run" &&
          init?.method === "POST"
        )
          return json({ ...failed, status: "pending", error: null });
        if (url === "/api/runtime/v1/automations/automation-1/runs")
          return json([failed]);
        throw new Error(`unexpected:${url}`);
      }),
    );

    await expect(
      cronBridge.runNow.invoke({ job_id: "automation-1" }),
    ).rejects.toThrow("credential_needs_auth:codex");
  });
});
