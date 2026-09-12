import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, isAbsolute, relative } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { NativeSessionLog } from "./native-session-log.js";
import { FileMoves } from "./file-moves.js";
import { RuntimeController } from "./runtime.js";
import { SessionIndex } from "./session-index.js";
import { MessageStore } from "./message-store.js";
import { PresetStore } from "./preset-store.js";
import { ModelAccessStore } from "./model-access-store.js";
import { McpCatalogStore, SkillCatalogStore } from "./capability-store.js";
import type { BridgeEvent, EngineSessionOptions } from "./engines/types.js";
import { fileReferenceText } from "@workagent/contracts";
import { automationDefinitionSchema } from "@workagent/contracts";
import { QuotaAutomationRunner } from "./quota-runner.js";
import { ManagedAcpCatalog } from "./acp-catalog.js";
import { CodexBridge } from "./engines/codex.js";

const native = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; content?: string; lastTurnId?: string }>,
  emit: (_event: BridgeEvent) => {},
  sequence: 0,
  rejectSteer: false,
  rejectSend: false,
  rejectQuota: false,
  sendGate: undefined as Promise<void> | undefined,
  reserveGate: undefined as Promise<void> | undefined,
  settlements: [] as string[],
  reservedModels: [] as string[],
  catalogGate: undefined as Promise<void> | undefined,
  catalogReads: 0,
  resumedOptions: [] as unknown[],
  resumedIDs: [] as string[],
  sessions: [] as Array<{ nativeId: string; connected: boolean }>,
  createdOptions: [] as EngineSessionOptions[],
  resumeError: undefined as string | undefined,
  resumeGate: undefined as Promise<void> | undefined,
}));
vi.mock("./engines/codex.js", () => ({
  CodexBridge: class {
    async listModels() {
      native.catalogReads += 1;
      await native.catalogGate;
      return [{ id: "gpt-test", name: "Test", isDefault: true, reasoning: [] }];
    }
    async create(
      _workspace: string,
      emit: typeof native.emit,
      options: EngineSessionOptions,
    ) {
      native.calls.push({ method: "create" });
      native.createdOptions.push(options);
      return this.session(emit);
    }
    async resume(
      _id: string,
      _workspace: string,
      emit: typeof native.emit,
      options?: unknown,
    ) {
      native.resumedOptions.push(options);
      native.resumedIDs.push(_id);
      await native.resumeGate;
      if (native.resumeError) throw new Error(native.resumeError);
      return this.session(emit);
    }
    async fork(
      _id: string,
      _workspace: string,
      emit: typeof native.emit,
      _options: unknown,
      lastTurnId?: string,
    ) {
      native.calls.push({
        method: "fork",
        ...(lastTurnId ? { lastTurnId } : {}),
      });
      return this.session(emit);
    }
    session(emit: typeof native.emit) {
      native.emit = emit;
      const session = {
        nativeId: `native-${++native.sequence}`,
        connected: true,
        permissionMode: "workspace_write" as const,
        send: async (content: string) => {
          if (native.rejectSend) throw new Error("send rejected");
          native.calls.push({ method: "send", content });
          emit({ type: "turn.started", turnId: "active" });
          await native.sendGate;
          return "active";
        },
        steer: async (content: string) => {
          if (native.rejectSteer) throw new Error("closed window");
          native.calls.push({ method: "steer", content });
          return "active";
        },
        cancel: async () => {
          native.calls.push({ method: "cancel" });
          emit({ type: "turn.cancelled", turnId: "active" });
        },
        close: async () => {
          native.emit = () => {};
        },
      };
      native.sessions.push(session);
      return session;
    }
    async close() {}
  },
}));
vi.mock("./engines/kimi.js", async () => {
  const { CodexBridge } = await import("./engines/codex.js");
  return { KimiBridge: CodexBridge };
});

const roots: string[] = [];
it("freezes ACP version and billing, rejects mismatched presets, and permits cancellation after administrator disable", async () => {
  const entry = {
    id: "approved",
    label: "Approved",
    packageRef: "packages/agent",
    revision: "v1",
    command: "agent.exe",
    args: [],
    credentialFields: [],
    billingModelId: "fixed-billing",
    enabled: true,
  };
  let enabled = true,
    latest = "v1";
  const resolve = vi
    .spyOn(ManagedAcpCatalog.prototype, "resolve")
    .mockImplementation(async (id, revision) => {
      if (!enabled) throw new Error("acp_catalog_disabled");
      if (id !== entry.id) throw new Error("acp_catalog_not_found");
      return { ...entry, revision: revision ?? latest };
    });
  const bridge = vi
    .spyOn(ManagedAcpCatalog.prototype, "bridge")
    .mockResolvedValue(new CodexBridge() as never);
  const f = await fixture();
  try {
    const preset = f.presets.create({
      name: "ACP",
      engine: "acp",
      acpCatalogId: "approved",
    } as never);
    const body = {
      engine: "acp",
      acpCatalogId: "approved",
      presetId: preset.id,
      title: "ACP task",
      workspace: "default",
      modelId: "display-model",
    };
    const mismatch = await f.call("", { ...body, acpCatalogId: "other" });
    expect(mismatch.status).toBe(409);
    const created = await f.call("", body);
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({
      engine: "acp",
      acpCatalogId: "approved",
      acpCatalogRevision: "v1",
    });
    latest = "v2";
    const forked = await f.call(`/${created.data.id}/side-chat`, {});
    expect(forked.status).toBe(201);
    expect(forked.data).toMatchObject({
      engine: "acp",
      acpCatalogId: "approved",
      acpCatalogRevision: "v1",
      acpSnapshot: { billingModelId: "fixed-billing" },
    });
    await f.runtime.nativeSessionPort.prompt(
      created.data.id,
      "hello",
      "queue",
      "acp-input",
    );
    expect(native.reservedModels.at(-1)).toBe("fixed-billing");
    expect(resolve).toHaveBeenLastCalledWith("approved", "v1");
    enabled = false;
    const cancelled = await f.call(`/${created.data.id}/cancel`, {});
    expect(cancelled.status).toBe(204);
    await expect(
      f.runtime.nativeSessionPort.prompt(
        created.data.id,
        "new",
        "queue",
        "acp-disabled",
      ),
    ).rejects.toThrow("acp_catalog_disabled");
    expect(
      new SessionIndex(f.home).list().find((row) => row.id === created.data.id),
    ).toMatchObject({
      acpCatalogRevision: "v1",
      acpSnapshot: { billingModelId: "fixed-billing" },
    });
  } finally {
    await f.close();
    resolve.mockRestore();
    bridge.mockRestore();
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  native.calls.length = 0;
  native.rejectSteer = false;
  native.rejectSend = false;
  native.rejectQuota = false;
  native.sendGate = undefined;
  native.reserveGate = undefined;
  native.settlements.length = 0;
  native.reservedModels.length = 0;
  native.catalogGate = undefined;
  native.catalogReads = 0;
  native.resumedOptions.length = 0;
  native.resumedIDs.length = 0;
  native.sessions.length = 0;
  native.createdOptions.length = 0;
  native.resumeError = undefined;
  native.resumeGate = undefined;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture(
  engine = "codex" as "codex" | "kimi",
  existingHome?: string,
  options: { canonical?: boolean; blank?: boolean; parent?: string } = {},
) {
  const home =
    existingHome ?? mkdtempSync(join(tmpdir(), "workagent-chat-controls-"));
  if (!existingHome) roots.push(home);
  vi.stubEnv("DSH_HOME", home);
  const mcp = new McpCatalogStore(),
    skills = new SkillCatalogStore();
  const presets = new PresetStore(
    home,
    new ModelAccessStore(home),
    skills,
    mcp,
  );
  const messages = new MessageStore(home);
  if (!existingHome) {
    new SessionIndex(home).set({
      id: "session-source",
      nativeId: "native-source",
      engine,
      title: "Source",
      workspaceId: "default",
      preset: presets.resolve(`builtin-${engine}`),
      createdAt: "2026-09-06T00:00:00Z",
      updatedAt: "2026-09-06T00:00:00Z",
      ...(options.parent ? { parentSessionId: options.parent } : {}),
    });
    for (const [index, text] of (options.blank
      ? []
      : [
          "remember amber",
          "ack amber",
          "wrong request",
          "wrong answer",
          "later secret",
        ]
    ).entries()) {
      messages.append({
        id: `m${index}`,
        sessionId: "session-source",
        role: index % 2 === 0 ? "user" : "assistant",
        text,
        nativeTurnId: `t${Math.floor(index / 2)}`,
        createdAt: "2026-09-06T00:00:00Z",
      });
    }
  }
  let handler: (req: IncomingMessage, res: ServerResponse) => unknown;
  const ctx = {
    effect: (callback: () => unknown) => callback(),
    on: () => () => {},
    webServer: {
      register: (route: { path: string; handler: typeof handler }) => {
        if (route.path === "/v1/sessions") handler = route.handler;
        return () => {};
      },
    },
  } as unknown as Context;
  const logContext = options.canonical ? new Context() : undefined;
  if (logContext) new SessionStore(logContext);
  const log = logContext ? new NativeSessionLog(logContext, home) : undefined;
  const moves = new FileMoves(
    join(home, "test-file-moves.json"),
    (_id, path) => join(home, path),
    () => {},
  );
  const runtime = new RuntimeController(
    ctx,
    "test-token",
    {
      moves,
      engineRoot: () => home,
      referencePath: (_id: string, path: string) => join(home, path),
      locate: (id: string, reference: string) => {
        const path = isAbsolute(reference)
          ? relative(home, reference)
          : reference;
        statSync(join(home, path));
        return {
          path,
          name: basename(path),
          fileId: moves.identify(id, path),
          kind: "file",
        };
      },
      listAssets: () => [],
      registerArtifact: () => {},
    } as never,
    presets,
    mcp,
    skills,
    { statusFor: () => ({ state: "ready" }) } as never,
    {
      reserve: async (request) => {
        native.reservedModels.push(request.modelId);
        if (native.rejectQuota) throw new Error("quota_exceeded");
        native.calls.push({ method: "reserve" });
        await native.reserveGate;
        return { status: "reserved" } as never;
      },
      settle: async ({ runId }: { runId: string }) => {
        native.settlements.push(runId);
      },
    },
    log,
  );
  runtime.mount();
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const call = async (path: string, body?: unknown, method?: string) => {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/sessions${path}`,
      {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return {
      status: response.status,
      data: response.status === 204 ? undefined : await response.json(),
    };
  };
  return {
    runtime,
    moves,
    mcp,
    skills,
    presets,
    home,
    messages,
    log,
    call,
    remove: async (id: string) =>
      (
        await fetch("http://127.0.0.1:" + address.port + "/v1/sessions/" + id, {
          method: "DELETE",
          headers: { authorization: "Bearer test-token" },
        })
      ).status,
    close: async () => {
      await log?.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("cancels a background execution while the native session is still activating without sending it", async () => {
  const f = await fixture();
  let release!: () => void;
  native.resumeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const definition = automationDefinitionSchema.parse({
    id: "automation-cancel",
    version: 1,
    name: "Cancelled",
    enabled: false,
    schedule: { kind: "interval", everyMinutes: 1 },
    presetId: "builtin-codex",
    engine: "codex",
    workspaceId: "default",
    input: "Must never send",
    executionMode: "existing",
    conversationId: "session-source",
    notificationPolicy: "none",
    nextRunAt: null,
    lastRunAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  try {
    const pending = f.runtime.execute({
      automationRunId: "cancel-before-submit",
      definition,
    });
    const rejected = expect(pending).rejects.toThrow(
      "background_execution_cancelled",
    );
    await vi.waitFor(() => expect(native.resumedIDs.length).toBe(1));
    const cancelled = f.runtime.cancel("cancel-before-submit");
    release();
    await cancelled;
    await rejected;
    expect(native.calls.some((call) => call.method === "send")).toBe(false);
  } finally {
    release();
    await f.close();
  }
});

it("keeps a busy automation out of quota and binds its result to its own submitted turn", async () => {
  const f = await fixture();
  const definition = automationDefinitionSchema.parse({
    id: "automation-precise",
    version: 1,
    name: "Followup",
    enabled: false,
    schedule: { kind: "interval", everyMinutes: 1 },
    presetId: "builtin-codex",
    engine: "codex",
    workspaceId: "default",
    input: "Scheduled question",
    executionMode: "existing",
    conversationId: "session-source",
    notificationPolicy: "none",
    nextRunAt: null,
    lastRunAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const reserve = vi.fn(async () => ({ status: "reserved" as const }));
  const settle = vi.fn(async () => {});
  const runner = new QuotaAutomationRunner(f.runtime, f.presets, {
    reserve,
    settle,
  } as never);
  try {
    await f.runtime.nativeSessionPort.prompt(
      "session-source",
      "User work",
      "queue",
    );
    await expect(
      runner.execute({ automationRunId: "busy-run", definition }),
    ).rejects.toThrow("session_busy");
    expect(reserve).not.toHaveBeenCalled();
    native.emit({ type: "turn.completed", turnId: "active" });
    await vi.waitFor(() =>
      expect(
        f.runtime.nativeSessionPort
          .list()
          .find((session) => session.id === "session-source")?.activity?.state,
      ).toBe("idle"),
    );
    const submitted = vi.fn();
    let finished = false;
    const pending = runner
      .execute({
        automationRunId: "precise-run",
        definition,
        onSubmitted: submitted,
      })
      .then((result) => {
        finished = true;
        return result;
      });
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledWith("active"));
    native.emit({
      type: "assistant.completed",
      turnId: "old-turn",
      content: "Wrong answer",
    });
    native.emit({ type: "turn.completed", turnId: "old-turn" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    native.emit({
      type: "assistant.completed",
      turnId: "active",
      content: "Scheduled answer",
    });
    native.emit({ type: "turn.completed", turnId: "active" });
    await expect(pending).resolves.toMatchObject({
      result: "Scheduled answer",
      sessionId: "session-source",
    });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(
      f.messages
        .list("session-source")
        .some((message) => message.text === "Scheduled question"),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

it("IM steering targets the bound ordinary task and cannot control a collaboration session", async () => {
  const f = await fixture();
  try {
    const service = f.runtime.channelService();
    await expect(
      service.steer("chat", "session-source", "early"),
    ).rejects.toThrow("no_active_turn");
    expect(
      (await f.call("/session-source/turns", { content: "work" })).status,
    ).toBe(202);
    await service.steer("chat", "session-source", "Add a chart");
    expect(native.calls).toContainEqual({
      method: "steer",
      content: "Add a chart",
    });
    expect(f.messages.list("session-source").map((m) => m.text)).toContain(
      "Add a chart",
    );
    await expect(
      service.steer("chat", "collaboration:discussion-1", "blocked"),
    ).rejects.toThrow("channel_session_not_found");
    await service.cancel("chat", "session-source");
    expect(native.calls.some((c) => c.method === "cancel")).toBe(true);
  } finally {
    await f.close();
  }
});

it("keeps each shared assistant session and resumes its native history when settings change", async () => {
  let f = await fixture();
  const home = f.home;
  const request = {
    runId: "shared-multiple-run-0001",
    conversationId: "shared-multiple-conversation",
    projectId: "shared-multiple-project",
    engine: "codex" as const,
    assistantId: "builtin-codex",
    sessionKey: "session-shared-assistant-a",
    modelId: "gpt-test",
    thinkingEffort: "low" as const,
    context: "First group interval",
    recoveryContext: "Whole group history",
    workspacePath: home,
    payerSid: "S-1-5-21-test",
  };
  const turn = async (
    value: Parameters<typeof f.runtime.executeSharedTurn>[0],
  ) => {
    const count = native.calls.filter((c) => c.method === "send").length;
    const pending = f.runtime.executeSharedTurn(value);
    await vi.waitFor(() =>
      expect(native.calls.filter((c) => c.method === "send")).toHaveLength(
        count + 1,
      ),
    );
    native.emit({ type: "turn.completed", turnId: "active" });
    return pending;
  };
  try {
    await turn(request);
    const a = new SessionIndex(home)
      .list()
      .find((s) => s.id === request.sessionKey)!;
    f.messages.append({
      id: "shared-history-marker",
      sessionId: request.sessionKey,
      role: "assistant",
      text: "Remember our group plan",
      createdAt: new Date().toISOString(),
    });
    await turn({
      ...request,
      runId: "shared-multiple-run-0002",
      assistantId: "builtin-kimi",
      engine: "kimi",
      sessionKey: "session-shared-assistant-b",
    });
    const b = new SessionIndex(home)
      .list()
      .find((s) => s.id === "session-shared-assistant-b")!;
    expect(a.nativeId).not.toBe(b.nativeId);
    const creates = native.createdOptions.length;
    await turn({
      ...request,
      runId: "shared-multiple-run-0003",
      thinkingEffort: "high",
      modelId: "gpt-next",
      context: "Second interval including Kimi reply",
    });
    expect(native.resumedIDs.at(-1)).toBe(a.nativeId);
    expect(native.resumedOptions.at(-1)).toMatchObject({
      modelId: "gpt-next",
      thinkingEffort: "high",
    });
    expect(native.createdOptions).toHaveLength(creates);
    expect(
      f.messages
        .list(request.sessionKey)
        .some((m) => m.id === "shared-history-marker"),
    ).toBe(true);
    await expect(
      f.runtime.executeSharedTurn({
        ...request,
        runId: "shared-multiple-run-0004",
        assistantId: "builtin-kimi",
        engine: "kimi",
      }),
    ).rejects.toThrow("shared_turn_assistant_identity_mismatch");
    const updated = new SessionIndex(home)
      .list()
      .find((s) => s.id === request.sessionKey)!;
    await f.close();
    f = await fixture("codex", home);
    await turn({
      ...request,
      runId: "shared-multiple-run-0005",
      thinkingEffort: "high",
      modelId: "gpt-next",
    });
    expect(native.resumedIDs.at(-1)).toBe(updated.nativeId);
    expect(native.createdOptions).toHaveLength(creates);
    expect(
      f.messages
        .list(request.sessionKey)
        .some((m) => m.id === "shared-history-marker"),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

it("re-activates a shared assistant session after the native process disconnects", async () => {
  const f = await fixture();
  const request = {
    runId: "shared-zombie-run-0001",
    conversationId: "shared-zombie-conversation",
    projectId: "shared-zombie-project",
    engine: "codex" as const,
    assistantId: "builtin-codex",
    sessionKey: "session-shared-zombie",
    modelId: "gpt-test",
    thinkingEffort: "low" as const,
    context: "Group interval",
    recoveryContext: "Whole group history",
    workspacePath: f.home,
    payerSid: "S-1-5-21-test",
  };
  const turn = async (runId: string) => {
    const count = native.calls.filter((c) => c.method === "send").length;
    const pending = f.runtime.executeSharedTurn({ ...request, runId });
    await vi.waitFor(() =>
      expect(native.calls.filter((c) => c.method === "send")).toHaveLength(
        count + 1,
      ),
    );
    native.emit({ type: "turn.completed", turnId: "active" });
    return pending;
  };
  try {
    await turn("shared-zombie-run-0001");
    const zombie = native.sessions.at(-1)!;
    // The engine process died: the bridge flags the session disconnected.
    zombie.connected = false;
    await turn("shared-zombie-run-0002");
    expect(native.resumedIDs).toEqual([zombie.nativeId]);
  } finally {
    await f.close();
  }
});

it("reloads global capabilities into an idle native session without replacing history", async () => {
  const f = await fixture();
  try {
    const before = f.messages.list("session-source");
    f.skills.replace({
      skills: [
        {
          root: join(f.home, "shared"),
          entry: {
            id: "global-fixture",
            name: "global-fixture",
            description: "Fixture",
            version: "1",
            source: "user",
            enabled: true,
            relativePath: "global-fixture/fixture",
            referenceDirectory: join(f.home, "source"),
            requiredMcpServerIds: [],
            requiredCommands: [],
            health: "ready",
          },
        },
      ],
    });
    const reloaded = await f.call("/session-source/capabilities/reload", {});
    expect(reloaded.status).toBe(200);
    expect(reloaded.data.preset.resolvedSnapshot.skillIds).toEqual([
      "global-fixture",
    ]);
    expect(native.resumedOptions.at(-1)).toMatchObject({
      skills: [{ entry: { id: "global-fixture" } }],
    });
    expect(f.messages.list("session-source")).toEqual(before);
    native.emit({ type: "turn.started", turnId: "running" });
    expect(
      (await f.call("/session-source/capabilities/reload", {})).status,
    ).toBe(409);
  } finally {
    await f.close();
  }
});

it.each(["kimi", "codex"] as const)(
  "cancels hidden shared %s approvals on create and resume without leaving pending interactions",
  async (engine) => {
    let f = await fixture(engine);
    const home = f.home;
    const request = {
      runId: "shared-approval-run-1",
      conversationId: "shared-approval-conversation",
      projectId: "shared-approval-project",
      engine,
      modelId: "gpt-test",
      thinkingEffort: "low" as const,
      context: "Perform a task needing permission",
      recoveryContext: "Continue the shared task",
      workspacePath: home,
      payerSid: "S-1-5-21-test",
    };
    try {
      for (const resumed of [false, true]) {
        if (resumed) {
          await f.close();
          f = await fixture(engine, home);
        }
        const execution = f.runtime.executeSharedTurn({
          ...request,
          runId: request.runId + String(resumed),
        });
        const signal = new AbortController();
        try {
          await vi.waitFor(() =>
            expect(
              native.calls.filter((call) => call.method === "send"),
            ).toHaveLength(resumed ? 2 : 1),
          );
          const options = (
            resumed
              ? native.resumedOptions.at(-1)
              : native.createdOptions.at(-1)
          ) as EngineSessionOptions;
          expect(options.requestApproval).toBeTypeOf("function");
          let decision:
            | Awaited<
                ReturnType<NonNullable<EngineSessionOptions["requestApproval"]>>
              >
            | undefined;
          const approval = options.requestApproval!({
            turnId: "active",
            tool: "Shell",
            summary: "Run a shared task command",
            signal: signal.signal,
          }).then((value) => {
            decision = value;
          });
          await vi.waitFor(() => expect(decision).toBe("cancel"), {
            timeout: 100,
          });
          await approval;
          expect(f.runtime.nativeSessionPort.approvals()).toEqual([]);
          expect(
            f.runtime.nativeSessionPort.owns(
              "session-shared-" + request.conversationId,
            ),
          ).toBe(false);
        } finally {
          signal.abort();
          native.emit({ type: "turn.completed", turnId: "active" });
          await execution;
        }
      }
    } finally {
      await f.close();
    }
  },
);

it("standard native prompts retain quota admission and never bypass a denied reservation", async () => {
  const f = await fixture();
  try {
    native.rejectQuota = true;
    await expect(
      f.runtime.nativeSessionPort.prompt("session-source", "hello", "queue"),
    ).rejects.toThrow("quota_exceeded");
    expect(native.calls.filter((call) => call.method === "send")).toEqual([]);
    native.rejectQuota = false;
    await f.runtime.nativeSessionPort.prompt(
      "session-source",
      "hello",
      "queue",
    );
    expect((await f.call("/session-source/messages")).data.at(-1).text).toBe(
      "hello",
    );
    await f.runtime.nativeSessionPort.cancel("session-source");
    expect((await f.call("/session-source")).data.activity.state).toBe("idle");
  } finally {
    await f.close();
  }
});

it("does not resume or report a model selection accepted after deletion during model discovery", async () => {
  const f = await fixture();
  let release!: () => void;
  native.catalogGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const selecting = f.runtime.nativeSessionPort.selectModel(
      "session-source",
      { provider: "codex", model: "gpt-test" },
    );
    await vi.waitFor(() => expect(native.catalogReads).toBe(1));
    expect(await f.remove("session-source")).toBe(204);
    release();
    await expect(selecting).rejects.toThrow("session_not_found");
    expect(native.resumedOptions).toEqual([]);
    expect(new SessionIndex(f.home).list()).toEqual([]);
  } finally {
    release();
    await f.close();
  }
});

it("enforces the frozen preset policy without rewriting a legacy session's absent override", async () => {
  const f = await fixture();
  try {
    const before = new SessionIndex(f.home).list()[0]?.permissionMode;
    expect(before).toBeUndefined();
    expect((await f.call("/session-source/configuration")).data).toEqual({
      permissionMode: "workspace_write",
    });
    expect(new SessionIndex(f.home).list()[0]?.permissionMode).toBeUndefined();
    expect(native.resumedOptions.at(-1)).toMatchObject({
      permissionMode: "workspace_write",
      approvalPolicy: "on_risk",
      requirePermission: true,
    });
    expect(
      native.calls.some(
        (call) => call.method === "send" || call.method === "reserve",
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

it("updates real native permissions only after resume accepts them and preserves the old setting on failure", async () => {
  const f = await fixture();
  try {
    expect(
      (
        await f.call(
          "/session-source/configuration",
          { permissionMode: "read_only" },
          "PATCH",
        )
      ).status,
    ).toBe(200);
    expect(native.resumedOptions.at(-1)).toMatchObject({
      permissionMode: "read_only",
      requirePermission: true,
    });
    expect(new SessionIndex(f.home).list()[0]?.permissionMode).toBe(
      "read_only",
    );
    native.resumeError = "engine_permission_unavailable";
    expect(
      (
        await f.call(
          "/session-source/configuration",
          { permissionMode: "full_access" },
          "PATCH",
        )
      ).status,
    ).toBe(409);
    expect(new SessionIndex(f.home).list()[0]?.permissionMode).toBe(
      "read_only",
    );
    expect(
      native.calls.some(
        (call) => call.method === "send" || call.method === "reserve",
      ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

it("applies idle model selection to native resume without invoking a prompt or quota reservation", async () => {
  const f = await fixture();
  try {
    await expect(
      f.runtime.nativeSessionPort.selectModel("session-source", {
        provider: "codex",
        model: "gpt-test",
      }),
    ).resolves.toEqual({ provider: "codex", model: "gpt-test" });
    expect(native.resumedOptions).toHaveLength(1);
    expect(native.resumedOptions[0]).toMatchObject({ modelId: "gpt-test" });
    expect(
      native.calls.some(
        (call) => call.method === "send" || call.method === "reserve",
      ),
    ).toBe(false);
    expect(new SessionIndex(f.home).list()[0]?.modelId).toBe("gpt-test");
  } finally {
    await f.close();
  }
});

it("recreates only the missing nondurable Codex thread when selecting a model on a proven blank session", async () => {
  const f = await fixture("codex", undefined, { canonical: true, blank: true });
  native.resumeError = "no rollout found for thread id native-source";
  try {
    await expect(
      f.runtime.nativeSessionPort.selectModel("session-source", {
        provider: "codex",
        model: "gpt-test",
      }),
    ).resolves.toEqual({ provider: "codex", model: "gpt-test" });
    expect(native.createdOptions).toHaveLength(1);
    expect(native.createdOptions[0]).toMatchObject({ modelId: "gpt-test" });
    expect(native.calls.map((call) => call.method)).toEqual(["create"]);
    const saved = new SessionIndex(f.home)
      .list()
      .find((row) => row.id === "session-source")!;
    expect(saved.nativeId).not.toBe("native-source");
    expect(saved.modelId).toBe("gpt-test");
    expect(f.log!.messages("session-source")).toEqual([]);
    expect(
      f
        .log!.get("session-source")!
        .events.some((event) => event.type === "turn/start"),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

it.each(["nonempty", "started", "parent", "unproven", "other-error", "kimi"])(
  "does not replace a missing native thread for %s history",
  async (kind) => {
    const engine = kind === "kimi" ? "kimi" : "codex";
    const f = await fixture(engine, undefined, {
      canonical: kind !== "unproven",
      blank: kind !== "nonempty",
      ...(kind === "parent" ? { parent: "session-parent" } : {}),
    });
    if (kind === "started")
      f.log!.get("session-source")!.append("turn/start", { turn: 0 });
    native.resumeError =
      kind === "other-error"
        ? "engine disconnected"
        : "no rollout found for thread id native-source";
    try {
      await expect(
        f.runtime.nativeSessionPort.selectModel("session-source", {
          provider: engine,
          model: "gpt-test",
        }),
      ).rejects.toThrow(native.resumeError);
      expect(native.createdOptions).toEqual([]);
      expect(
        new SessionIndex(f.home)
          .list()
          .find((row) => row.id === "session-source")!.nativeId,
      ).toBe("native-source");
    } finally {
      await f.close();
    }
  },
);

it("drains queued input when completion arrives before the native send acknowledgement", async () => {
  const f = await fixture();
  let acknowledge!: () => void;
  native.sendGate = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  try {
    const first = f.runtime.nativeSessionPort.prompt(
      "session-source",
      "first",
      "queue",
    );
    await vi.waitFor(() =>
      expect(native.calls.some((call) => call.method === "send")).toBe(true),
    );
    await f.runtime.nativeSessionPort.prompt(
      "session-source",
      "second",
      "queue",
    );
    native.emit({ type: "turn.completed", turnId: "active" });
    // Let the completion-triggered queue drain run while admission is reserved.
    await new Promise((resolve) => setTimeout(resolve, 20));
    acknowledge();
    await first;
    await vi.waitFor(() =>
      expect(
        native.calls
          .filter((call) => call.method === "send")
          .map((call) => call.content),
      ).toEqual(["first", "second"]),
    );
  } finally {
    acknowledge();
    await f.close();
  }
});

it("deduplicates native retries by receipt identity across acceptance, queueing and restart", async () => {
  const f = await fixture();
  try {
    await f.runtime.nativeSessionPort.prompt(
      "session-source",
      "same text",
      "queue",
      "receipt-a",
    );
    await f.runtime.nativeSessionPort.prompt(
      "session-source",
      "same text",
      "queue",
      "receipt-a",
    );
    expect(native.calls.filter((row) => row.method === "send")).toHaveLength(1);
    await f.runtime.nativeSessionPort.prompt(
      "session-source",
      "same text",
      "queue",
      "receipt-b",
    );
    await f.runtime.nativeSessionPort.prompt(
      "session-source",
      "same text",
      "queue",
      "receipt-b",
    );
    expect((await f.call("/session-source/queue")).data).toHaveLength(1);
    await expect(
      f.runtime.nativeSessionPort.prompt(
        "session-source",
        "different text",
        "queue",
        "receipt-a",
      ),
    ).rejects.toThrow("message_id_conflict");
    await f.runtime.nativeSessionPort.cancel("session-source");
    await f.close();
    const restored = await fixture("codex", f.home);
    try {
      const before = native.calls.filter((row) => row.method === "send").length;
      await restored.runtime.nativeSessionPort.prompt(
        "session-source",
        "same text",
        "queue",
        "receipt-a",
      );
      expect(native.calls.filter((row) => row.method === "send")).toHaveLength(
        before,
      );
      expect(
        (await restored.call("/session-source/messages")).data.filter(
          (row: { id: string }) => row.id === "receipt-a",
        ),
      ).toHaveLength(1);
    } finally {
      await restored.close();
    }
  } finally {
    await f.close();
  }
});

it("retries a rejected native receipt with its original identity", async () => {
  const f = await fixture();
  try {
    native.rejectSend = true;
    await expect(
      f.runtime.nativeSessionPort.prompt(
        "session-source",
        "retry me",
        "queue",
        "retry-receipt",
      ),
    ).rejects.toThrow("engine_turn_rejected");
    expect(
      (await f.call("/session-source/messages")).data.some(
        (row: { id: string }) => row.id === "retry-receipt",
      ),
    ).toBe(false);
    native.rejectSend = false;
    await f.runtime.nativeSessionPort.prompt(
      "session-source",
      "retry me",
      "queue",
      "retry-receipt",
    );
    expect(
      (await f.call("/session-source/messages")).data.filter(
        (row: { id: string }) => row.id === "retry-receipt",
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("standard native queue edits retain the existing FIFO and hidden identities are refused", async () => {
  const f = await fixture("kimi");
  try {
    await f.runtime.nativeSessionPort.prompt(
      "session-source",
      "running",
      "queue",
    );
    await f.runtime.nativeSessionPort.prompt(
      "session-source",
      "queued",
      "queue",
    );
    const queued = (await f.call("/session-source/queue")).data[0];
    await f.runtime.nativeSessionPort.updateQueue(
      "session-source",
      queued.messageId,
      { kind: "edit", content: [{ type: "text", text: "revised" }] },
    );
    expect((await f.call("/session-source/queue")).data[0].content).toBe(
      "revised",
    );
    await expect(
      f.runtime.nativeSessionPort.prompt("session-unknown", "denied", "queue"),
    ).rejects.toThrow("session_not_found");
    await f.runtime.nativeSessionPort.cancel("session-source");
    expect((await f.call("/session-source/queue")).data[0].content).toBe(
      "revised",
    );
  } finally {
    await f.close();
  }
});

it("resolves file atoms for native sends and side chats while retaining canonical references in history and edited queues", async () => {
  const f = await fixture();
  const reference = fileReferenceText({
    workspaceId: "default",
    path: "三七互娱.docx",
    name: "三七互娱.docx",
  });
  try {
    await f.runtime.nativeSessionPort.prompt(
      "session-source",
      reference,
      "queue",
    );
    expect(native.calls.find((call) => call.method === "send")?.content).toBe(
      `项目文件：${JSON.stringify(join(f.home, "三七互娱.docx"))}`,
    );
    expect(f.messages.list("session-source").at(-1)?.text).toBe(reference);
    await f.runtime.nativeSessionPort.prompt(
      "session-source",
      `等待 ${reference}`,
      "queue",
    );
    const queued = (await f.call("/session-source/queue")).data[0];
    await f.runtime.nativeSessionPort.updateQueue(
      "session-source",
      queued.messageId,
      { kind: "edit", content: [{ type: "text", text: `编辑 ${reference}` }] },
    );
    expect((await f.call("/session-source/queue")).data[0].content).toBe(
      `编辑 ${reference}`,
    );
    native.emit({ type: "turn.completed", turnId: "active" });
    await vi.waitFor(() =>
      expect(
        native.calls.filter((call) => call.method === "send").at(-1)?.content,
      ).toBe(`编辑 项目文件：${JSON.stringify(join(f.home, "三七互娱.docx"))}`),
    );
    const side = await f.call("/session-source/side-chat", {});
    await f.call(`/${side.data.id}/turns`, { content: reference });
    expect(f.messages.list(side.data.id).at(-1)?.text).toBe(reference);
    expect(
      native.calls.filter((call) => call.method === "send").at(-1)?.content,
    ).toContain(JSON.stringify(join(f.home, "三七互娱.docx")));
  } finally {
    await f.close();
  }
});

it("does not restore a deleted side chat when an in-flight send finishes", async () => {
  const f = await fixture();
  let finishSend!: () => void;
  native.sendGate = new Promise<void>((resolve) => {
    finishSend = resolve;
  });
  try {
    const side = await f.call("/session-source/side-chat", {});
    const sending = f.call("/" + side.data.id + "/turns", {
      content: "pending input",
    });
    await vi.waitFor(() =>
      expect(native.calls.some((row) => row.method === "send")).toBe(true),
    );
    expect(await f.remove(side.data.id)).toBe(204);
    await vi.waitFor(() => expect(native.settlements).toHaveLength(1));
    expect(
      JSON.parse(
        readFileSync(
          join(f.home, "workagent", "conversation-quota.json"),
          "utf8",
        ),
      ),
    ).toEqual([]);
    finishSend();
    await sending;
    expect(
      new SessionIndex(f.home).list().some((row) => row.id === side.data.id),
    ).toBe(false);
    expect(f.messages.list(side.data.id)).toEqual([]);
    const restarted = await fixture("codex", f.home);
    try {
      expect((await restarted.call("/" + side.data.id)).status).toBe(404);
    } finally {
      await restarted.close();
    }
  } finally {
    finishSend();
    await f.close();
  }
});

it("waits for an uncertain quota reservation before releasing a deleted side chat", async () => {
  const f = await fixture();
  let finishReserve!: () => void;
  native.reserveGate = new Promise<void>((resolve) => {
    finishReserve = resolve;
  });
  try {
    const side = await f.call("/session-source/side-chat", {});
    const sending = f.call("/" + side.data.id + "/turns", {
      content: "pending reservation",
    });
    await vi.waitFor(() =>
      expect(native.calls.some((row) => row.method === "reserve")).toBe(true),
    );
    expect(await f.remove(side.data.id)).toBe(204);
    expect(native.settlements).toEqual([]);
    finishReserve();
    await sending;
    await vi.waitFor(() => expect(native.settlements).toHaveLength(1));
    expect(
      JSON.parse(
        readFileSync(
          join(f.home, "workagent", "conversation-quota.json"),
          "utf8",
        ),
      ),
    ).toEqual([]);
    const restarted = await fixture("codex", f.home);
    try {
      expect((await restarted.call("/" + side.data.id)).status).toBe(404);
    } finally {
      await restarted.close();
    }
  } finally {
    finishReserve();
    await f.close();
  }
});

it("does not recreate deleted messages from late native events", async () => {
  const f = await fixture();
  try {
    const side = await f.call("/session-source/side-chat", {});
    await f.call("/" + side.data.id + "/turns", { content: "sent input" });
    const emit = native.emit;
    expect(await f.remove(side.data.id)).toBe(204);
    emit({
      type: "assistant.completed",
      turnId: "active",
      content: "late reply",
    });
    emit({ type: "turn.completed", turnId: "active" });
    expect(f.messages.list(side.data.id)).toEqual([]);
    expect(
      new SessionIndex(f.home).list().some((row) => row.id === side.data.id),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

it("rejects over-quota sends and edited continuations before invoking the engine", async () => {
  const f = await fixture();
  try {
    native.rejectQuota = true;
    const blocked = await f.call("/session-source/turns", {
      content: "must not run",
    });
    expect(blocked.data.error).toBe("quota_exceeded");
    const edited = await f.call("/session-source/fork", {
      messageId: "m2",
      replacementContent: "must not run either",
    });
    expect(edited.data.error).toBe("quota_exceeded");
    expect(native.calls.filter((call) => call.method === "send")).toEqual([]);
    expect(f.messages.list("session-source")).toHaveLength(5);
    native.rejectQuota = false;
    expect(
      (await f.call("/session-source/turns", { content: "restored" })).status,
    ).toBe(202);
    expect(native.calls).toContainEqual({
      method: "send",
      content: "restored",
    });
  } finally {
    await f.close();
  }
});

it("keeps an over-quota queued message for explicit retry after a budget adjustment", async () => {
  const f = await fixture();
  try {
    native.rejectQuota = true;
    await f.call("/session-source/queue", {
      messageId: "quota-queue",
      content: "wait for budget",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await f.call("/session-source/queue")).data[0].error).toContain(
      "额度不足",
    );
    expect(native.calls.filter((call) => call.method === "send")).toEqual([]);
    native.rejectQuota = false;
    expect(
      (
        await f.call("/session-source/queue", {
          messageId: "quota-queue",
          action: "send",
        })
      ).status,
    ).toBe(200);
    expect(native.calls).toContainEqual({
      method: "send",
      content: "wait for budget",
    });
  } finally {
    await f.close();
  }
});

it("forks through the chosen native turn and edits before it without mutating the source", async () => {
  const f = await fixture();
  try {
    const fork = await f.call("/session-source/fork", { messageId: "m2" });
    expect(fork.status).toBe(201);
    expect(native.calls).toContainEqual({ method: "fork", lastTurnId: "t1" });
    expect(f.messages.list(fork.data.id).map((m) => m.text)).toEqual([
      "remember amber",
      "ack amber",
      "wrong request",
      "wrong answer",
    ]);
    const edit = await f.call("/session-source/fork", {
      messageId: "m2",
      replacementContent: "correct request",
    });
    expect(edit.status).toBe(201);
    expect(native.calls).toContainEqual({ method: "fork", lastTurnId: "t0" });
    expect(f.messages.list(edit.data.id).map((m) => m.text)).toEqual([
      "remember amber",
      "ack amber",
      "correct request",
    ]);
    expect((await f.call(`/${edit.data.id}`)).data).toMatchObject({
      parentSessionId: "session-source",
      branchKind: "edit",
      anchorMessageId: "m2",
    });
    expect(f.messages.list("session-source")).toHaveLength(5);
    expect(
      (await f.call("/session-source/fork", { messageId: "missing" })).status,
    ).toBe(409);
  } finally {
    await f.close();
  }
});

it("reconstructs Kimi history only up to an edited message", async () => {
  const f = await fixture("kimi");
  try {
    const edit = await f.call("/session-source/fork", {
      messageId: "m2",
      replacementContent: "correct request",
    });
    expect(edit.status).toBe(201);
    const prompt = native.calls.find(
      (call) => call.method === "send",
    )!.content!;
    expect(prompt).toContain("remember amber");
    expect(prompt).toContain("correct request");
    expect(prompt).not.toContain("wrong request");
    expect(prompt).not.toContain("later secret");
    expect(edit.data.contextMode).toBe("transcript");
  } finally {
    await f.close();
  }
});

it.each(["codex", "kimi"] as const)(
  "branches %s at an assistant reply and does not allow editing it",
  async (engine) => {
    const f = await fixture(engine);
    try {
      const before = f.messages.list("session-source");
      const fork = await f.call("/session-source/fork", { messageId: "m1" });
      expect(fork.status).toBe(201);
      expect(f.messages.list(fork.data.id).map((m) => m.text)).toEqual([
        "remember amber",
        "ack amber",
      ]);
      expect(fork.data.anchorMessageId).toBe("m1");
      if (engine === "codex")
        expect(native.calls).toContainEqual({
          method: "fork",
          lastTurnId: "t0",
        });
      const edit = await f.call("/session-source/fork", {
        messageId: "m1",
        replacementContent: "rewrite reply",
      });
      expect(edit.status).toBe(409);
      expect(f.messages.list("session-source")).toEqual(before);
    } finally {
      await f.close();
    }
  },
);

it("uses an exact transcript boundary when another assistant message follows in the same turn", async () => {
  const f = await fixture();
  try {
    f.messages.append({
      id: "m5",
      sessionId: "session-source",
      role: "assistant",
      text: "first reply",
      nativeTurnId: "t2",
      createdAt: "2026-09-06T00:01:00Z",
    });
    f.messages.append({
      id: "m6",
      sessionId: "session-source",
      role: "assistant",
      text: "later reply",
      nativeTurnId: "t2",
      createdAt: "2026-09-06T00:01:01Z",
    });
    const fork = await f.call("/session-source/fork", { messageId: "m5" });
    expect(fork.status).toBe(201);
    expect(fork.data.contextMode).toBe("transcript");
    expect(f.messages.list(fork.data.id).at(-1)?.text).toBe("first reply");
    expect(native.calls.some((c) => c.method === "fork")).toBe(false);
  } finally {
    await f.close();
  }
});

it("persists an unsent side-chat snapshot across restart and never writes it to the main conversation", async () => {
  const first = await fixture();
  const side = await first.call("/session-source/side-chat", {});
  expect(side.status).toBe(201);
  expect(first.messages.list(side.data.id)).toEqual([]);
  await first.close();
  const restarted = await fixture("codex", first.home);
  try {
    expect(
      (
        await restarted.call(`/${side.data.id}/turns`, {
          content: "btw question",
        })
      ).status,
    ).toBe(202);
    const prompt = native.calls.find(
      (call) => call.method === "send",
    )!.content!;
    expect(prompt).toContain("remember amber");
    expect(prompt).toContain("btw question");
    expect(restarted.messages.list(side.data.id).map((m) => m.text)).toEqual([
      "btw question",
    ]);
    expect(restarted.messages.list("session-source")).toHaveLength(5);
    expect(
      new SessionIndex(first.home).list().find((s) => s.id === side.data.id)
        ?.pendingContext,
    ).toBeUndefined();
  } finally {
    await restarted.close();
  }
});

it("routes steering to the active turn and rejects steering after completion", async () => {
  const f = await fixture();
  try {
    expect(
      (await f.call("/session-source/steer", { content: "too early" })).status,
    ).toBe(409);
    expect(
      (await f.call("/session-source/turns", { content: "start" })).status,
    ).toBe(202);
    expect(
      (await f.call("/session-source/turns", { content: "duplicate turn" }))
        .status,
    ).toBe(409);
    expect(
      (await f.call("/session-source/steer", { content: "change direction" }))
        .status,
    ).toBe(202);
    expect(native.calls).toContainEqual({
      method: "steer",
      content: "change direction",
    });
    native.emit({ type: "turn.completed", turnId: "active" });
    expect(
      (await f.call("/session-source/steer", { content: "late" })).status,
    ).toBe(409);
    expect(f.messages.list("session-source").map((m) => m.text)).not.toContain(
      "late",
    );
  } finally {
    await f.close();
  }
});

it("stops the original active task before starting an edited continuation", async () => {
  const f = await fixture();
  try {
    await f.call("/session-source/turns", { content: "running original" });
    const edit = await f.call("/session-source/fork", {
      messageId: "m2",
      replacementContent: "replacement",
    });
    expect(edit.status).toBe(201);
    const cancelIndex = native.calls.findIndex(
      (call) => call.method === "cancel",
    );
    const forkIndex = native.calls.findIndex((call) => call.method === "fork");
    expect(cancelIndex).toBeGreaterThanOrEqual(0);
    expect(forkIndex).toBeGreaterThan(cancelIndex);
    expect((await f.call("/session-source")).data.activity.state).toBe("idle");
  } finally {
    await f.close();
  }
});

it("opens BTW during an active task without cancelling or writing to it", async () => {
  const f = await fixture();
  try {
    await f.call("/session-source/turns", { content: "keep working" });
    const before = f.messages.list("session-source");
    const side = await f.call("/session-source/side-chat", {});
    expect(side.status).toBe(201);
    expect((await f.call("/session-source")).data.activity.state).toBe(
      "running",
    );
    expect(f.messages.list("session-source")).toEqual(before);
    expect(native.calls.some((call) => call.method === "cancel")).toBe(false);
  } finally {
    await f.close();
  }
});

it("persists queued inputs and delivers them FIFO after completion without a browser", async () => {
  const f = await fixture();
  try {
    await f.call("/session-source/turns", { content: "first" });
    for (const messageId of ["q1", "q2"])
      expect(
        (
          await f.call("/session-source/queue", {
            messageId,
            content: messageId,
          })
        ).status,
      ).toBe(202);
    expect(
      native.calls.filter((c) => c.method === "send").map((c) => c.content),
    ).toEqual(["first"]);
    expect(new SessionIndex(f.home).list()[0]!.queue).toHaveLength(2);
    native.emit({ type: "turn.completed", turnId: "active" });
    await vi.waitFor(() =>
      expect(
        native.calls.filter((c) => c.method === "send").map((c) => c.content),
      ).toEqual(["first", "q1"]),
    );
    expect(
      (await f.call("/session-source/queue")).data.map(
        (r: { messageId: string }) => r.messageId,
      ),
    ).toEqual(["q2"]);
    native.emit({ type: "turn.completed", turnId: "active" });
    await vi.waitFor(() =>
      expect(
        native.calls.filter((c) => c.method === "send").map((c) => c.content),
      ).toEqual(["first", "q1", "q2"]),
    );
    expect(new SessionIndex(f.home).list()[0]!.queue).toEqual([]);
  } finally {
    await f.close();
  }
});
it("steers only the selected queued input and keeps rejected input available for retry", async () => {
  const f = await fixture();
  try {
    await f.call("/session-source/turns", { content: "first" });
    for (const messageId of ["q1", "q2"])
      await f.call("/session-source/queue", { messageId, content: messageId });
    native.rejectSteer = true;
    expect(
      (
        await f.call("/session-source/queue", {
          messageId: "q2",
          action: "steer",
        })
      ).status,
    ).toBe(409);
    expect((await f.call("/session-source/queue")).data).toHaveLength(2);
    native.rejectSteer = false;
    expect(
      (
        await f.call("/session-source/queue", {
          messageId: "q2",
          action: "steer",
        })
      ).status,
    ).toBe(200);
    expect(
      native.calls.filter((c) => c.method === "steer").map((c) => c.content),
    ).toEqual(["q2"]);
    expect(
      (await f.call("/session-source/queue")).data.map(
        (r: { messageId: string }) => r.messageId,
      ),
    ).toEqual(["q1"]);
    expect(
      f.messages.list("session-source").filter((m) => m.id === "q2"),
    ).toHaveLength(1);
    expect(
      (
        await f.call("/session-source/queue", {
          messageId: "q1",
          action: "remove",
        })
      ).data,
    ).toEqual([]);
  } finally {
    await f.close();
  }
});
it.each(["turn.cancelled", "turn.failed"] as const)(
  "preserves the queue without starting another turn after %s",
  async (type) => {
    const f = await fixture();
    try {
      await f.call("/session-source/turns", { content: "first" });
      await f.call("/session-source/queue", {
        messageId: "q1",
        content: "pending",
      });
      native.emit(
        type === "turn.failed"
          ? {
              type,
              turnId: "active",
              code: "test_failure",
              message: "test failure",
            }
          : { type, turnId: "active" },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(native.calls.filter((c) => c.method === "send")).toHaveLength(1);
      const restored = await fixture("codex", f.home);
      try {
        expect(
          (await restored.call("/session-source/queue")).data[0].content,
        ).toBe("pending");
        expect(
          (
            await restored.call("/session-source/queue", {
              messageId: "q1",
              action: "send",
            })
          ).status,
        ).toBe(200);
        expect((await restored.call("/session-source/queue")).data).toEqual([]);
      } finally {
        await restored.close();
      }
    } finally {
      await f.close();
    }
  },
);

it("defers file moves until the active turn ends and synchronizes the next queued turn before engine dispatch", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.home, "paper.txt"), "original");
    await f.call("/session-source/turns", {
      messageId: "first",
      content: "work on paper",
    });
    const op = f.moves.request("default", [
      { source: "paper.txt", destination: "archive/paper.txt" },
    ]);
    expect(op.state).toBe("queued");
    expect(readFileSync(join(f.home, "paper.txt"), "utf8")).toBe("original");
    await f.call("/session-source/queue", {
      messageId: "next",
      content: "continue editing",
    });
    native.emit({ type: "turn.completed", turnId: "active" });
    await vi.waitFor(() =>
      expect(
        native.calls.filter((call) => call.method === "send"),
      ).toHaveLength(2),
    );
    expect(op.state).toBe("completed");
    expect(
      native.calls.filter((call) => call.method === "send").at(-1)?.content,
    ).toContain('"to":"archive/paper.txt"');
    expect(f.messages.list("session-source").at(-1)?.text).toBe(
      "continue editing",
    );
    native.emit({ type: "turn.completed", turnId: "active" });
    await f.call("/session-source/turns", {
      messageId: "third",
      content: "next",
    });
    expect(
      native.calls.filter((call) => call.method === "send").at(-1)?.content,
    ).toBe("next");
    expect(
      new SessionIndex(f.home).list().find((row) => row.id === "session-source")
        ?.fileRevision,
    ).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});

it("persists stable identities in result links while preserving line anchors and literal code examples", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.home, "paper.txt"), "original");
    await f.call("/session-source/turns", {
      messageId: "input",
      content: "write",
    });
    native.emit({
      type: "assistant.completed",
      turnId: "active",
      content: "[paper](paper.txt#L2) and `[example](paper.txt)`",
    });
    const result = f.messages.list("session-source").at(-1)?.text;
    expect(result).toMatch(
      /\[paper\]\(paper.txt\?workagentFileId=[a-z0-9-]+#L2\)/,
    );
    expect(result).toContain("`[example](paper.txt)`");
  } finally {
    await f.close();
  }
});

it("releases shared-project move admission when an engine rejects the send", async () => {
  const f = await fixture();
  try {
    const store = { get: () => ({}), engineRoot: () => f.home, moves: f.moves };
    f.runtime.setSharedFileStore(store as never);
    native.rejectSend = true;
    await expect(
      f.runtime.executeSharedTurn({
        runId: "run-rejected",
        conversationId: "shared-rejected",
        projectId: "shared-project",
        engine: "codex",
        modelId: "gpt-test",
        thinkingEffort: "low",
        context: "work",
        recoveryContext: "recover",
        workspacePath: f.home,
        payerSid: "S-1-test",
      }),
    ).rejects.toThrow("send rejected");
    expect(f.moves.busy("shared-project")).toBe(false);
  } finally {
    await f.close();
  }
});

it("answers a question in the active turn once and retains its relation after restart", async () => {
  let f = await fixture("codex", undefined, { canonical: true, blank: true });
  try {
    await f.runtime.nativeSessionPort.prompt("session-source", "work", "queue");
    f.log!.appendMessage({
      id: "call_question",
      sessionId: "session-source",
      role: "assistant",
      kind: "question",
      text: "学校和专业？",
      createdAt: new Date().toISOString(),
      nativeTurnId: "active",
    });
    const input = { questionId: "call_question", content: "港大商业分析" };
    native.rejectSteer = true;
    expect((await f.call("/session-source/question-reply", input)).status).toBe(
      409,
    );
    expect(
      f.runtime.nativeSessionPort
        .messages("session-source")
        .some((m) => m.replyTo),
    ).toBe(false);
    native.rejectSteer = false;
    const result = await f.call("/session-source/question-reply", input);
    expect(result.status).toBe(200);
    expect(result.data.message).toMatchObject({
      text: input.content,
      replyTo: { id: input.questionId, text: "学校和专业？" },
      nativeTurnId: "active",
    });
    expect(native.calls.filter((c) => c.method === "steer")).toHaveLength(1);
    expect(native.calls.find((c) => c.method === "steer")?.content).toContain(
      "学校和专业？",
    );
    expect(native.calls.find((c) => c.method === "steer")?.content).toContain(
      input.content,
    );
    expect(native.calls.filter((c) => c.method === "send")).toHaveLength(1);
    expect(native.calls.some((c) => c.method === "cancel")).toBe(false);
    expect(
      (await f.call("/session-source/question-reply", input)).data,
    ).toEqual(result.data);
    expect(
      (
        await f.call("/session-source/question-reply", {
          ...input,
          content: "different",
        })
      ).status,
    ).toBe(409);
    const home = f.home;
    await f.close();
    f = await fixture("codex", home, { canonical: true });
    expect(
      (await f.call("/session-source/question-reply", input)).data,
    ).toEqual(result.data);
    expect(native.calls.filter((c) => c.method === "steer")).toHaveLength(1);
    expect(
      f.runtime.nativeSessionPort
        .messages("session-source")
        .filter((m) => m.replyTo),
    ).toHaveLength(1);
    const { nativeSessionProjection: p } = await import(
      "./native-session-projection.js"
    );
    const projection = f
      .log!.get("session-source")!
      .events.reduce((s, e) => p.apply(s, e), p.init());
    expect(projection.messages.find((m) => m.replyTo)?.replyTo).toEqual({
      id: "call_question",
      text: "学校和专业？",
    });
  } finally {
    await f.close();
  }
});
it("rejects unrelated messages and resumes an idle question without cancel", async () => {
  const f = await fixture();
  try {
    expect(
      (
        await f.call("/session-source/question-reply", {
          questionId: "m1",
          content: "answer",
        })
      ).status,
    ).toBe(404);
    f.messages.append({
      id: "q",
      sessionId: "session-source",
      role: "assistant",
      kind: "question",
      text: "语言？",
      createdAt: new Date().toISOString(),
    });
    expect(
      (
        await f.call("/session-source/question-reply", {
          questionId: "q",
          content: "中文",
        })
      ).status,
    ).toBe(200);
    expect(native.calls.filter((c) => c.method === "send")).toHaveLength(1);
    expect(
      native.calls.some((c) => c.method === "cancel" || c.method === "steer"),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

it("updates market-bound native tasks explicitly and lets emergency removal stop an affected turn", async () => {
  const f = await fixture();
  try {
    f.skills.replace({
      skills: ["market-old", "market-new"].map((id) => ({
        root: join(f.home, id),
        entry: {
          id,
          name: id,
          description: "market",
          version: "1.0.0",
          source: "market" as const,
          enabled: true,
          relativePath: `${id}/skill`,
          requiredMcpServerIds: [],
          requiredCommands: [],
          health: "ready" as const,
        },
      })),
    });
    const preset = f.presets.create({
      name: "Market writer",
      engine: "codex",
      workspacePolicy: "optional",
      skillIds: ["market-old"],
    });
    const created = await f.call("", {
      engine: "codex",
      title: "Market task",
      workspace: "default",
      presetId: preset.id,
      modelId: "gpt-test",
    });
    expect(created.status).toBe(201);
    const id = created.data.id;
    await f.runtime.nativeSessionPort.prompt(
      id,
      "Use my skill",
      "queue",
      "market-message",
    );
    const change = {
      skills: { "market-old": "market-new" },
      mcp: {},
      assistants: {},
    };
    // URL normalization directs this through the same authenticated runtime handler.
    expect(
      (await f.call("/../market-capabilities/change", change)).data.error,
    ).toBe("market_update_session_busy");
    native.emit({ type: "turn.completed", turnId: "active" });
    await vi.waitFor(() =>
      expect(
        f.runtime.nativeSessionPort.list().find((s) => s.id === id)?.activity
          ?.state,
      ).toBe("idle"),
    );
    expect(
      (await f.call("/../market-capabilities/change", change)).status,
    ).toBe(200);
    expect(f.presets.get(preset.id)?.skillIds).toEqual(["market-new"]);
    await f.runtime.nativeSessionPort.prompt(
      id,
      "Continue",
      "queue",
      "market-message-2",
    );
    expect(native.resumedOptions.at(-1)).toMatchObject({
      skills: [{ entry: { id: "market-new" } }],
    });
    expect(
      (
        await f.call("/../market-capabilities/change", {
          skills: { "market-new": "" },
          mcp: {},
          assistants: {},
          urgent: true,
        })
      ).status,
    ).toBe(200);
    expect(f.presets.get(preset.id)?.skillIds).toEqual([]);
    expect(f.messages.list(id).some((m) => m.id === "market-message")).toBe(
      true,
    );
    expect(native.calls.some((c) => c.method === "cancel")).toBe(true);
  } finally {
    await f.close();
  }
});

it("keeps sessions bound to a disabled skill working and hides it from the unbound catalog", async () => {
  let f = await fixture();
  const home = f.home;
  const pausedSkill = () => ({
    root: join(home, "paused-skill"),
    entry: {
      id: "paused-skill",
      name: "paused-skill",
      description: "Paused",
      version: "1",
      source: "user" as const,
      enabled: false,
      relativePath: "paused-skill/skill",
      referenceDirectory: join(home, "paused-reference"),
      requiredMcpServerIds: [],
      requiredCommands: [],
      health: "ready" as const,
    },
  });
  try {
    f.skills.replace({ skills: [pausedSkill()] });
    // Unbound session: a disabled reference skill is neither injected nor catalogued.
    const plain = await f.call("", {
      engine: "codex",
      title: "Plain",
      workspace: "default",
      modelId: "gpt-test",
    });
    expect(plain.status).toBe(201);
    expect(plain.data.preset.resolvedSnapshot.skillIds).toEqual([]);
    await f.runtime.nativeSessionPort.prompt(
      plain.data.id,
      "Hello",
      "queue",
      "plain-message",
    );
    expect(native.createdOptions.at(-1)).toMatchObject({
      skills: [],
      catalogSkills: [],
    });
    // Explicitly bound session: creating, prompting and resuming still work.
    const preset = f.presets.create({
      name: "Paused writer",
      engine: "codex",
      workspacePolicy: "optional",
      skillIds: ["paused-skill"],
    });
    const bound = await f.call("", {
      engine: "codex",
      title: "Paused task",
      workspace: "default",
      presetId: preset.id,
      modelId: "gpt-test",
    });
    expect(bound.status).toBe(201);
    await f.runtime.nativeSessionPort.prompt(
      bound.data.id,
      "Use my skill",
      "queue",
      "paused-message",
    );
    expect(native.createdOptions.at(-1)).toMatchObject({
      skills: [{ entry: { id: "paused-skill" } }],
    });
    await f.close();
    f = await fixture("codex", home);
    f.skills.replace({ skills: [pausedSkill()] });
    await f.runtime.nativeSessionPort.prompt(
      bound.data.id,
      "Continue",
      "queue",
      "paused-message-2",
    );
    expect(native.resumedOptions.at(-1)).toMatchObject({
      skills: [{ entry: { id: "paused-skill" } }],
    });
  } finally {
    await f.close();
  }
});
