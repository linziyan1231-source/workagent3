import { describe, expect, it } from "vitest";
import { engineEventSchema, skillMcpInventorySchema } from "./index.js";

describe("engine events", () => {
  it("accepts the minimal normalized assistant event", () => {
    const event = engineEventSchema.parse({
      type: "assistant.delta",
      eventId: "evt-1",
      occurredAt: "2026-08-30T10:00:00+08:00",
      sessionId: "session-1",
      turnId: "turn-1",
      delta: "hello",
    });

    expect(event.type).toBe("assistant.delta");
  });

  it("rejects an event outside the public runtime contract", () => {
    expect(() => engineEventSchema.parse({ type: "internal.trace" })).toThrow();
  });
});

describe("migration inventory", () => {
  it("requires a Windows SID as the tenant identity", () => {
    expect(() =>
      skillMcpInventorySchema.parse({
        schemaVersion: 1,
        sid: "user-a",
        capturedAt: "2026-08-30T10:00:00+08:00",
        skills: [],
        mcpServers: [],
        bindings: [],
        results: [],
      }),
    ).toThrow();
  });
});
