import { expect, it } from "vitest";
import { engineEventSchema } from "./engine.js";

const envelope = {
  eventId: "session-one-7",
  occurredAt: "2026-09-01T10:00:00.000Z",
  sessionId: "session-one",
};
it.each([
  { type: "turn.retrying", turnId: "turn-1", message: "high demand" },
  {
    type: "assistant.delta",
    turnId: "turn-1",
    delta: "checking",
    messageId: "item-one",
    kind: "commentary",
  },
  {
    type: "assistant.completed",
    turnId: "turn-1",
    content: "Please choose",
    messageId: "item-two",
    kind: "question",
  },
  {
    type: "tool.updated",
    turnId: "turn-1",
    toolCallId: "call-1",
    tool: "read",
    input: { path: "a.ts" },
    output: [{ text: "line" }],
    locations: [{ path: "a.ts", line: 2 }],
    raw: { providerFact: { nested: [null, true, 12] } },
  },
  {
    type: "tool.completed",
    turnId: "turn-1",
    toolCallId: "call-1",
    failed: false,
    tool: "read",
    result: { content: "done" },
  },
  { type: "queue.changed" },
  { type: "message.created" },
])("retains current event facts: $type", (payload) => {
  const event = { ...envelope, ...payload };
  expect(engineEventSchema.parse(event)).toEqual(event);
});
it("continues accepting old assistant/tool logs with no optional identity or detail fields", () => {
  const old = [
    { ...envelope, type: "assistant.delta", turnId: "turn-1", delta: "hello" },
    {
      ...envelope,
      type: "assistant.completed",
      turnId: "turn-1",
      content: "hello",
    },
    {
      ...envelope,
      type: "tool.completed",
      turnId: "turn-1",
      toolCallId: "tool-1",
      failed: false,
    },
  ];
  expect(old.map((event) => engineEventSchema.parse(event))).toEqual(old);
});
it("rejects malformed known fields while allowing arbitrary JSON in native raw details", () => {
  expect(
    engineEventSchema.safeParse({
      ...envelope,
      type: "tool.updated",
      turnId: "turn-1",
      toolCallId: 42,
      raw: { future: true },
    }).success,
  ).toBe(false);
  expect(
    engineEventSchema.safeParse({
      ...envelope,
      type: "assistant.completed",
      turnId: "turn-1",
      content: "answer",
      kind: "misspelt",
    }).success,
  ).toBe(false);
});
