import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("rollback exports canonical additions and retires the stale authority without deleting its audit history", () => {
  const root = mkdtempSync(join(tmpdir(), "wa3-native-rollback-"));
  try {
    const base = join(root, "workagent", "personal-work");
    const source = join(base, "native-sessions", "v1");
    const messages = join(base, "messages");
    const backup = join(root, "rollback");
    mkdirSync(source, { recursive: true });
    mkdirSync(messages, { recursive: true });
    const old = {
      id: "old",
      sessionId: "session-test",
      role: "user",
      text: "before",
      createdAt: "2026-09-07",
    };
    const added = { ...old, id: "added", role: "assistant", text: "after" };
    const target = join(messages, "session-test.jsonl");
    writeFileSync(target, JSON.stringify(old) + "\n");
    writeFileSync(
      join(source, "session-test.jsonl"),
      [
        { id: "session-test" },
        ...[old, added].map((data, seq) => ({
          seq,
          type: "workagent/native/message",
          data,
        })),
      ]
        .map((row) => JSON.stringify(row) + "\n")
        .join(""),
    );
    const run = (mode) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("./rollback-native-session-log.mjs", import.meta.url),
          ),
          root,
          backup,
          mode,
        ],
        { encoding: "utf8" },
      );
    assert.equal(run("check").status, 0);
    assert.equal(existsSync(backup), false);
    const applied = run("apply");
    assert.equal(applied.status, 0, applied.stderr);
    assert.deepEqual(
      readFileSync(target, "utf8").trim().split("\n").map(JSON.parse),
      [old, added],
    );
    assert.equal(existsSync(source), false);
    assert.equal(
      existsSync(join(backup, "native-v1", "session-test.jsonl")),
      true,
    );
    assert.equal(
      JSON.parse(readFileSync(join(backup, "session-test.jsonl"), "utf8")).text,
      "before",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
