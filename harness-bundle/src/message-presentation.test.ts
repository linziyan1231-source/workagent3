import { Context } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { CodexSession } from "./engines/codex.js";
import { NativeSessionLog } from "./native-session-log.js";
import { nativeSessionProjection } from "./native-session-projection.js";
import { engineEventSchema } from "@workagent/contracts";

afterEach(() => vi.unstubAllEnvs());

it("separates streamed commentary and native async prompts without changing final text", () => {
  const emit = vi.fn();
  const session = new CodexSession({} as never, "native", emit, () => {});
  const item = {
    type: "agentMessage",
    id: "msg-progress",
    phase: "commentary",
    text: "",
  };
  session.notification("item/started", { turnId: "t", item });
  session.notification("item/agentMessage/delta", {
    turnId: "t",
    itemId: item.id,
    delta: "正在读文件",
  });
  expect(emit).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: "commentary", delta: "正在读文件" }),
  );
  session.notification("item/completed", {
    turnId: "t",
    item: { ...item, text: "正在读文件" },
  });
  expect(emit).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: "commentary", content: "正在读文件" }),
  );
  session.notification("item/completed", {
    turnId: "t",
    item: {
      type: "agentMessage",
      id: "call-question",
      phase: null,
      text: "学校？",
    },
  });
  // The native protocol uses call_ (not arbitrary question wording).
  session.notification("item/completed", {
    turnId: "t",
    item: {
      type: "agentMessage",
      id: "call_question",
      phase: null,
      text: "学校？",
    },
  });
  expect(emit).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: "question", content: "学校？" }),
  );
  session.notification("item/completed", {
    turnId: "t",
    item: {
      type: "agentMessage",
      id: "msg-answer",
      phase: "final_answer",
      text: "读完了。学校？",
    },
  });
  expect(emit).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: "answer", content: "读完了。学校？" }),
  );
  session.notification("item/completed", {
    turnId: "t",
    item: { type: "agentMessage", id: "old", text: "普通问句？" },
  });
  expect(emit.mock.calls.at(-1)![0]).not.toHaveProperty("kind");
  // Validate the adapter's actual output, including pre-kind legacy items.
  for (const [payload] of emit.mock.calls) {
    const event = {
      ...payload,
      eventId: "session-1-7",
      sessionId: "session-1",
      occurredAt: "2026-09-01T12:00:00.000Z",
    };
    expect(engineEventSchema.parse(event)).toEqual(event);
  }
});

it("moves commentary deltas into the process projection, keeping the answer stream separate", () => {
  const initial = nativeSessionProjection.init();
  const state = nativeSessionProjection.apply(initial, {
    type: "workagent/native/event",
    seq: 0,
    time: 1,
    data: {
      type: "assistant.delta",
      kind: "commentary",
      messageId: "m",
      turnId: "t",
      delta: "检查材料",
    },
  });
  expect(state.draft).toBe("");
  expect(state.processes["commentary-m"]?.text).toBe("检查材料");
});

it("recovers historical kinds from native evidence and replays them once without rewriting messages", async () => {
  const home = mkdtempSync(join(tmpdir(), "message-presentation-"));
  const codex = join(home, "codex");
  vi.stubEnv("CODEX_HOME", codex);
  const directory = join(codex, "sessions", "2026", "09", "10");
  mkdirSync(directory, { recursive: true });
  const rollout = join(
    directory,
    "rollout-2026-09-10T23-39-50-native-id.jsonl",
  );
  const records = [
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        id: "m1",
        phase: "commentary",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input_async",
        call_id: "q1",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        id: "m2",
        phase: "final_answer",
      },
    },
  ];
  const raw = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(rollout, raw);
  const messages = ["正在读文件", "学校？", "读完了。学校？", "旧消息？"].map(
    (text, i) => ({
      id: ["m1", "q1", "m2", "unknown"][i]!,
      sessionId: "session-presentation",
      role: "assistant" as const,
      text,
      createdAt: "2026-09-10T15:40:00Z",
      nativeTurnId: "t",
    }),
  );
  const meta = {
    id: "session-presentation",
    engine: "codex",
    nativeId: "native-id",
    workspacePath: home,
  };
  const ctx = new Context();
  new SessionStore(ctx);
  const log = new NativeSessionLog(ctx, home);
  const session = log.open(meta, messages);
  expect(log.messages(meta.id).map((m) => m.text)).toEqual(
    messages.map((m) => m.text),
  );
  expect(log.messages(meta.id).map((m) => m.kind)).toEqual([
    "commentary",
    "question",
    "answer",
    undefined,
  ]);
  const state = session.events.reduce(
    (s, event) => nativeSessionProjection.apply(s, event),
    nativeSessionProjection.init(),
  );
  expect(state.messages.map((m) => m.id)).toEqual(["q1", "m2", "unknown"]);
  expect(state.messages[1]?.text).toBe("读完了。学校？");
  expect(state.processes["commentary-m1"]?.text).toBe("正在读文件");
  await log.dispose();
  const ctx2 = new Context();
  new SessionStore(ctx2);
  const reopened = new NativeSessionLog(ctx2, home);
  const restored = reopened.open(meta, []);
  expect(
    restored.events.filter((e) => e.type === "workagent/native/message-kind"),
  ).toHaveLength(3);
  expect(readFileSync(rollout, "utf8")).toBe(raw);
  await reopened.dispose();
});
