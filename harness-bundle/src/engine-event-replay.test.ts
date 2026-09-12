import { expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { engineEventSchema } from "@workagent/contracts";
import { KimiSession } from "./engines/kimi.js";
import { NativeSessionLog } from "./native-session-log.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeEvent } from "./engines/types.js";

it("keeps real ACP incremental tool facts and replays the same existing log format", async () => {
  const events: BridgeEvent[] = [];
  let finish!: (value: { stopReason: "end_turn" }) => void;
  const session = new KimiSession(
    {
      prompt: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    } as never,
    "kimi-1",
    (event) => events.push(event),
    () => {},
  );
  await session.send("read file");
  session.update({
    sessionId: "kimi-1",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "read",
      status: "in_progress",
      rawInput: { path: "a.ts" },
    },
  });
  session.update({
    sessionId: "kimi-1",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "in_progress",
      locations: [{ path: "a.ts", line: 2 }],
      rawOutput: { line: "hello" },
    },
  });
  session.update({
    sessionId: "kimi-1",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      rawOutput: { line: "done" },
    },
  });
  finish({ stopReason: "end_turn" });
  await Promise.resolve();
  expect(events.some((event) => event.type === "tool.updated")).toBe(true);
  const complete = events.map((event, index) => ({
    ...event,
    eventId: `session-1-${index}`,
    sessionId: "session-1",
    occurredAt: "2026-09-01T12:00:00.000Z",
  }));
  expect(complete.map((event) => engineEventSchema.parse(event))).toEqual(
    complete,
  );
  const home = mkdtempSync(join(tmpdir(), "event-contract-replay-"));
  const metadata = {
    id: "session-1",
    engine: "kimi",
    workspacePath: process.cwd(),
    createdAt: "2026-09-01T12:00:00.000Z",
  };
  const ctx = new Context();
  new SessionStore(ctx);
  const log = new NativeSessionLog(ctx, home);
  log.open(metadata, []);
  for (const event of complete)
    log.appendEvent("session-1", JSON.parse(JSON.stringify(event)));
  // Older logs may contain native extensions with no public event envelope.
  log.appendEvent("session-1", {
    type: "unknown-native-fact",
    raw: { future: [null, true] },
  });
  const original = log.get("session-1")!;
  await log.dispose();
  const before = original.events;
  const restoredCtx = new Context();
  new SessionStore(restoredCtx);
  const restored = new NativeSessionLog(restoredCtx, home);
  const replay = restored.open(metadata, []).events;
  expect(replay.slice(0, before.length)).toEqual(before);
  // SessionStore seals an older seed on adoption; existing persisted facts
  // retain their sequence and payload without conversion or re-encoding.
  expect(
    replay
      .slice(before.length)
      .every((event) => event.type === "session/end-seed"),
  ).toBe(true);
  await restored.dispose();
});
