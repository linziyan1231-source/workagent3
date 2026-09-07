import { createRequire } from "node:module";
import { createApiProxy } from "@deepseek-ai/dsh-host-apiproxy";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SqliteSessionQueryEngine } from "@deepseek-ai/dsh-session-query-sqlite";
const require = createRequire(import.meta.url);
const { unzipSync } = createRequire(
  require.resolve("@deepseek-ai/dsh-host-apiproxy"),
)("fflate") as { unzipSync: (bytes: Uint8Array) => Record<string, Uint8Array> };
import { Context } from "@deepseek-ai/cordis";
import { SessionId, SessionStore } from "@deepseek-ai/dsh-session";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkAgentSessionPersistence } from "./native-session-persistence.js";

it("routes real Session events to exactly one durable backend and reloads required extensions", async () => {
  const home = mkdtempSync(join(tmpdir(), "native-routing-"));
  const ctx = new Context();
  new SessionStore(ctx);
  const persistence = new WorkAgentSessionPersistence(ctx, {
    root: join(home, "standard"),
    dshHome: home,
    compression: "none",
  });
  expect(ctx.workagentNativeLog === persistence.nativeLog).toBe(true);
  const native = persistence.nativeLog.open(
    { id: "session-native", engine: "codex", workspacePath: home },
    [],
  );
  persistence.nativeLog.appendEvent(native.id, {
    type: "future-native-event",
    nested: { value: 1 },
  });
  await ctx.sessions.flush(native);
  expect(existsSync(persistence.nativeLog.location(native.id))).toBe(true);
  expect(await persistence.standard.list()).toEqual([]);
  const harness = ctx.sessions.create(SessionId("session-harness"), {
    meta: { cwd: home },
  });
  harness.append("turn/start", { turn: 0 });
  harness.append("turn/end", { turn: 0, reason: { kind: "completed" } });
  await ctx.sessions.flush(harness);
  expect(
    (await persistence.inspect(harness.id)).events.some(
      (event) => event.type === "turn/end",
    ),
  ).toBe(true);
  expect((await persistence.standard.list()).map((meta) => meta.id)).toEqual([
    harness.id,
  ]);
  expect((await persistence.list()).map((meta) => meta.id).sort()).toEqual([
    harness.id,
    native.id,
  ]);
  const raw = await persistence.readRaw(native.id);
  expect(raw?.content).toContain("future-native-event");
  persistence.nativeLog.appendEvent(native.id, {
    type: "turn.started",
    turnId: "crash-turn",
  });
  await persistence.nativeLog.dispose();
  const next = new Context();
  new SessionStore(next);
  const reopened = new WorkAgentSessionPersistence(next, {
    root: join(home, "standard"),
    dshHome: home,
    compression: "none",
  });
  const loaded = await reopened.inspect(native.id);
  expect(
    loaded.events.some(
      (event) =>
        event.type === "workagent/native/event" &&
        event.data.type === "future-native-event",
    ),
  ).toBe(true);
  expect(next.sessions.get(native.id)).toBeUndefined();
  const durable = await reopened.load(native.id);
  expect(durable.events.at(-1)).toMatchObject({
    type: "turn/end",
    data: { reason: { kind: "interrupted" } },
  });
  expect(next.sessions.get(native.id)).toBeUndefined();
  expect((await reopened.readRaw(native.id))?.content).toContain(
    '"kind":"interrupted"',
  );
  await expect(reopened.prepare(native.id)).rejects.toThrow(
    "native_session_owner_required",
  );
  const restored = reopened.nativeLog.open(
    { id: native.id, engine: "codex", workspacePath: home },
    [],
  );
  await next.sessions.flush(restored);
  expect(await reopened.standard.list()).toHaveLength(1);
  await reopened.nativeLog.dispose();
});

it("exports exact native raw artifacts through the official stock ZIP endpoint and real query service", async () => {
  const home = mkdtempSync(join(tmpdir(), "native-official-export-"));
  const ctx = new Context();
  new SessionStore(ctx);
  new SessionProjectionRegistry(ctx);
  const persistence = new WorkAgentSessionPersistence(ctx, {
    root: join(home, "standard"),
    dshHome: home,
    compression: "none",
  });
  const query = new SqliteSessionQueryEngine(ctx, {
    path: ":memory:",
    openAt: "never",
  });
  Object.defineProperty(ctx, "agents", { value: { get: () => undefined } });
  Object.defineProperty(ctx, "userQuestions", {
    value: { registerProvider: () => () => {} },
  });
  ctx.provide("attachments", {
    imageLimits: {
      maxImageBytes: 1024,
      maxImagesPerMessage: 1,
      maxMessageImageBytes: 1024,
      maxImagePixels: 100,
      maxImageDimension: 10,
      mediaTypes: ["image/png"],
    },
    readImage: async () => {
      throw new Error("Unexpected image in text-only fixture");
    },
  } as never);
  const api = createApiProxy(ctx, {
    cwd: home,
    defaultModelSelection: () => ({ provider: "unused", model: "unused" }),
  });
  const native = persistence.nativeLog.open(
    { id: "session-export", engine: "codex", workspacePath: home },
    [],
  );
  persistence.nativeLog.appendEvent(native.id, {
    type: "turn.started",
    turnId: "native-t",
  });
  persistence.nativeLog.appendMessage({
    id: "actual-user-id",
    sessionId: native.id,
    role: "user",
    text: "export me",
    createdAt: "2026-09-01T00:00:00.000Z",
    nativeTurnId: "native-t",
  });
  persistence.nativeLog.appendEvent(native.id, {
    type: "tool.completed",
    turnId: "native-t",
    toolCallId: "actual-tool",
    tool: "dir",
    input: { command: "dir" },
    output: { files: ["a.txt"] },
    failed: false,
  });
  persistence.nativeLog.appendEvent(native.id, {
    type: "turn.completed",
    turnId: "native-t",
  });
  expect((await query.listSessions()).map((row) => row.header.id)).toContain(
    native.id,
  );
  const projection = ctx.sessionProjections.snapshot(native);
  expect(projection.values.nativeSession).toMatchObject({
    messages: [{ id: "actual-user-id" }],
  });
  const response = await api.downloads.sessionLog(
    { sessionId: native.id, includeDescendants: true },
    new AbortController().signal,
  );
  expect(
    response.status,
    response.status === 200 ? undefined : await response.text(),
  ).toBe(200);
  expect(response.headers.get("content-type")).toContain("zip");
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const raw = await persistence.readRaw(native.id);
  expect(raw).toBeDefined();
  expect(new TextDecoder().decode(files[raw!.filename])).toBe(raw!.content);
  const exported = raw!.content
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line));
  expect(exported).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "user/message",
        data: expect.objectContaining({
          id: "actual-user-id",
          source: { kind: "user" },
        }),
      }),
      expect.objectContaining({ type: "turn/start" }),
      expect.objectContaining({ type: "turn/end" }),
      expect.objectContaining({
        type: "workagent/native/event",
        data: expect.objectContaining({
          toolCallId: "actual-tool",
          output: { files: ["a.txt"] },
        }),
      }),
    ]),
  );
  expect(
    exported.some(
      (event) => event.type === "step/start" || event.type === "request/header",
    ),
  ).toBe(false);
  await persistence.nativeLog.dispose();
  await query.close();
});
