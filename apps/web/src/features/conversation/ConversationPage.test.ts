import { describe, expect, it } from "vitest";
import type { EngineEvent } from "@workagent/contracts";
import { reduceMessages } from "./ConversationPage.js";

const event = (value: Partial<EngineEvent>): EngineEvent =>
  ({
    eventId: "event-1",
    occurredAt: "2026-08-30T10:00:00.000Z",
    sessionId: "session-1",
    turnId: "turn-1",
    ...value,
  }) as EngineEvent;

describe("conversation event projection", () => {
  it("assembles deltas and replaces them with the completed message", () => {
    const partial = reduceMessages(
      [],
      event({ type: "assistant.delta", delta: "Hel" }),
    );
    const more = reduceMessages(
      partial,
      event({ type: "assistant.delta", delta: "lo" }),
    );
    const complete = reduceMessages(
      more,
      event({ type: "assistant.completed", content: "Hello!" }),
    );

    expect(complete).toEqual([
      { id: "turn-1", role: "assistant", text: "Hello!" },
    ]);
  });
});
