import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MessageStore } from "./message-store.js";
import { Context } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { NativeSessionLog } from "./native-session-log.js";

describe("MessageStore", () => {
  it("writes only the standard log after native adoption and retains the old import unchanged", async () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-native-messages-"));
    const ctx = new Context();
    new SessionStore(ctx);
    const log = new NativeSessionLog(ctx, home);
    const store = new MessageStore(home);
    const old = {
      id: "old",
      sessionId: "session-1",
      role: "user" as const,
      text: "old text",
      createdAt: "2026-09-07T00:00:00Z",
    };
    store.append(old);
    log.open(
      { id: "session-1", engine: "codex", workspacePath: home },
      store.list("session-1"),
    );
    store.project("session-1", {
      list: () => log.messages("session-1"),
      append: (m) => log.appendMessage(m),
      delete: () => log.delete("session-1"),
    });
    store.append({ ...old, id: "new", text: "new text" });
    expect(store.list("session-1").map((m) => m.text)).toEqual([
      "old text",
      "new text",
    ]);
    expect(new MessageStore(home).list("session-1")).toEqual([old]);
    await log.dispose();
  });
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
