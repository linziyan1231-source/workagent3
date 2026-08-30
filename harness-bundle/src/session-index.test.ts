import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionIndex } from "./session-index.js";

describe("SID-private session index", () => {
  it("persists only runtime metadata and reloads newest first", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-session-index-"));
    const index = new SessionIndex(home);
    index.set({
      id: "session-old",
      nativeId: "native-old",
      engine: "codex",
      title: "Old",
      createdAt: "2026-08-29T10:00:00.000Z",
      updatedAt: "2026-08-29T10:00:00.000Z",
    });
    index.set({
      id: "session-new",
      nativeId: "native-new",
      engine: "kimi",
      title: "New",
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:00:00.000Z",
    });

    expect(new SessionIndex(home).list().map((item) => item.id)).toEqual([
      "session-new",
      "session-old",
    ]);
    expect(
      readFileSync(join(home, "workagent", "sessions.json"), "utf8"),
    ).not.toContain("password");
  });
});
