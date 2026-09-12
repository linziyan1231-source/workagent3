import { opendir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { WorkspaceEntry } from "./workspace-store.js";

type Query = {
  workspace: string;
  query: string;
  touched: number;
  iterator: AsyncGenerator<string | undefined>;
  expiry?: ReturnType<typeof setTimeout>;
};
export class WorkspaceSearch {
  readonly #queries = new Map<string, Query>();
  readonly #active = new Set<Query>();
  constructor(
    private readonly directory: (id: string, path: string) => string,
    private readonly locate: (id: string, path: string) => WorkspaceEntry,
  ) {}
  async *walk(
    id: string,
    path = "",
    depth = 0,
  ): AsyncGenerator<string | undefined> {
    if (depth > 256) throw new Error("search_depth_exceeded");
    let dir;
    try {
      dir = await opendir(this.directory(id, path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for await (const entry of dir) {
      if (
        [".workagent", ".workagent-trash"].includes(entry.name) ||
        entry.isSymbolicLink()
      )
        continue;
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        yield undefined;
        yield* this.walk(id, child, depth + 1);
      } else if (entry.isFile()) {
        yield child;
      }
    }
  }
  async release(workspace: string, cursor: string): Promise<void> {
    const state = this.#queries.get(cursor);
    if (!state) return;
    if (state.workspace !== workspace) throw new Error("invalid_search_cursor");
    this.#queries.delete(cursor);
    clearTimeout(state.expiry);
    await state.iterator.return(undefined);
  }
  async search(
    workspace: string,
    query: string,
    cursor: string | undefined,
    limit: number,
    signal?: AbortSignal,
  ) {
    if (
      query.length > 256 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      throw new Error("invalid_search");
    for (const [key, value] of this.#queries)
      if (Date.now() - value.touched > 60_000) {
        this.#queries.delete(key);
        clearTimeout(value.expiry);
        await value.iterator.return(undefined);
      }
    let state = cursor ? this.#queries.get(cursor) : undefined;
    if (
      cursor &&
      (!state || state.workspace !== workspace || state.query !== query)
    )
      throw new Error("invalid_search_cursor");
    if (!state) {
      if (this.#queries.size + this.#active.size >= 16)
        throw new Error("search_busy");
      state = {
        workspace,
        query,
        touched: Date.now(),
        iterator: this.walk(workspace),
      };
    }
    if (cursor) {
      this.#queries.delete(cursor);
      clearTimeout(state.expiry);
    }
    this.#active.add(state);
    const items: WorkspaceEntry[] = [];
    const started = Date.now();
    let done = false;
    try {
      for (
        let scanned = 0;
        scanned < 1000 && items.length < limit && Date.now() - started < 250;
        scanned++
      ) {
        signal?.throwIfAborted();
        const result = await state.iterator.next();
        if (result.done) {
          done = true;
          break;
        }
        if (
          result.value?.toLocaleLowerCase().includes(query.toLocaleLowerCase())
        ) {
          try {
            items.push(this.locate(workspace, result.value));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
      signal?.throwIfAborted();
      if (done) return { items, nextCursor: null };
      const nextCursor = randomUUID();
      state.touched = Date.now();
      this.#queries.set(nextCursor, state);
      const pending = state;
      state.expiry = setTimeout(() => {
        if (this.#queries.get(nextCursor) !== pending) return;
        this.#queries.delete(nextCursor);
        void pending.iterator.return(undefined).catch(() => {});
      }, 60_000);
      state.expiry.unref();
      return { items, nextCursor };
    } catch (error) {
      await state.iterator.return(undefined);
      throw error;
    } finally {
      this.#active.delete(state);
    }
  }
}
