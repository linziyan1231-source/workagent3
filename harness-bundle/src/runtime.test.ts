import { describe, expect, it } from "vitest";
import { eventsAfterLastId } from "./runtime.js";

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
