import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MessageStore } from "./message-store.js";

describe("MessageStore", () => {
  it("persists messages, deduplicates events, and deletes recoverably", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-messages-"));
    const message = {
      id: "turn-1",
      sessionId: "session-1",
      role: "assistant" as const,
      text: "Finished",
      createdAt: "2026-08-30T10:00:00.000Z",
      nativeTurnId: "native-turn-1",
    };
    const store = new MessageStore(home);
    store.append(message);
    store.append(message);

    expect(new MessageStore(home).list("session-1")).toEqual([message]);
    store.delete("session-1");
    expect(store.list("session-1")).toEqual([]);
  });

  it("rejects a session ID that could escape its private root", () => {
    const store = new MessageStore(
      mkdtempSync(join(tmpdir(), "workagent-messages-")),
    );
    expect(() => store.list("../other-session")).toThrow("invalid_session_id");
  });
});
