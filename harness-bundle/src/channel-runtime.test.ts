import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { NativeSessionLog } from "./native-session-log.js";
import { RuntimeController } from "./runtime.js";
import { WorkspaceStore } from "./workspace-store.js";
import { PresetStore } from "./preset-store.js";
import {
  ModelAccessStore,
  type CredentialStatusStore,
} from "./model-access-store.js";
import { McpCatalogStore, SkillCatalogStore } from "./capability-store.js";
import { SessionIndex } from "./session-index.js";
import { MessageStore } from "./message-store.js";
import { AutomationStore } from "./automation-store.js";
import * as marketCapabilities from "./market-capabilities.js";
vi.mock("@deepseek-ai/dsh-agent", () => ({ installModelSelection: vi.fn() }));
vi.mock("@deepseek-ai/dsh-mcp-client", () => ({ apply: vi.fn() }));

const native = vi.hoisted(() => ({
  create: vi.fn(),
  resume: vi.fn(),
  send: vi.fn(),
  cancel: vi.fn(),
  close: vi.fn(),
  events: undefined as undefined | ((event: any) => void),
}));
vi.mock("./engines/codex.js", () => ({
  CodexBridge: class {
    create = native.create;
    resume = native.resume;
    async listModels() {
      return [
        {
          id: "gpt-test",
          name: "GPT Test",
          isDefault: true,
          reasoning: [{ id: "high", name: "高" }],
        },
      ];
    }
  },
}));
vi.mock("./engines/kimi.js", () => ({
  KimiBridge: class {
    create = native.create;
    resume = native.resume;
    async listModels() {
      return [
        { id: "kimi-test", name: "Kimi Test", isDefault: true, reasoning: [] },
      ];
    }
  },
}));

const config = {
  provider: "workagent-codex",
  model: "gpt-test",
  reasoningEffort: "high",
  permissionPreset: "read-only",
};

describe("idempotent runtime session creation", () => {
  it.each(["canonical move", "index removal"])(
    "resumes canonical deletion after restart and a failed %s",
    async (failure) => {
      const a = fixture();
      const openLog = () => {
        const context = new Context();
        new SessionStore(context);
        return new NativeSessionLog(context, a.home);
      };
      const firstLog = openLog();
      a.createRuntime(firstLog).mount();
      const input = {
        operationId: "personal_canonical_delete",
        engine: "codex",
        title: "Canonical cleanup",
        workspace: "default",
      };
      const created = await a.call("/v1/sessions", "POST", input);
      expect(created.status).toBe(201);
      const id = created.result.id as string;
      firstLog.appendMessage({
        id: "private-message",
        sessionId: id,
        role: "user",
        text: "Private canonical content",
        createdAt: new Date().toISOString(),
      });
      const path = firstLog.location(id);
      expect(existsSync(path)).toBe(true);
      await firstLog.dispose();
      // Simulate the process dying after durable cancellation but before cleanup.
      new SessionIndex(a.home).cancelOperation(input.operationId);
      const recoveredLog = openLog();
      a.createRuntime(recoveredLog).mount();
      expect(recoveredLog.get(id)).toBeUndefined();
      const operationPath = `/v1/session-operations/${input.operationId}`;
      const blockedPath =
        failure === "canonical move"
          ? `${path}.deleted`
          : join(a.home, "workagent", `sessions.json.${process.pid}.tmp`);
      mkdirSync(blockedPath);
      let unblocked = false;
      try {
        expect((await a.call(operationPath, "DELETE")).status).toBe(503);
        const operation = new SessionIndex(a.home).lookupOperation(
          input.operationId,
        );
        expect(operation?.state).toBe("deleting");
        expect(operation?.session?.id).toBe(id);
        expect(new SessionIndex(a.home).list()).toEqual([]);
        await recoveredLog.dispose();
        const retriedLog = openLog();
        a.createRuntime(retriedLog).mount();
        expect(retriedLog.get(id)).toBeUndefined();
        rmdirSync(blockedPath);
        unblocked = true;
        expect((await a.call(operationPath, "DELETE")).status).toBe(204);
        expect(
          new SessionIndex(a.home).lookupOperation(input.operationId)?.state,
        ).toBe("deleted");
        expect(existsSync(path)).toBe(false);
        expect(existsSync(`${path}.deleted`)).toBe(true);
        expect(retriedLog.raw(id)).toBeUndefined();
        expect(() =>
          retriedLog.open({ id, engine: "codex", workspacePath: a.home }, []),
        ).toThrow("native_session_deleted");
        await retriedLog.dispose();
      } finally {
        if (!unblocked) rmdirSync(blockedPath);
      }
      expect(native.create).not.toHaveBeenCalled();
      expect(native.resume).not.toHaveBeenCalled();
    },
  );
  it("persists cancellation before a not-yet-committed create and blocks its late response", async () => {
    const a = fixture();
    const input = {
      operationId: "personal_cancel_race",
      engine: "codex",
      title: "Late task",
      workspace: "default",
    };
    const operationPath = `/v1/session-operations/${input.operationId}`;
    expect((await a.call(operationPath)).status).toBe(404);
    expect(
      (await a.call(operationPath, "DELETE", undefined, "wrong-token")).status,
    ).toBe(401);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capabilities = vi
      .spyOn(marketCapabilities, "runtimeMarketCapabilities")
      .mockImplementation(async () => {
        await gate;
        return undefined;
      });
    try {
      const creating = a.call("/v1/sessions", "POST", input);
      await vi.waitFor(() => expect(capabilities).toHaveBeenCalledOnce());
      expect((await a.call(operationPath, "DELETE")).status).toBe(204);
      release();
      expect(await creating).toMatchObject({
        status: 409,
        result: { error: "operation_deleted" },
      });
      a.createRuntime().mount();
      expect(await a.call(operationPath)).toMatchObject({
        status: 200,
        result: { operation: { id: input.operationId, state: "deleted" } },
      });
      expect((await a.call("/v1/sessions", "POST", input)).status).toBe(409);
      expect(new SessionIndex(a.home).list()).toEqual([]);
      expect(native.create).not.toHaveBeenCalled();
    } finally {
      release();
      capabilities.mockRestore();
    }
  });

  it("looks up without a workspace and retries engine cleanup after a failed operation deletion", async () => {
    const a = fixture();
    const input = {
      operationId: "personal_delete_retry",
      engine: "codex",
      title: "Cleanup",
      workspace: "default",
    };
    const operationPath = `/v1/session-operations/${input.operationId}`;
    const created = await a.call("/v1/sessions", "POST", input);
    expect((await a.call(operationPath)).result.session).toEqual(
      created.result,
    );
    expect(
      (await a.call(`/v1/sessions/${created.result.id}/configuration`)).status,
    ).toBe(200);
    native.close.mockRejectedValueOnce(new Error("temporary close failure"));
    expect((await a.call(operationPath, "DELETE")).status).toBe(503);
    expect((await a.call(operationPath)).result.operation.state).toBe(
      "deleting",
    );
    expect((await a.call("/v1/sessions", "POST", input)).status).toBe(409);
    expect((await a.call(operationPath, "DELETE")).status).toBe(204);
    expect((await a.call(operationPath)).result).toEqual({
      operation: { id: input.operationId, state: "deleted" },
    });
    expect(native.close).toHaveBeenCalledTimes(2);
    expect(new SessionIndex(a.home).list()).toEqual([]);
  });

  it("freezes one lazy session across concurrent requests, restart and assistant updates", async () => {
    const a = fixture();
    const preset = a.presets.create({
      name: "Operation assistant",
      engine: "codex",
      systemPrompt: "Version one",
    });
    const input = {
      operationId: "personal_user_test",
      engine: "codex",
      title: "Personal task",
      workspace: "default",
      presetId: preset.id,
    };
    const first = await Promise.all([
      a.call("/v1/sessions", "POST", input),
      a.call("/v1/sessions", "POST", input),
    ]);
    expect(first[0]!.status).toBe(201);
    expect(first[1]!.result).toEqual(first[0]!.result);
    expect(native.create).not.toHaveBeenCalled();
    a.presets.update(preset.id, { systemPrompt: "Version two" });
    a.createRuntime().mount();
    const repeated = await a.call("/v1/sessions", "POST", input);
    expect(repeated.result).toEqual(first[0]!.result);
    expect(new SessionIndex(a.home).list()).toHaveLength(1);
    const changed = await a.call("/v1/sessions", "POST", {
      ...input,
      title: "Different task",
    });
    expect(changed).toMatchObject({
      status: 409,
      result: { error: "operation_conflict" },
    });
    const activated = await a.call(
      `/v1/sessions/${first[0]!.result.id}/turns`,
      "POST",
      {
        content: "Hello",
        clientRequestId: "4c8f9f30-a3c0-4150-82e9-5a2f80a2e012",
      },
    );
    expect(activated.status).toBe(202);
    expect(native.create).toHaveBeenCalledOnce();
    expect(native.resume).not.toHaveBeenCalled();
    expect(native.create.mock.calls[0]![2]).toMatchObject({
      systemPrompt: "Version one",
    });
  });

  it("keeps a deletion tombstone across restart without recreating an engine", async () => {
    const a = fixture();
    const input = {
      operationId: "personal_user_deleted",
      engine: "codex",
      title: "Delete me",
      workspace: "default",
    };
    const created = await a.call("/v1/sessions", "POST", input);
    expect(
      (await a.call(`/v1/sessions/${created.result.id}`, "DELETE")).status,
    ).toBe(204);
    a.createRuntime().mount();
    expect(await a.call("/v1/sessions", "POST", input)).toMatchObject({
      status: 409,
      result: { error: "operation_deleted" },
    });
    expect(new SessionIndex(a.home).list()).toEqual([]);
    expect(native.create).not.toHaveBeenCalled();
  });

  it("reports unsupported saved policies before acknowledging a personal task", async () => {
    const a = fixture();
    const preset = a.presets.create({
      name: "Unsupported tools",
      engine: "codex",
      toolAllowlist: ["read_file"],
    });
    expect(
      await a.call("/v1/sessions", "POST", {
        operationId: "personal_restricted",
        engine: "codex",
        title: "Restricted",
        workspace: "default",
        presetId: preset.id,
      }),
    ).toMatchObject({
      status: 400,
      result: { error: "unsupported_preset_tool_allowlist" },
    });
    expect(new SessionIndex(a.home).list()).toEqual([]);
    expect(native.create).not.toHaveBeenCalled();
    a.presets.update(preset.id, {
      toolAllowlist: [],
      workspacePolicy: "required",
    });
    expect(
      await a.call("/v1/sessions", "POST", {
        operationId: "personal_requires_workspace",
        engine: "codex",
        title: "Restricted",
        workspace: "default",
        presetId: preset.id,
      }),
    ).toMatchObject({
      status: 400,
      result: { error: "preset_workspace_required" },
    });
  });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "channel-runtime-"));
  vi.stubEnv("DSH_HOME", home);
  const workspaces = new WorkspaceStore(join(home, "workspaces"), home);
  const skills = new SkillCatalogStore();
  const presets = new PresetStore(home, new ModelAccessStore(home), skills);
  const quota = {
    reserve: vi.fn().mockResolvedValue({ status: "reserved" }),
    settle: vi.fn().mockResolvedValue(undefined),
  };
  const routes = new Map<string, any>();
  let sessionEvent: any;
  const permissionSet = vi.fn();
  const promptSection = vi.fn();
  const promptVariable = vi.fn();
  const ctx = {
    effect: (callback: () => unknown) => callback(),
    on: (name: string, callback: any) => {
      if (name === "session/event") sessionEvent = callback;
      return () => {};
    },
    permissionPresets: { set: permissionSet },
    webServer: {
      register: (route: any) => {
        routes.set(route.path, route.handler);
        return () => {};
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: "p" }) },
    llm: { listModels: async () => [] },
  } as unknown as Context;
  const credentials = {
    statusFor: () => ({ state: "ready" }),
  } as unknown as CredentialStatusStore;
  const createRuntime = (nativeLog?: NativeSessionLog) =>
    new RuntimeController(
      ctx,
      "test",
      workspaces,
      presets,
      new McpCatalogStore(),
      skills,
      credentials,
      quota,
      nativeLog,
    );
  const runtime = createRuntime();
  runtime.mount();
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    token = "test",
  ) => {
    const req = Object.assign(
      Readable.from(body === undefined ? [] : [JSON.stringify(body)]),
      { url: path, method, headers: { authorization: `Bearer ${token}` } },
    );
    let status = 0;
    let result: any;
    const res = {
      writeHead: (value: number) => {
        status = value;
      },
      end: (value: string) => {
        result = value ? JSON.parse(value) : undefined;
      },
    };
    const route = [...routes.keys()]
      .sort((a, b) => b.length - a.length)
      .find((base) => path.startsWith(base))!;
    await routes.get(route)(req, res);
    return { status, result };
  };
  return {
    runtime,
    home,
    workspaces,
    call,
    quota,
    createRuntime,
    service: runtime.channelService(),
    presets,
    skills,
    ctx,
    permissionSet,
    promptSection,
    promptVariable,
    emit: (session: any, event: any) => sessionEvent(session, event),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const open = async (...args: any[]) => {
    native.events = args.find((arg) => typeof arg === "function");
    return {
      nativeId: "native-thread",
      connected: true,
      send: native.send,
      cancel: native.cancel,
      close: native.close,
    };
  };
  native.create.mockImplementation(open);
  native.resume.mockImplementation(open);
  native.send.mockImplementation(async () => {
    native.events!({ type: "turn.started", turnId: "turn-1" });
    native.events!({
      type: "assistant.delta",
      turnId: "turn-1",
      delta: "你好",
    });
    native.events!({
      type: "assistant.completed",
      turnId: "turn-1",
      content: "你好",
    });
    native.events!({ type: "turn.completed", turnId: "turn-1" });
    return "turn-1";
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("native IM sessions", () => {
  it("applies the same Harness assistant through ordinary, team, automation and shared entrypoints", async () => {
    const a = fixture();
    const workspace = a.workspaces.create("Configuration checks");
    const assistant = a.presets.create({
      name: "Shared instructions",
      engine: "harness",
      systemPrompt: "Use this assistant in every entrypoint.",
    });
    const followup = vi.fn();
    const setup = async (options: any) => {
      const session = { id: options.sessionId ?? options.resumeSessionId };
      await options.setup({
        agent: { session },
        systemPrompt: { section: a.promptSection, variable: a.promptVariable },
      });
      return {
        dispose: vi.fn(),
        agent: {
          session,
          followup: (message: any) => {
            followup(message);
            a.emit(session, {
              type: "turn/start",
              data: { turn: 1 },
              seq: 1,
              time: Date.now(),
            });
            a.emit(session, {
              type: "turn/end",
              data: { turn: 1, reason: { kind: "completed" } },
              seq: 2,
              time: Date.now(),
            });
          },
        },
      };
    };
    a.ctx.agents = { create: vi.fn(setup), resume: vi.fn(setup) } as any;
    const created = await a.call("/v1/sessions", "POST", {
      engine: "harness",
      title: "Ordinary",
      workspace: workspace.id,
      presetId: assistant.id,
      permissionMode: "read_only",
    });
    expect(created.status).toBe(201);
    await a.runtime.openTeamSession({
      sessionId: "session-team-config",
      title: "Team",
      engine: "harness",
      presetId: assistant.id,
      workspaceId: workspace.id,
    });
    const definition = new AutomationStore(a.home).create({
      name: "Scheduled",
      enabled: false,
      schedule: { kind: "interval", everyMinutes: 60 },
      engine: "harness",
      presetId: assistant.id,
      workspaceId: workspace.id,
      input: "Check",
      notificationPolicy: "none",
    });
    await a.runtime.execute({
      automationRunId: "configuration_automation",
      definition,
    });
    await a.runtime.executeSharedTurn({
      runId: "run_config_shared",
      conversationId: "conversation_config",
      projectId: "project_config",
      engine: "harness",
      assistantId: assistant.id,
      modelId: "general-test",
      thinkingEffort: "high",
      context: "Shared check",
      recoveryContext: "Shared check",
      workspacePath: a.workspaces.engineRoot(workspace.id),
      payerSid: "S-1-test",
    });
    expect(a.promptVariable).toHaveBeenCalledTimes(4);
    expect(a.promptVariable.mock.calls.map((call) => call[1]())).toEqual(
      Array(4).fill(assistant.systemPrompt),
    );
    expect(a.permissionSet.mock.calls.map((call) => call[1])).toEqual([
      "read-only",
      "workspace-write",
      "workspace-write",
      "workspace-write",
    ]);
    expect(followup).toHaveBeenCalledTimes(2);
    expect(
      followup.mock.calls.every(
        ([message]) =>
          !message.content[0].text.includes(assistant.systemPrompt),
      ),
    ).toBe(true);
  });

  it("executes a custom general assistant through Harness with the channel permission and reply stream", async () => {
    const a = fixture();
    const assistant = a.presets.create({
      name: "通用渠道助手",
      engine: "harness",
      systemPrompt: "General custom instructions",
    });
    const send = vi.fn();
    const cancel = vi.fn();
    const dispose = vi.fn();
    a.ctx.llm.listModels = vi
      .fn()
      .mockResolvedValue([{ id: "general-test", name: "General Test" }]);
    a.ctx.llm.resolveModelInfo = vi.fn().mockResolvedValue({});
    a.ctx.agents = {
      resume: vi.fn().mockImplementation(async (options) => {
        const session = { id: options.resumeSessionId };
        await options.setup({
          agent: { session },
          systemPrompt: {
            section: a.promptSection,
            variable: a.promptVariable,
          },
        });
        return {
          dispose,
          agent: {
            cancel,
            followup: (message: any) => {
              send(message);
              let seq = 0;
              for (const [type, data] of [
                ["turn/start", { turn: 1 }],
                [
                  "assistant/message",
                  {
                    turn: 1,
                    message: {
                      content: [{ type: "text", text: "General reply" }],
                    },
                  },
                ],
                ["turn/end", { turn: 1, reason: { kind: "completed" } }],
              ]) {
                a.emit(session, { type, data, seq: ++seq, time: Date.now() });
              }
            },
          },
        };
      }),
    } as any;
    const selection = {
      provider: "workagent-harness",
      model: "general-test",
      presetId: assistant.id,
      permissionPreset: "read-only",
    };
    const handle = (await a.service.open(
      selection,
      undefined,
      "General",
      "channel:dm:general",
    ))!;
    const reply = vi.fn();
    await handle.followup(
      { id: "general-input", content: [{ type: "text", text: "Hello" }] },
      reply,
    );
    expect(send.mock.calls[0]![0].content[0].text).toBe("Hello");
    expect(a.promptSection).toHaveBeenCalledWith({
      name: "deployment:persona",
      order: 0,
      text: "{{workagent_assistant_prompt}}",
    });
    expect(a.promptVariable.mock.calls[0]![1]()).toBe(
      "General custom instructions",
    );
    expect(a.permissionSet).toHaveBeenCalledWith(
      expect.anything(),
      "read-only",
    );
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ type: "assistant/message" }),
    );
    expect(a.service.assistants().some((row) => row.id === assistant.id)).toBe(
      true,
    );
    expect(
      a.service.rename("channel:dm:general", handle.sessionId, "Renamed"),
    ).toBe("Renamed");
    await a.service.cancel("channel:dm:general", handle.sessionId);
    expect(cancel).toHaveBeenCalled();
    await handle.dispose();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("loads the selected native assistant's bound skill into its first input", async () => {
    const a = fixture();
    const root = join(a.home, "channel-skill");
    mkdirSync(join(root, "report"), { recursive: true });
    writeFileSync(
      join(root, "report", "SKILL.md"),
      "Check every report total.",
    );
    a.skills.replace({
      skills: [
        {
          root,
          entry: {
            id: "channel-skill",
            name: "Report",
            description: "Report checks",
            version: "1",
            source: "user",
            enabled: true,
            relativePath: "channel-skill/report",
            requiredMcpServerIds: [],
            requiredCommands: [],
            health: "ready",
          },
        },
      ],
    });
    const assistant = a.presets.create({
      name: "报告助手",
      engine: "codex",
      skillIds: ["channel-skill"],
    });
    const handle = (await a.service.open({
      ...config,
      presetId: assistant.id,
    }))!;
    await handle.followup(
      { id: "skill-input", content: [{ type: "text", text: "Review" }] },
      async () => {},
    );
    expect(native.send.mock.calls[0]![0]).toContain(
      "Check every report total.",
    );
    expect(native.send.mock.calls[0]![0]).toContain(
      join(root, "report", "SKILL.md"),
    );
  });
  it("uses a custom assistant snapshot, resumes it and rotates when the assistant changes", async () => {
    const { service, presets, home, createRuntime } = fixture();
    const assistant = presets.create({
      name: "渠道专员",
      engine: "codex",
      systemPrompt: "Always explain the channel assistant selection.",
    });
    expect(service.assistants()).toContainEqual(
      expect.objectContaining({
        id: assistant.id,
        name: "渠道专员",
        provider: "workagent-codex",
      }),
    );
    const selection = { ...config, presetId: assistant.id };
    const handle = await service.open(
      selection,
      undefined,
      "custom",
      "channel:dm:alice",
    );
    expect(
      new SessionIndex(home).list().find((row) => row.id === handle!.sessionId)
        ?.preset?.resolvedSnapshot.systemPrompt,
    ).toBe(assistant.systemPrompt);
    await handle!.followup(
      { id: "custom-input", content: [{ type: "text", text: "Hello" }] },
      async () => {},
    );
    expect(native.send).toHaveBeenCalledWith("Hello", []);
    expect(native.create.mock.calls.at(-1)![2].systemPrompt).toBe(
      assistant.systemPrompt,
    );
    expect(
      service.configuration("channel:dm:alice", handle!.sessionId).presetId,
    ).toBe(assistant.id);
    expect(
      await service.open(
        config,
        handle!.sessionId,
        undefined,
        "channel:dm:alice",
      ),
    ).toBeUndefined();
    await handle!.dispose();
    const restarted = createRuntime().channelService();
    expect(
      (
        await restarted.open(
          selection,
          handle!.sessionId,
          undefined,
          "channel:dm:alice",
        )
      )?.sessionId,
    ).toBe(handle!.sessionId);
    presets.update(assistant.id, { enabled: false });
    expect(service.assistants().some((row) => row.id === assistant.id)).toBe(
      false,
    );
    await expect(service.open(selection)).rejects.toThrow("preset_disabled");
    const kimi = presets.create({ name: "Kimi 专员", engine: "kimi" });
    await expect(
      service.open({ ...config, presetId: kimi.id }),
    ).rejects.toThrow("channel_assistant_engine_mismatch");
  });

  it("gates new work only after a known-idle probe and expires abandoned drains", async () => {
    const { runtime, call, service } = fixture();
    expect(
      (await call("/v1/activity", "POST", { draining: true })).status,
    ).toBe(409);
    runtime.setActivityProvider(() => ({ active: false, nextWakeAt: null }));
    expect(
      (await call("/v1/activity", "POST", { draining: true })).status,
    ).toBe(200);
    await expect(service.open(config)).rejects.toThrow("runtime_draining");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 121_000);
    expect((await call("/v1/activity")).result.draining).toBe(false);
    clock.mockRestore();
    await call("/v1/activity", "POST", { draining: false });
    runtime.setActivityProvider(() => ({ active: true, nextWakeAt: null }));
    expect(
      (await call("/v1/activity", "POST", { draining: true })).status,
    ).toBe(409);
    expect((await call("/v1/activity", "GET", undefined, "wrong")).status).toBe(
      401,
    );
  });
  it("lists shared personal tasks while retaining separate chat routes and original task identity", async () => {
    const a = fixture();
    const runtime = a.createRuntime();
    const service = runtime.channelService();
    const first = await service.open(
      config,
      undefined,
      "first",
      "channel:dm:alice",
    );
    const other = await service.open(
      config,
      undefined,
      "second",
      "channel:dm:bob",
    );
    expect(service.history("channel:dm:alice").map((row) => row.id)).toEqual(
      expect.arrayContaining([first!.sessionId, other!.sessionId]),
    );
    expect(
      service.configuration("channel:dm:alice", other!.sessionId).model,
    ).toBe(config.model);
    expect(
      (await service.resume("channel:dm:bob", first!.sessionId)).sessionId,
    ).toBe(first!.sessionId);
    await expect(
      service.resume("channel:dm:bob", "another-employee-session"),
    ).rejects.toThrow("channel_session_not_found");
    expect(
      new SessionIndex(a.home).list().find((row) => row.id === first!.sessionId)
        ?.channelKey,
    ).toBe("channel:dm:alice");
  });
  it("continues a webpage task from IM without changing configuration, duplicating replies or taking over later webpage turns", async () => {
    vi.stubEnv("WORKAGENT_PUBLIC_BASE_URL", "https://workagent.example.com");
    const a = fixture();
    const send = vi.fn().mockResolvedValue(undefined);
    a.service.attachNotifications({
      targets: () => [
        {
          id: "chat",
          label: "微信",
          connected: true,
          channelId: "weixin",
          chatId: "chat",
          kind: "dm",
        },
      ],
      send,
    });
    await a.call("/v1/completion-notifications", "PUT", {
      enabled: true,
      targetId: "chat",
    });
    const created = await a.call("/v1/sessions", "POST", {
      engine: "codex",
      modelId: "gpt-test",
      title: "网页方案",
      workspace: "default",
      permissionMode: "read_only",
    });
    const id = created.result.id;
    const handle = await a.service.resume("weixin:dm:chat", id);
    expect(a.service.configuration("weixin:dm:chat", id).permissionPreset).toBe(
      "read-only",
    );
    const events: any[] = [];
    await handle.followup(
      { id: "im-input", content: [{ type: "text", text: "继续网页方案" }] },
      async (event) => {
        events.push(event);
      },
    );
    expect(events.some((event) => event.type === "turn/end")).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(
      new MessageStore(a.home)
        .list(id)
        .some((row) => row.text === "继续网页方案"),
    ).toBe(true);
    await handle.dispose();
    expect(native.close).not.toHaveBeenCalled();
    expect(native.cancel).not.toHaveBeenCalled();
    expect(a.service.activeChannel(id)).toBeUndefined();
    const count = events.length;
    await a.call(`/v1/sessions/${id}/turns`, "POST", { content: "网页继续" });
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(events).toHaveLength(count);
    expect(send.mock.calls.map(([, text]) => text).join("\n")).toContain(
      "当前聊天已关联到该任务，直接回复即可继续。",
    );
    expect(send.mock.calls.every(([, , sessionId]) => sessionId === id)).toBe(
      true,
    );
  });
  it("keeps the accepted chat's reply route when a second chat or webpage submits to the same running task", async () => {
    const a = fixture();
    const created = await a.call("/v1/sessions", "POST", {
      engine: "codex",
      modelId: "gpt-test",
      workspace: "default",
      title: "共同任务",
    });
    const id = created.result.id;
    const first = await a.service.resume("weixin:dm:first", id);
    const second = await a.service.resume("weixin:dm:second", id);
    let accept!: () => void;
    native.send.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          native.events!({ type: "turn.started", turnId: "busy-turn" });
          accept = () => {
            native.events!({
              type: "assistant.completed",
              turnId: "busy-turn",
              content: "only-first",
            });
            native.events!({ type: "turn.completed", turnId: "busy-turn" });
            resolve("busy-turn");
          };
        }),
    );
    const replies: any[] = [];
    const rejectedReplies: any[] = [];
    const pending = first.followup(
      { id: "first-input", content: [{ type: "text", text: "first" }] },
      async (event) => {
        replies.push(event);
      },
    );
    await vi.waitFor(() => expect(accept).toBeTypeOf("function"));
    await expect(
      second.followup(
        { id: "second-input", content: [{ type: "text", text: "second" }] },
        async (event) => {
          rejectedReplies.push(event);
        },
      ),
    ).rejects.toThrow("session_input_pending");
    expect(a.service.activeChannel(id)).toBe("weixin:dm:first");
    expect(
      (await a.call(`/v1/sessions/${id}/turns`, "POST", { content: "web" }))
        .status,
    ).toBe(409);
    accept();
    await pending;
    expect(
      replies.filter((event) => event.type === "assistant/message"),
    ).toHaveLength(1);
    expect(rejectedReplies).toHaveLength(0);
    expect(a.service.activeChannel(id)).toBeUndefined();
  });

  it("pushes a successful webpage turn through the connected IM transport with a downloadable artifact", async () => {
    vi.stubEnv("WORKAGENT_PUBLIC_BASE_URL", "https://workagent.example.com");
    const a = fixture();
    const endpoint = "/v1/completion-notifications";
    expect((await a.call(endpoint, "GET", undefined, "wrong")).status).toBe(
      401,
    );
    const send = vi.fn().mockResolvedValue(undefined);
    a.service.attachNotifications({
      targets: () => [
        {
          id: "chat",
          label: "飞书接收者",
          connected: true,
          channelId: "feishu",
          chatId: "chat",
          kind: "dm",
        },
      ],
      send,
    });
    expect(
      (
        await a.call(endpoint, "PUT", {
          enabled: true,
          targetId: "chat",
          baseURL: "https://client.example.com",
        })
      ).status,
    ).toBe(200);
    const created = await a.call("/v1/sessions", "POST", {
      engine: "codex",
      modelId: "gpt-test",
      title: "网页任务",
      workspace: "default",
      permissionMode: "read_only",
    });
    expect(created.status).toBe(201);
    a.workspaces.write("default", "result.txt", Buffer.from("artifact"));
    native.send.mockImplementationOnce(async () => {
      native.events!({ type: "turn.started", turnId: "notify-turn" });
      native.events!({
        type: "assistant.completed",
        turnId: "notify-turn",
        content: "已完成：[下载](result.txt)",
      });
      expect(send).not.toHaveBeenCalled();
      native.events!({ type: "turn.completed", turnId: "notify-turn" });
      return "notify-turn";
    });
    await a.call(`/v1/sessions/${created.result.id}/turns`, "POST", {
      content: "生成报告",
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls.map(([, text]) => text).join("\n")).toContain(
      "/content?path=result.txt",
    );
    await vi.waitFor(async () =>
      expect((await a.call(endpoint)).result.deliveries[0].status).toBe("sent"),
    );
    const count = send.mock.calls.length;
    native.events!({
      type: "turn.failed",
      turnId: "failed",
      message: "failure",
    });
    expect(send).toHaveBeenCalledTimes(count);
  });

  it("uses the selected engine/model/permission, enforces quota, and delivers the final reply once", async () => {
    const { home, service, quota } = fixture();
    const handle = (await service.open(config, undefined, "飞书会话"))!;
    expect(native.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({
        modelId: "gpt-test",
        thinkingEffort: "high",
        permissionMode: "read_only",
      }),
    );
    const reply = vi.fn().mockResolvedValue(undefined);
    await handle.followup(
      { id: "msg-1", content: [{ type: "text", text: "你好" }] },
      reply,
    );
    expect(quota.reserve).toHaveBeenCalledOnce();
    expect(reply.mock.calls.map(([event]) => event.type)).toEqual([
      "assistant/chunk",
      "assistant/message",
      "turn/end",
    ]);
    expect(new SessionIndex(home).list()[0]).toMatchObject({
      engine: "codex",
      modelId: "gpt-test",
      title: "飞书会话",
      nativeId: "native-thread",
    });
    expect(
      new MessageStore(home)
        .list(handle.sessionId)
        .map((row) => row.role)
        .sort(),
    ).toEqual(["assistant", "user"]);
  });

  it("resumes the persisted native thread after restart, and rotates when selection changes", async () => {
    const { service, createRuntime } = fixture();
    const first = (await service.open(config))!;
    await first.dispose();
    const restarted = createRuntime().channelService();
    expect(restarted.listSessionIds()).toContain(first.sessionId);
    const resumed = await restarted.open(config, first.sessionId);
    expect(resumed?.sessionId).toBe(first.sessionId);
    expect(native.resume).toHaveBeenCalledWith(
      "native-thread",
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ modelId: "gpt-test" }),
    );
    expect(
      await restarted.open(
        { ...config, provider: "workagent-kimi", model: "kimi-test" },
        first.sessionId,
      ),
    ).toBeUndefined();
    expect(
      await restarted.open(
        { ...config, permissionPreset: "workspace-write" },
        first.sessionId,
      ),
    ).toBeUndefined();
  });

  it("rejects quota failures before sending, then accepts a retry without leaked listeners", async () => {
    const { service, quota } = fixture();
    const handle = (await service.open(config))!;
    quota.reserve.mockRejectedValueOnce(new Error("quota_exceeded"));
    const failedReply = vi.fn();
    await expect(
      handle.followup(
        { id: "failed", content: [{ type: "text", text: "hello" }] },
        failedReply,
      ),
    ).rejects.toThrow("quota_exceeded");
    expect(native.send).not.toHaveBeenCalled();
    await handle.followup(
      { id: "retry", content: [{ type: "text", text: "hello" }] },
      vi.fn(),
    );
    expect(failedReply).not.toHaveBeenCalled();
  });

  it("exposes real native catalogs and rejects unavailable selections and custom permission presets", async () => {
    const { service } = fixture();
    expect(await service.models()).toMatchObject([
      { id: "workagent-harness", models: [] },
      { id: "workagent-codex", models: [{ id: "gpt-test" }] },
      { id: "workagent-kimi", models: [{ id: "kimi-test" }] },
    ]);
    await expect(
      service.open({ ...config, model: "invented" }),
    ).rejects.toThrow("channel_model_unavailable");
    await expect(
      service.open({ ...config, permissionPreset: "custom" }),
    ).rejects.toThrow("消息渠道请选择");
    const kimi = await service.open({
      provider: "workagent-kimi",
      model: "kimi-test",
      permissionPreset: "workspace-write",
    });
    expect(kimi?.sessionId).toMatch(/^session-channel-/);
    expect(native.create).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({
        modelId: "kimi-test",
        permissionMode: "workspace_write",
      }),
    );
  });
});
