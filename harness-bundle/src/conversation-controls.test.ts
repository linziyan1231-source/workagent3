import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { NativeSessionLog } from "./native-session-log.js";
import { RuntimeController } from "./runtime.js";
import { SessionIndex } from "./session-index.js";
import { MessageStore } from "./message-store.js";
import { PresetStore } from "./preset-store.js";
import { ModelAccessStore } from "./model-access-store.js";
import type { BridgeEvent, EngineSessionOptions } from "./engines/types.js";

const native = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; content?: string; lastTurnId?: string }>,
  emit: (_event: BridgeEvent) => {},
  sequence: 0,
  rejectSteer: false,
  rejectQuota: false,
  sendGate: undefined as Promise<void> | undefined,
  reserveGate: undefined as Promise<void> | undefined,
  settlements: [] as string[],
  catalogGate: undefined as Promise<void> | undefined,
  catalogReads: 0,
  resumedOptions: [] as unknown[],
  createdOptions: [] as EngineSessionOptions[],
  resumeError: undefined as string | undefined,
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
      return {
        nativeId: `native-${++native.sequence}`,
        permissionMode: "workspace_write" as const,
        send: async (content: string) => {
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
    }
    async close() {}
  },
}));
vi.mock("./engines/kimi.js", async () => {
  const { CodexBridge } = await import("./engines/codex.js");
  return { KimiBridge: CodexBridge };
});

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  native.calls.length = 0;
  native.rejectSteer = false;
  native.rejectQuota = false;
  native.sendGate = undefined;
  native.reserveGate = undefined;
  native.settlements.length = 0;
  native.catalogGate = undefined;
  native.catalogReads = 0;
  native.resumedOptions.length = 0;
  native.createdOptions.length = 0;
  native.resumeError = undefined;
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
  const presets = new PresetStore(home, new ModelAccessStore(home));
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
  const runtime = new RuntimeController(
    ctx,
    "test-token",
    { engineRoot: () => home } as never,
    presets,
    {} as never,
    {} as never,
    { statusFor: () => ({ state: "ready" }) } as never,
    {
      reserve: async () => {
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
    return { status: response.status, data: await response.json() };
  };
  return {
    runtime,
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
          let decision: string | undefined;
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

it("reads the effective native permission without persisting or changing the legacy session", async () => {
  const f = await fixture();
  try {
    const before = new SessionIndex(f.home).list()[0]?.permissionMode;
    expect(before).toBeUndefined();
    expect((await f.call("/session-source/configuration")).data).toEqual({
      permissionMode: "workspace_write",
    });
    expect(new SessionIndex(f.home).list()[0]?.permissionMode).toBeUndefined();
    expect(native.resumedOptions.at(-1)).not.toHaveProperty("permissionMode");
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
