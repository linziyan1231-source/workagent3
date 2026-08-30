import { describe, expect, it } from "vitest";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { eventsAfterLastId, normalizeEvent } from "./runtime.js";

const events = [
  { eventId: "session-with-hyphens-9" },
  { eventId: "session-with-hyphens-10" },
  { eventId: "session-with-hyphens-11" },
];

describe("SSE event replay", () => {
  it("resumes after the exact event ID without lexical sequence ordering", () => {
    expect(eventsAfterLastId(events, "session-with-hyphens-9")).toEqual(
      events.slice(1),
    );
  });

  it("replays retained events when the client cursor is unknown", () => {
    expect(eventsAfterLastId(events, "expired-event-id")).toEqual(events);
  });
});

describe("terminal turn normalization", () => {
  const session = { id: "session-1" } as Session;
  const turnEnd = (reason: unknown) =>
    normalizeEvent(session, {
      type: "turn/end",
      seq: 4,
      time: Date.parse("2026-08-31T00:00:00.000Z"),
      data: { turn: 2, reason },
    } as SessionEvent);

  it("publishes an explicit success only for a completed turn", () => {
    expect(turnEnd({ kind: "completed" })).toMatchObject({
      type: "turn.completed",
      turnId: "turn-2",
    });
  });

  it("does not mistake blocked or interrupted turns for success", () => {
    expect(turnEnd({ kind: "blocked" })).toMatchObject({
      type: "turn.failed",
      code: "turn_blocked",
    });
    expect(turnEnd({ kind: "interrupted" })).toMatchObject({
      type: "turn.failed",
      code: "turn_interrupted",
    });
  });
});
