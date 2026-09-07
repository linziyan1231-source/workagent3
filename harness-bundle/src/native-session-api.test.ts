import { Context } from "@deepseek-ai/cordis";
import { SessionStore, SessionId } from "@deepseek-ai/dsh-session";
import {
  createApiProxy,
  InProcessApiClient,
  toFetchHandler,
  RpcId,
  type ApiProxy,
} from "@deepseek-ai/dsh-host-apiproxy";
import { expect, it, vi } from "vitest";
import { wrapNativeSessionApi } from "./native-session-api.js";
import type { NativeSessionPort } from "./native-session-port.js";
import type { RuntimeSession } from "@workagent/contracts";

function fixture() {
  const ctx = new Context();
  new SessionStore(ctx);
  const id = SessionId("session-native");
  const session = ctx.sessions.prepare(id, {
    meta: { cwd: process.cwd(), agentPreset: "workagent-native:codex" },
  });
  ctx.sessions.enter(session);
  Object.defineProperty(ctx, "agents", {
    value: { get: () => undefined, entries: () => [], values: () => [] },
  });
  const descriptor = {
    id,
    engine: "codex",
    title: "Native title",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    workspacePath: process.cwd(),
    activity: { state: "running" },
  } as unknown as RuntimeSession & { workspacePath: string };
  const port: NativeSessionPort = {
    approvals: () => [],
    respondApproval: () => false,
    owns: (key) => key === id,
    list: () => [descriptor],
    session: (key) => (key === id ? session : undefined),
    messages: () => [
      {
        id: "legacy",
        sessionId: id,
        role: "user",
        text: "old",
        createdAt: descriptor.createdAt,
      },
    ],
    queue: () => [],
    prompt: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    updateQueue: vi.fn(async () => {}),
    fork: vi.fn(async () => ({ ...descriptor, id: "session-child" })),
    rename: () => "Renamed",
    models: async () => ({
      current: { provider: "codex", model: "opaque" },
      routable: true,
      groups: [],
      failures: [],
    }),
    selectModel: vi.fn(async (_id, selection) => selection),
  };
  Object.defineProperty(ctx, "userQuestions", {
    value: { registerProvider: () => () => {} },
  });
  const real = createApiProxy(ctx, {
    cwd: process.cwd(),
    defaultModelSelection: () => ({ provider: "never", model: "never" }),
  });
  const forbidden = vi.fn(async () => {
    throw new Error("default execution invoked");
  });
  const base = {
    ...real,
    sessions: {
      ...real.sessions,
      prompt: forbidden,
      cancel: forbidden,
      fork: forbidden,
      models: forbidden,
      selectModel: forbidden,
      create: forbidden,
      list: async (request) => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { items: [] } },
      }),
    },
  } as ApiProxy;
  const api = wrapNativeSessionApi(ctx, base, port);
  const client = new InProcessApiClient(toFetchHandler(api));
  return { ctx, id, session, port, base, api, client, forbidden };
}
it("routes native execution through the port using the standard client and reads the real Session", async () => {
  const f = fixture();
  f.session.append("turn/start", { turn: 0 });
  expect(
    (await f.client.sessions.history({ sessionId: f.id })).result,
  ).toMatchObject({
    ok: true,
    value: {
      events: expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({ type: "turn/start" }),
        }),
      ]),
    },
  });
  expect(
    (
      await f.client.sessions.prompt({
        sessionId: f.id,
        mode: "queue",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: " world" },
        ],
      })
    ).result,
  ).toEqual({ ok: true, value: { accepted: true } });
  expect(f.port.prompt).toHaveBeenCalledWith(f.id, "hello world", "queue");
  expect((await f.client.sessions.cancel({ sessionId: f.id })).result.ok).toBe(
    true,
  );
  expect(
    (await f.client.sessions.models({ sessionId: f.id })).result,
  ).toMatchObject({
    ok: true,
    value: { current: { provider: "codex", model: "opaque" } },
  });
  expect(f.forbidden).not.toHaveBeenCalled();
});
it("lists native state and treats legacy messages as nonblank", async () => {
  const f = fixture();
  const result = await f.client.sessions.list({});
  expect(result.result).toMatchObject({
    ok: true,
    value: {
      items: [
        {
          sessionId: f.id,
          running: true,
          blank: false,
          cwd: process.cwd(),
          updatedAt: 1788307200000,
        },
      ],
    },
  });
});
it("rejects native image admission before native execution", async () => {
  const f = fixture();
  const result = await f.client.sessions.prompt({
    sessionId: f.id,
    mode: "queue",
    content: [{ type: "image", mediaType: "image/png", data: "aGVsbG8=" }],
  });
  expect(result.result).toMatchObject({
    ok: false,
    error: { code: "attachment-error" },
  });
  expect(f.port.prompt).not.toHaveBeenCalled();
});
it("does not acknowledge opaque model changes until native persistence succeeds", async () => {
  const f = fixture();
  let resolve!: (selection: { provider: string; model: string }) => void;
  f.port.selectModel = () =>
    new Promise((r) => {
      resolve = r;
    });
  let settled = false;
  const result = f.client.sessions
    .selectModel({ sessionId: f.id, provider: "codex", model: "opaque-v2" })
    .then((r) => {
      settled = true;
      return r;
    });
  await vi.waitFor(() => expect(resolve).toBeDefined());
  expect(settled).toBe(false);
  resolve({ provider: "codex", model: "opaque-v2" });
  expect((await result).result).toEqual({
    ok: true,
    value: { selected: { provider: "codex", model: "opaque-v2" } },
  });
  f.port.selectModel = async () => {
    throw new Error("persistence failed");
  };
  expect(
    (
      await f.client.sessions.selectModel({
        sessionId: f.id,
        provider: "codex",
        model: "opaque-v3",
      })
    ).result.ok,
  ).toBe(false);
});
it("forks only a completed boundary and maps it to the last visible native message", async () => {
  const f = fixture();
  f.session.append("turn/start", { turn: 0 });
  f.session.append("workagent/native/message", {
    id: "answer",
    sessionId: f.id,
    role: "assistant",
    text: "done",
    createdAt: "2026-09-01T00:00:00.000Z",
    nativeTurnId: "native-turn",
  });
  const anchor = f.session.events.at(-1)!.seq;
  expect(
    (await f.client.sessions.fork({ sessionId: f.id, atSeq: anchor })).result,
  ).toMatchObject({ ok: false, error: { code: "fork-unavailable" } });
  expect(f.port.fork).not.toHaveBeenCalled();
  f.session.append("turn/end", { turn: 0, reason: { kind: "completed" } });
  f.port.messages = () => [
    {
      id: "answer",
      sessionId: f.id,
      role: "assistant",
      text: "done",
      createdAt: "2026-09-01T00:00:00.000Z",
      nativeTurnId: "native-turn",
    },
  ];
  expect(
    (await f.client.sessions.fork({ sessionId: f.id, atSeq: anchor })).result,
  ).toMatchObject({ ok: true, value: { sessionId: "session-child" } });
  expect(f.port.fork).toHaveBeenCalledWith(f.id, "answer");
  expect(f.forbidden).not.toHaveBeenCalled();
});
it("adopts an owned existing id without creating a default agent and refuses cwd mismatch", async () => {
  const f = fixture();
  expect(
    (await f.client.sessions.create({ sessionId: f.id, cwd: process.cwd() }))
      .result.ok,
  ).toBe(true);
  expect(
    (await f.client.sessions.create({ sessionId: f.id, cwd: "C:/other" }))
      .result,
  ).toMatchObject({ ok: false, error: { code: "session-conflict" } });
  expect(f.forbidden).not.toHaveBeenCalled();
});
it("preserves nonnative delegation and rpcId", async () => {
  const f = fixture();
  const request = {
    rpcId: RpcId("original"),
    payload: { sessionId: SessionId("session-other") },
  };
  const response = {
    rpcId: request.rpcId,
    result: {
      ok: false as const,
      error: {
        code: "session-not-found" as const,
        message: "missing",
        details: { sessionId: request.payload.sessionId },
      },
    },
  };
  f.base.sessions.cancel = async () => response;
  expect(await f.api.sessions.cancel(request)).toBe(response);
});

it("refuses native presets instead of silently creating a Harness session", async () => {
  const f = fixture();
  expect(
    (await f.client.sessions.create({ agentPreset: "workagent-native:kimi" }))
      .result,
  ).toMatchObject({ ok: false, error: { code: "agent-preset-invalid" } });
  expect(f.forbidden).not.toHaveBeenCalled();
});
it("does not borrow a previous turn message when the selected completed turn has no visible anchor", async () => {
  const f = fixture();
  f.session.append("turn/start", { turn: 0 });
  f.session.append("workagent/native/message", {
    id: "old",
    sessionId: f.id,
    role: "assistant",
    text: "old",
    createdAt: "2026-09-01T00:00:00.000Z",
    nativeTurnId: "t0",
  });
  f.session.append("turn/end", { turn: 0, reason: { kind: "completed" } });
  f.port.messages = () => [
    {
      id: "old",
      sessionId: f.id,
      role: "assistant",
      text: "old",
      createdAt: "2026-09-01T00:00:00.000Z",
      nativeTurnId: "t0",
    },
  ];
  f.session.append("turn/start", { turn: 1 });
  f.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  expect(
    (await f.client.sessions.fork({ sessionId: f.id })).result,
  ).toMatchObject({ ok: false, error: { code: "fork-unavailable" } });
  expect(f.port.fork).not.toHaveBeenCalled();
});
it("preserves mux streaming implementation and routes queue edits without attachment loss", async () => {
  const f = fixture();
  expect(f.api.events.host).toBe(f.base.events.host);
  expect(
    (
      await f.client.sessions.updateQueue({
        sessionId: f.id,
        itemId: "message-q" as never,
        action: { kind: "edit", content: [{ type: "text", text: "changed" }] },
      })
    ).result.ok,
  ).toBe(true);
  expect(f.port.updateQueue).toHaveBeenCalledWith(f.id, "message-q", {
    kind: "edit",
    content: [{ type: "text", text: "changed" }],
  });
});

it("replays live native approvals with stable standard mux IDs and answers through standard respond", async () => {
  const f = fixture();
  const bridge = await nativeApprovals(f);
  const pending = bridge.requestNative(f.id, {
    turnId: "real-turn",
    tool: "Write",
    summary: "Write file",
    signal: new AbortController().signal,
  });
  const abort = new AbortController();
  const stream = f.client.events
    .mux({}, AbortSignal.any([abort.signal, AbortSignal.timeout(1000)]))
    [Symbol.asyncIterator]();
  const frame = await approvalFrame(stream);
  expect(frame.payload).toMatchObject({
    type: "approval/requested",
    sessionId: f.id,
    toolName: "Write",
    reason: "Write file",
  });
  const secondAbort = new AbortController();
  const second = f.client.events
    .mux({}, AbortSignal.any([secondAbort.signal, AbortSignal.timeout(1000)]))
    [Symbol.asyncIterator]();
  const replay = await approvalFrame(second);
  expect(replay.rpcId).toBe(frame.rpcId);
  const wrong = await f.client.respond({
    type: "client-response",
    rpcId: frame.rpcId,
    result: {
      ok: true,
      value: {
        sessionId: "other",
        approvalId: frame.payload.approvalId,
        outcome: "allowed-once",
      },
    },
  });
  expect(wrong.accepted).toBe(false);
  expect(
    await f.client.respond({
      type: "client-response",
      rpcId: frame.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: f.id,
          approvalId: frame.payload.approvalId,
          outcome: "allowed-once",
        },
      },
    }),
  ).toEqual({ accepted: true });
  expect(await pending).toBe("allow");
  const resolved = await approvalFrame(stream, "approval/resolved");
  expect(resolved.payload).toMatchObject({
    type: "approval/resolved",
    outcome: "allowed-once",
  });
  expect(
    await f.client.respond({
      type: "client-response",
      rpcId: frame.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: f.id,
          approvalId: frame.payload.approvalId,
          outcome: "allowed-once",
        },
      },
    }),
  ).toEqual({ accepted: false, reason: "not-pending" });
  abort.abort();
  secondAbort.abort();
});
async function nativeApprovals(f: ReturnType<typeof fixture>) {
  const { ApprovalBridge } = await import("./approval-bridge.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  f.ctx.provide("webServer", { register: () => () => {} } as never);
  const bridge = new ApprovalBridge(
    f.ctx,
    "test-token",
    mkdtempSync(join(tmpdir(), "native-mux-")),
    (_id, event) => {
      f.session.append("workagent/native/event", event);
    },
  );
  f.port.approvals = () => bridge.pendingNative();
  f.port.respondApproval = (session, id, decision) =>
    bridge.respondNative(session, id, decision);
  return bridge;
}
async function approvalFrame(
  stream: AsyncIterator<
    import("@deepseek-ai/dsh-host-apiproxy").RpcRequest<
      import("@deepseek-ai/dsh-host-apiproxy").MuxFrame
    >
  >,
  type = "approval/requested",
) {
  for (let i = 0; i < 25; i++) {
    const next = await stream.next();
    if (next.done) throw new Error("missing approval frame");
    if (next.value.payload.type === type)
      return next.value as import("@deepseek-ai/dsh-host-apiproxy").RpcRequest<
        Extract<
          import("@deepseek-ai/dsh-host-apiproxy").MuxFrame,
          { type: "approval/requested" }
        >
      >;
  }
  throw new Error("missing approval frame");
}

it("streams new native approvals once and emits cancellation through the standard mux", async () => {
  const f = fixture();
  const bridge = await nativeApprovals(f);
  const abort = new AbortController();
  const stream = f.client.events
    .mux({}, AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]))
    [Symbol.asyncIterator]();
  await stream.next();
  const requestAbort = new AbortController();
  const pending = bridge.requestNative(f.id, {
    turnId: "live-turn",
    tool: "Read",
    summary: "Read file",
    signal: requestAbort.signal,
  });
  const frame = await approvalFrame(stream);
  f.session.append("workagent/native/event", {
    type: "approval.requested",
    turnId: "live-turn",
    approvalId: frame.payload.approvalId,
    summary: "Read file",
  });
  f.session.append("workagent/native/event", { type: "test.sentinel" });
  for (let i = 0; i < 20; i++) {
    const next = await stream.next();
    expect(next.done).toBe(false);
    expect(next.value.payload.type).not.toBe("approval/requested");
    if (
      next.value.payload.type === "session/event" &&
      next.value.payload.event.type === "workagent/native/event" &&
      next.value.payload.event.data.type === "test.sentinel"
    )
      break;
  }
  requestAbort.abort();
  expect(await pending).toBe("cancel");
  const resolved = await approvalFrame(stream, "approval/resolved");
  expect(resolved.payload).toMatchObject({ outcome: "cancelled" });
  abort.abort();
});
