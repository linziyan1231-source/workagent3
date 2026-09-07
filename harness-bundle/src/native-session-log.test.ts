import { Context } from "@deepseek-ai/cordis";
import { Session, SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NativeSessionLog } from "./native-session-log.js";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import {
  registerNativeSessionProjection,
  nativeSessionProjection,
} from "./native-session-projection.js";

const metadata = {
  id: "session-1",
  engine: "codex",
  workspacePath: process.cwd(),
  createdAt: "2026-09-01T12:00:00.000Z",
};
const message = {
  id: "original-user-id",
  sessionId: "session-1",
  role: "user" as const,
  text: "hello",
  createdAt: "2026-09-01T12:00:01.000Z",
  nativeTurnId: "original-native-turn",
};
function fixture(home = mkdtempSync(join(tmpdir(), "native-session-"))) {
  const ctx = new Context();
  new SessionStore(ctx);
  const log = new NativeSessionLog(ctx, home);
  return { ctx, log, home };
}

describe("NativeSessionLog", () => {
  it("restores an independent literal fixture and refuses a corrupt committed sequence", async () => {
    const { log, home } = fixture();
    const path = log.location("session-1");
    const header = {
      version: 0,
      id: "session-1",
      createdAt: 10,
      cwd: metadata.workspacePath,
      agentPreset: "workagent-native:codex",
    };
    const rows = [
      { type: "workagent/native/message", seq: 0, time: 11, data: message },
      {
        type: "workagent/native/imported",
        seq: 1,
        time: 12,
        data: { version: 1 },
      },
      {
        type: "workagent/native/event",
        seq: 2,
        time: 13,
        data: { type: "unknown-native-fact", raw: { future: [null, true] } },
      },
    ];
    writeFileSync(
      path,
      [header, ...rows].map((row) => JSON.stringify(row)).join("\n"),
    );
    expect(log.open(metadata, []).events.slice(0, 3)).toEqual(rows);
    await log.dispose();
    const reopened = fixture(home);
    expect(reopened.log.open(metadata, []).events.slice(0, 3)).toEqual(rows);
    await reopened.log.dispose();
    rows[1]!.seq = 5;
    writeFileSync(
      path,
      [header, ...rows].map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    const corrupted = fixture(home);
    expect(() => corrupted.log.open(metadata, [])).toThrow("contiguous");
    await corrupted.log.dispose();
  });
  it("registers a rebuildable standard projection for messages, activity and full tool details", async () => {
    const { log, ctx } = fixture();
    new SessionProjectionRegistry(ctx);
    registerNativeSessionProjection(ctx);
    const session = log.open(metadata, [message]);
    log.appendEvent(metadata.id, { type: "turn.started", turnId: "native-1" });
    log.appendEvent(metadata.id, {
      type: "tool.started",
      turnId: "native-1",
      toolCallId: "tool-1",
      tool: "read",
      input: { path: "a.ts" },
    });
    log.appendEvent(metadata.id, {
      type: "tool.completed",
      turnId: "native-1",
      toolCallId: "tool-1",
      output: { text: "contents" },
      failed: false,
    });
    const projection = ctx.sessionProjections.snapshot(session);
    expect(
      nativeSessionProjection.stateSchema.safeParse(
        projection.values.nativeSession,
      ).success,
    ).toBe(true);
    expect(
      nativeSessionProjection.wire!.viewSchema.safeParse(
        projection.values.nativeSession,
      ).success,
    ).toBe(true);
    expect(projection.asOfSeq).toBe(session.seq - 1);
    expect(projection.values.nativeSession).toMatchObject({
      messages: [message],
      activity: { state: "running" },
      tools: {
        "tool-1": {
          tool: "read",
          input: { path: "a.ts" },
          output: { text: "contents" },
        },
      },
    });
    const checkpoint = ctx.sessionProjections.checkpoint(session);
    expect(
      ctx.sessionProjections.restore(checkpoint, session.events, 0).snapshot,
    ).toEqual(projection);
    await log.dispose();
  });
  it("maps observable native turn notifications once without fabricating model steps", async () => {
    const { log } = fixture();
    const session = log.open(metadata, []);
    log.appendEvent(metadata.id, { type: "turn.started", turnId: "native-23" });
    log.appendEvent(metadata.id, { type: "turn.started", turnId: "native-23" });
    log.appendEvent(metadata.id, {
      type: "turn.completed",
      turnId: "native-23",
      future: { exact: true },
    });
    expect(
      session.events
        .filter((event) => event.type === "turn/start")
        .map((event) => event.data),
    ).toEqual([{ turn: 0 }]);
    expect(
      session.events
        .filter((event) => event.type === "turn/end")
        .map((event) => event.data),
    ).toEqual([{ turn: 0, reason: { kind: "completed" } }]);
    expect(
      session.events.filter((event) => event.type === "workagent/native/event"),
    ).toHaveLength(3);
    await log.dispose();
  });

  it("projects bounded stream state and preserves a native cancellation reason across restoration", async () => {
    const { log, ctx, home } = fixture();
    new SessionProjectionRegistry(ctx);
    registerNativeSessionProjection(ctx);
    const session = log.open(metadata, []);
    log.appendEvent(metadata.id, {
      type: "session.metadata",
      engine: "codex",
      title: "Native",
      queue: [],
    });
    log.appendEvent(metadata.id, {
      type: "turn.started",
      turnId: "native-stream",
    });
    log.appendEvent(metadata.id, {
      type: "assistant.delta",
      turnId: "native-stream",
      delta: "first ",
    });
    log.appendEvent(metadata.id, {
      type: "assistant.delta",
      turnId: "native-stream",
      delta: "second",
    });
    expect(
      ctx.sessionProjections.snapshot(session).values.nativeSession,
    ).toMatchObject({ draft: "first second", metadata: { title: "Native" } });
    expect(
      ctx.sessionProjections.snapshot(session).values.nativeSession,
    ).not.toHaveProperty("events");
    log.appendEvent(metadata.id, {
      type: "turn.cancelled",
      turnId: "native-stream",
    });
    expect(
      ctx.sessionProjections.snapshot(session).values.nativeSession,
    ).toMatchObject({ draft: "", activity: { state: "idle" } });
    await log.dispose();
    const restored = fixture(home);
    const events = restored.log.open(metadata, []).events;
    expect(events.findLast((event) => event.type === "turn/end")).toMatchObject(
      { data: { reason: { kind: "native-cancelled" } } },
    );
    await restored.log.dispose();
  });
  it("imports once into the real Session, retaining original visible identity without fabricated execution", async () => {
    const { ctx, log, home } = fixture();
    const session = log.open(metadata, [message]);
    expect(session).toBeInstanceOf(Session);
    expect(ctx.sessions.get(SessionId(metadata.id))).toBe(session);
    expect(log.messages(metadata.id)).toEqual([message]);
    log.appendMessage(message);
    const original = session.events;
    expect(
      original.filter((e) => e.type === "workagent/native/message"),
    ).toHaveLength(1);
    expect(original.some((e) => /^(turn|step|request)\//.test(e.type))).toBe(
      false,
    );
    await log.dispose();
    const reopened = fixture(home);
    const restored = reopened.log.open(metadata, [message]);
    expect(restored.events.slice(0, original.length)).toEqual(original);
    expect(restored.header.createdAt).toBe(1788264000000);
    expect(reopened.log.messages(metadata.id)).toEqual([message]);
    await reopened.log.dispose();
  });

  it("streams committed immutable native facts and preserves unknown JSON on reload", async () => {
    const { ctx, log, home } = fixture();
    const session = log.open(metadata, []);
    const observed: unknown[] = [];
    ctx.on("session/event", (_session, event) => {
      observed.push(event);
    });
    const fact = {
      type: "tool-result",
      toolId: "native-tool",
      output: { future: [1, null, { extra: true }] },
    };
    log.appendEvent(metadata.id, fact);
    expect(observed).toEqual([session.events.at(-1)]);
    fact.output.future.push(2);
    expect(session.events.at(-1)?.data).toEqual({
      type: "tool-result",
      toolId: "native-tool",
      output: { future: [1, null, { extra: true }] },
    });
    const last = session.events.at(-1);
    await log.dispose();
    const restored = fixture(home);
    expect(
      restored.log.open(metadata, []).events.find((e) => e.seq === last?.seq),
    ).toEqual(last);
    await restored.log.dispose();
  });

  it("closes a crash-orphaned real turn as interrupted without replaying execution", async () => {
    const { log, home } = fixture();
    log.open(metadata, []);
    log.appendEvent(metadata.id, { type: "turn/start", turn: 7 });
    await log.dispose();
    const restored = fixture(home);
    const events = restored.log.open(metadata, []).events;
    expect(events.filter((e) => e.type === "turn/start")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "turn/end",
      data: { turn: 7, reason: { kind: "interrupted" } },
    });
    expect(events.some((e) => /^(step|request)\//.test(e.type))).toBe(false);
    await restored.log.dispose();
  });

  it("persists a deletion tombstone so stale legacy imports and late writes cannot resurrect sessions", async () => {
    const { log, home, ctx } = fixture();
    log.open(metadata, [message]);
    log.delete(metadata.id);
    expect(ctx.sessions.get(SessionId(metadata.id))).toBeUndefined();
    expect(log.messages(metadata.id)).toEqual([]);
    expect(() => log.appendMessage(message)).toThrow("native_session_deleted");
    await log.dispose();
    const next = fixture(home);
    expect(() => next.log.open(metadata, [message])).toThrow(
      "native_session_deleted",
    );
    await next.log.dispose();
  });

  it("rejects non-JSON data through Session acceptance before durable history changes", async () => {
    const { log, home } = fixture();
    const session = log.open(metadata, []);
    const path = join(
      home,
      "workagent",
      "personal-work",
      "native-sessions",
      "v1",
      "session-1.jsonl",
    );
    const original = readFileSync(path, "utf8");
    expect(() =>
      log.appendEvent(metadata.id, { type: "bad", value: Number.NaN }),
    ).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(session.events).toHaveLength(1);
    await log.dispose();
  });

  it("recovers only a torn final line and preserves the committed prefix", async () => {
    const { log, home } = fixture();
    const events = log.open(metadata, [message]).events;
    await log.dispose();
    const path = join(
      home,
      "workagent",
      "personal-work",
      "native-sessions",
      "v1",
      "session-1.jsonl",
    );
    appendFileSync(path, '{"type":"workagent/native/event"');
    const restored = fixture(home);
    expect(
      restored.log.open(metadata, [message]).events.slice(0, events.length),
    ).toEqual(events);
    expect(restored.log.messages(metadata.id)).toEqual([message]);
    await restored.log.dispose();
  });
});

it("publishes identified standard user messages without model steps and migrates existing native-only messages once", async () => {
  const { log, home } = fixture();
  const session = log.open(metadata, [message]);
  const user = session.events.find((event) => event.type === "user/message");
  expect(user).toMatchObject({
    data: {
      id: "original-user-id",
      role: "user",
      content: [{ type: "text", text: "hello" }],
      source: { kind: "user" },
    },
    surfaceOp: "append",
  });
  log.appendMessage({
    ...message,
    id: "assistant-1",
    role: "assistant",
    text: "answer",
  });
  log.appendMessage(message);
  expect(
    session.events.filter((event) => event.type === "user/message"),
  ).toHaveLength(1);
  expect(
    session.events.some(
      (event) =>
        event.type === "assistant/message" || event.type === "step/start",
    ),
  ).toBe(false);
  await log.dispose();
  const path = join(
    home,
    "workagent",
    "personal-work",
    "native-sessions",
    "v1",
    "session-1.jsonl",
  );
  const rows = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const nativeOnly = [
    rows[0],
    ...rows
      .slice(1)
      .filter((row) => row.type !== "user/message")
      .map((row, seq) => ({ ...row, seq })),
  ];
  writeFileSync(
    path,
    nativeOnly.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const next = fixture(home);
  const migrated = next.log.open(metadata, [message]);
  expect(
    migrated.events.filter((event) => event.type === "user/message"),
  ).toHaveLength(1);
  expect(next.log.messages(metadata.id)).toHaveLength(2);
  await next.log.dispose();
  const again = fixture(home);
  expect(
    again.log
      .open(metadata, [])
      .events.filter((event) => event.type === "user/message"),
  ).toHaveLength(1);
  await again.log.dispose();
});
