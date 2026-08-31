import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationScheduler, AutomationStore } from "./automation-store.js";
import { McpCatalogStore, SkillCatalogStore } from "./capability-store.js";
import { ModelAccessStore } from "./model-access-store.js";
import { PresetStore } from "./preset-store.js";
import { QuotaAutomationRunner } from "./quota-runner.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("recoverable Automation composition", () => {
  it("recovers a queued run and composes Preset, Engine, Skill, MCP and Quota ports", async () => {
    const home = mkdtempSync(
      join(tmpdir(), "workagent-automation-composition-"),
    );
    roots.push(home);
    const skills = new SkillCatalogStore();
    skills.replace({
      skills: [
        {
          entry: {
            id: "managed-brief",
            name: "Managed brief",
            description: "Creates a deterministic brief",
            version: "1",
            source: "managed",
            enabled: true,
            relativePath: "brief/SKILL.md",
            requiredMcpServerIds: ["managed-context"],
            requiredCommands: [],
            health: "ready",
          },
          root:
            process.platform === "win32"
              ? "C:\\managed-skills"
              : "/managed-skills",
        },
      ],
    });
    const mcp = new McpCatalogStore();
    mcp.replace({
      servers: [
        {
          server: {
            id: "managed-context",
            name: "Managed context",
            source: "managed",
            enabled: true,
            transport: {
              kind: "http",
              url: "http://127.0.0.1:8123/mcp",
              headerCredentialIds: {},
            },
            toolPolicy: "all",
            allowedTools: [],
            oauthState: "none",
            health: "healthy",
            createdAt: "2026-08-31T00:00:00.000Z",
            updatedAt: "2026-08-31T00:00:00.000Z",
          },
          environment: {},
          headers: {},
          state: "ready",
        },
      ],
    });
    const presets = new PresetStore(
      home,
      new ModelAccessStore(home),
      skills,
      mcp,
    );
    const preset = presets.create({
      name: "Recoverable brief",
      engine: "harness",
      modelId: "harness-default",
      skillIds: ["managed-brief"],
      mcpServerIds: ["managed-context"],
    });
    const firstStore = new AutomationStore(home);
    const definition = firstStore.create({
      name: "Recoverable brief",
      enabled: false,
      schedule: { kind: "cron", expression: "", timezone: "Asia/Shanghai" },
      presetId: preset.id,
      engine: "harness",
      workspaceId: "workspace-default",
      input: "Prepare the brief",
      notificationPolicy: "on_failure",
    });
    const queued = firstStore.runNow(definition.id);

    const reserve = vi.fn().mockResolvedValue({});
    const settle = vi.fn();
    const execute = vi.fn(async (request) => {
      const binding = presets.resolve(request.definition.presetId);
      expect(
        binding.resolvedSnapshot.resolvedSkills?.map((skill) => skill.id),
      ).toEqual(["managed-brief"]);
      expect(
        binding.resolvedSnapshot.resolvedMcpServers?.map((server) => server.id),
      ).toEqual(["managed-context"]);
      return { sessionId: `session-${request.automationRunId}` };
    });
    const recoveredStore = new AutomationStore(home);
    const scheduler = new AutomationScheduler(
      recoveredStore,
      new QuotaAutomationRunner({ execute }, presets, { reserve, settle }),
    );

    await scheduler.tick();

    expect(execute).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: queued.id,
        modelId: "harness-default",
      }),
    );
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ runId: queued.id }),
    );
    expect(recoveredStore.getRun(queued.id)).toMatchObject({
      status: "succeeded",
      sessionId: `session-${queued.id}`,
    });
  });
});
