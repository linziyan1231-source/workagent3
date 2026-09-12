import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SharedAwareness,
  diffSnapshots,
  isAbsoluteWorkspacePath,
  resolveSharedProjectRoot,
  sharedChangesText,
  snapshotTree,
} from "./shared-awareness.js";

const roots: string[] = [];
const awarenesses: SharedAwareness[] = [];
afterEach(() => {
  for (const awareness of awarenesses.splice(0)) awareness.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wa-shared-awareness-"));
  roots.push(root);
  return root;
}

function awareness(enableWatch = false) {
  const instance = new SharedAwareness(enableWatch);
  awarenesses.push(instance);
  return instance;
}

const stateOf = (path: string) => {
  const stat = statSync(path);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("workspace path validation", () => {
  it("accepts win32 drive-letter and UNC absolute paths, rejects relative ones", () => {
    expect(isAbsoluteWorkspacePath("C:\\shared\\owner\\project")).toBe(true);
    expect(isAbsoluteWorkspacePath("D:/shared/owner/project")).toBe(true);
    expect(isAbsoluteWorkspacePath("\\\\server\\share\\project")).toBe(true);
    expect(isAbsoluteWorkspacePath("shared/owner/project")).toBe(false);
    expect(isAbsoluteWorkspacePath("")).toBe(false);
    expect(isAbsoluteWorkspacePath(".workagent")).toBe(false);
  });
});

describe("shared project root re-resolution", () => {
  it("finds the project under whichever owner currently holds it", () => {
    const base = fixture();
    mkdirSync(join(base, "owner-a", "project-1"), { recursive: true });
    expect(resolveSharedProjectRoot(base, "project-1")).toBe(
      join(base, "owner-a", "project-1"),
    );
    // Ownership transfer: the folder moves to another owner's root.
    mkdirSync(join(base, "owner-b"), { recursive: true });
    rmSync(join(base, "owner-a", "project-1"), { recursive: true });
    mkdirSync(join(base, "owner-b", "project-1"));
    expect(resolveSharedProjectRoot(base, "project-1")).toBe(
      join(base, "owner-b", "project-1"),
    );
  });

  it("fails clearly when the project is missing, ambiguous, or the id is unsafe", () => {
    const base = fixture();
    mkdirSync(join(base, "owner-a", "project-1"), { recursive: true });
    mkdirSync(join(base, "owner-b", "project-1"), { recursive: true });
    expect(() => resolveSharedProjectRoot(base, "missing")).toThrow(
      "shared_project_not_found",
    );
    expect(() => resolveSharedProjectRoot(base, "project-1")).toThrow(
      "shared_project_ambiguous",
    );
    expect(() => resolveSharedProjectRoot(base, "..")).toThrow(
      "shared_project_not_found",
    );
    expect(() => resolveSharedProjectRoot(base, "a/b")).toThrow(
      "shared_project_not_found",
    );
  });
});

describe("snapshot diff fallback", () => {
  it("reports created, modified and deleted files between turns", () => {
    const root = fixture();
    writeFileSync(join(root, "kept.txt"), "kept");
    writeFileSync(join(root, "changed.txt"), "before");
    writeFileSync(join(root, "removed.txt"), "gone");
    const before = snapshotTree(root);
    writeFileSync(join(root, "created.txt"), "new");
    writeFileSync(join(root, "changed.txt"), "after -- longer");
    rmSync(join(root, "removed.txt"));
    const diff = diffSnapshots(before, snapshotTree(root));
    expect(diff).toEqual({
      created: ["created.txt"],
      modified: ["changed.txt"],
      deleted: ["removed.txt"],
    });
  });

  it("skips excluded directories and respects the file cap", () => {
    const root = fixture();
    for (const directory of [
      ".git",
      "node_modules",
      ".workagent-trash",
      ".workagent-journal",
    ]) {
      mkdirSync(join(root, directory, "nested"), { recursive: true });
      writeFileSync(join(root, directory, "nested", "ignored.txt"), "x");
    }
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "kept.txt"), "y");
    const snapshot = snapshotTree(root);
    expect([...snapshot.keys()]).toEqual(["docs/kept.txt"]);
    writeFileSync(join(root, "a.txt"), "1");
    writeFileSync(join(root, "b.txt"), "2");
    expect(snapshotTree(root, { maxFiles: 2 }).size).toBe(2);
  });

  it("takes a silent baseline on the first turn, then diffs per session", () => {
    const root = fixture();
    writeFileSync(join(root, "existing.txt"), "v1");
    const shared = awareness();
    const first = shared.changes("session-1", root, 0);
    expect(first.paths).toEqual([]);
    writeFileSync(join(root, "created.txt"), "new");
    writeFileSync(join(root, "existing.txt"), "v1 extended");
    const second = shared.changes("session-1", root, first.cursor);
    expect(second.paths).toEqual(["created.txt", "existing.txt"]);
    expect(second.cursor).toBeGreaterThanOrEqual(first.cursor);
    expect(shared.changes("session-1", root, second.cursor).paths).toEqual([]);
    // A second session on the same root keeps an independent baseline.
    expect(shared.changes("session-2", root, 0).paths).toEqual([]);
  });

  it("excludes the session's own writes until the file changes externally", () => {
    const root = fixture();
    const shared = awareness();
    const first = shared.changes("session-1", root, 0);
    // The session writes draft.txt itself: the observation records its state.
    writeFileSync(join(root, "draft.txt"), "mine");
    shared.observeOwn("session-1", root, join(root, "draft.txt"), stateOf(join(root, "draft.txt")));
    writeFileSync(join(root, "theirs.txt"), "other");
    expect(shared.changes("session-1", root, first.cursor).paths).toEqual([
      "theirs.txt",
    ]);
    // A collaborator then edits the session's file: it reappears until re-read.
    writeFileSync(join(root, "draft.txt"), "mine, edited externally");
    const second = shared.changes("session-1", root, first.cursor);
    expect(second.paths).toEqual(["draft.txt"]);
    shared.observeOwn("session-1", root, join(root, "draft.txt"), stateOf(join(root, "draft.txt")));
    expect(shared.changes("session-1", root, second.cursor).paths).toEqual([]);
    // Own absence observations (a failed read) drop the known state, so a
    // disappearance the session already saw is not re-reported as news.
    writeFileSync(join(root, "gone.txt"), "x");
    const third = shared.changes("session-1", root, second.cursor);
    expect(third.paths).toEqual(["gone.txt"]);
    rmSync(join(root, "gone.txt"));
    shared.forgetOwn("session-1", root, join(root, "gone.txt"));
    expect(shared.changes("session-1", root, third.cursor).paths).toEqual([]);
  });

  it("releases the root once the last session leaves", () => {
    const root = fixture();
    const shared = awareness();
    shared.changes("session-1", root, 0);
    shared.changes("session-2", root, 0);
    shared.release("session-1");
    writeFileSync(join(root, "late.txt"), "x");
    // session-2 is still tracked and keeps diffing normally.
    expect(shared.changes("session-2", root, 0).paths).toEqual(["late.txt"]);
    shared.release("session-2");
    // Retracking starts fresh with a silent baseline.
    expect(shared.changes("session-3", root, 0).paths).toEqual([]);
  });
});

describe("watcher decision logic", () => {
  it("attaches a recursive watcher when supported and reports changes by cursor", async () => {
    const root = fixture();
    const shared = awareness(true);
    expect(shared.watching(root)).toBe(false);
    const first = shared.changes("session-1", root, 0);
    if (!shared.watching(root)) return; // Platform without recursive watch: fallback covered above.
    await sleep(20);
    writeFileSync(join(root, "watched.txt"), "external");
    let paths: string[] = [];
    let cursor = first.cursor;
    for (let attempt = 0; attempt < 50 && paths.length === 0; attempt++) {
      await sleep(100);
      const next = shared.changes("session-1", root, cursor);
      cursor = next.cursor;
      paths = next.paths;
    }
    expect(paths).toContain("watched.txt");
    // The same event is not reported twice against the advanced cursor.
    expect(shared.changes("session-1", root, cursor).paths).toEqual([]);
  });
});

describe("shared changes context text", () => {
  it("renders nothing without changes and the hint with paths otherwise", () => {
    expect(sharedChangesText([])).toBe("");
    const text = sharedChangesText(["docs/a.txt", "b.txt"]);
    expect(text).toContain("共享文件夹提示");
    expect(text).toContain('"docs/a.txt"');
    expect(text).toContain("编辑前请先重新读取这些文件。");
    expect(sharedChangesText(Array.from({ length: 60 }, (_, i) => `f${i}.txt`))).toContain("等 60 个文件");
  });
});

describe("snapshot limits", () => {
  it("stops walking once the time budget is exhausted", () => {
    const root = fixture();
    writeFileSync(join(root, "a.txt"), "1");
    const snapshot = snapshotTree(root, { maxMs: 0 });
    expect(snapshot.size).toBe(0);
    expect(existsSync(join(root, "a.txt"))).toBe(true);
  });
});
