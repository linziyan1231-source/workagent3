import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { WorkspaceSearch } from "./workspace-search.js";
describe("project search", () => {
  it("releases abandoned cursors without consuming all 16 slots", async () => {
    const search = new WorkspaceSearch(
      () => "",
      (_id, path) => ({
        fileId: path,
        name: path,
        path,
        kind: "file",
        size: 0,
        modifiedAt: "",
      }),
    );
    search.walk = async function* () {
      yield "match";
      yield "next";
    };
    for (let index = 0; index < 40; index++) {
      const result = await search.search("workspace", "match", undefined, 1);
      expect(result.nextCursor).toBeTruthy();
      await expect(search.release("other", result.nextCursor!)).rejects.toThrow(
        "invalid_search_cursor",
      );
      await search.release("workspace", result.nextCursor!);
      await search.release("workspace", result.nextCursor!);
    }
  });
  it("counts active scans toward admission and discards an aborted scan before returning a cursor", async () => {
    const search = new WorkspaceSearch(
      () => "",
      (_id, path) => ({
        fileId: path,
        name: path,
        path,
        kind: "file",
        size: 0,
        modifiedAt: "",
      }),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    search.walk = async function* () {
      await gate;
      yield "match";
    };
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const active = controllers.map((controller) =>
      search.search("workspace", "match", undefined, 1, controller.signal),
    );
    await expect(
      search.search("workspace", "match", undefined, 1),
    ).rejects.toThrow("search_busy");
    controllers[0]!.abort();
    const aborted = expect(active[0]).rejects.toThrow();
    release();
    await aborted;
    for (const pending of active.slice(1)) {
      const result = await pending;
      await search.release("workspace", result.nextCursor!);
    }
    const next = await search.search("workspace", "match", undefined, 1);
    await search.release("workspace", next.nextCursor!);
  });
  it("recurses and binds pagination to query and workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "search-"));
    try {
      mkdirSync(join(root, "deep"));
      mkdirSync(join(root, ".workagent"));
      writeFileSync(join(root, "deep", "中文.txt"), "a");
      writeFileSync(join(root, "中文.txt"), "b");
      writeFileSync(join(root, ".workagent", "中文.txt"), "private");
      const search = new WorkspaceSearch(
        (_id, path) => join(root, path),
        (_id, path) => ({
          fileId: path,
          name: path.split("/").at(-1)!,
          path,
          kind: "file",
          size: 1,
          modifiedAt: "",
        }),
      );
      const first = await search.search("a", "中文", undefined, 1);
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).toBeTruthy();
      await expect(
        search.search("b", "中文", first.nextCursor!, 1),
      ).rejects.toThrow("invalid_search_cursor");
      const rows = [...first.items];
      let cursor = first.nextCursor;
      while (cursor) {
        const next = await search.search("a", "中文", cursor, 1);
        rows.push(...next.items);
        cursor = next.nextCursor;
      }
      expect(rows.map((row) => row.path).sort()).toEqual([
        "deep/中文.txt",
        "中文.txt",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
