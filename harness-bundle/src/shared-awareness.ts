import { readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Directory names never reported as collaborator changes. */
export const SHARED_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".workagent-trash",
  ".workagent-journal",
]);

/** File state used for change detection and own-write exclusion. */
export type SharedFileState = { mtimeMs: number; size: number };

export type SharedSnapshotDiff = {
  created: string[];
  modified: string[];
  deleted: string[];
};

/** The gateway resolves shared paths on Windows; accept win32 and drive-letter forms. */
export const isAbsoluteWorkspacePath = (value: string): boolean =>
  isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);

const sharedProjectIdPattern = /^[A-Za-z0-9_-]+$/;

/**
 * Re-resolve a shared project root by scanning `<sharedBase>/<ownerSID>/<projectId>`.
 * The folder may sit under a different owner after an ownership transfer, so the
 * stored path is never trusted blindly. Exactly one normal-directory match resolves.
 */
export const resolveSharedProjectRoot = (
  sharedBase: string,
  projectId: string,
): string => {
  if (!sharedProjectIdPattern.test(projectId))
    throw new Error("shared_project_not_found");
  let found: string | undefined;
  for (const owner of readdirSync(sharedBase, { withFileTypes: true })) {
    if (!owner.isDirectory()) continue;
    const candidate = join(sharedBase, owner.name, projectId);
    try {
      const stat = statSync(candidate);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    if (found !== undefined) throw new Error("shared_project_ambiguous");
    found = candidate;
  }
  if (found === undefined) throw new Error("shared_project_not_found");
  return found;
};

/** Model-facing hint prepended to the next turn when collaborators changed files. */
export const sharedChangesText = (paths: readonly string[]): string =>
  paths.length === 0
    ? ""
    : `\n共享文件夹提示：以下文件自你上一轮结束后被其他协作者修改：${paths
        .slice(0, 50)
        .map((path) => JSON.stringify(path))
        .join("、")}${
        paths.length > 50 ? ` 等 ${paths.length} 个文件` : ""
      }。编辑前请先重新读取这些文件。\n\n`;

const isExcluded = (relativePath: string): boolean =>
  relativePath.split("/").some((segment) => SHARED_EXCLUDED_DIRS.has(segment));

/**
 * Snapshot a shared tree as (posix relative path -> state), skipping excluded
 * directories and stopping once either limit is hit.
 */
export const snapshotTree = (
  root: string,
  limits: { maxFiles?: number; maxMs?: number } = {},
): Map<string, SharedFileState> => {
  const maxFiles = limits.maxFiles ?? 5000;
  const deadline = Date.now() + (limits.maxMs ?? 2000);
  const snapshot = new Map<string, SharedFileState>();
  const stack = [""];
  while (
    stack.length > 0 &&
    snapshot.size < maxFiles &&
    Date.now() < deadline
  ) {
    const directory = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(join(root, directory), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SHARED_EXCLUDED_DIRS.has(entry.name)) stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = statSync(join(root, path));
        snapshot.set(path, { mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // Vanished mid-scan: simply absent from the snapshot.
      }
    }
  }
  return snapshot;
};

export const diffSnapshots = (
  before: ReadonlyMap<string, SharedFileState>,
  after: ReadonlyMap<string, SharedFileState>,
): SharedSnapshotDiff => {
  const diff: SharedSnapshotDiff = { created: [], modified: [], deleted: [] };
  for (const [path, state] of after) {
    const prior = before.get(path);
    if (prior === undefined) diff.created.push(path);
    else if (prior.mtimeMs !== state.mtimeMs || prior.size !== state.size)
      diff.modified.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) diff.deleted.push(path);
  return diff;
};

type RootWatch = {
  refs: Set<string>;
  watcher: FSWatcher | undefined;
  pending: Map<string, number>;
  timer: ReturnType<typeof setTimeout> | undefined;
  buffer: { path: string; ts: number }[];
};

type SessionAwareness = {
  rootKey: string;
  /** Per-path state this session is known to have seen (own reads/writes). */
  known: Map<string, SharedFileState>;
  /** Whole-tree baseline for the no-watcher fallback, taken per turn. */
  baseline: Map<string, SharedFileState> | undefined;
};

const BUFFER_LIMIT = 2048;
const DEBOUNCE_MS = 250;

/**
 * Per-shared-root change feeds, refcounted by the sessions on each root.
 * Prefers a recursive fs.watch ring buffer filtered by a per-session cursor;
 * where recursive watch is unsupported it falls back to per-turn snapshot
 * diffs. All state is in-memory; the durable cursor lives on the session
 * record like `fileRevision`.
 */
export class SharedAwareness {
  readonly #roots = new Map<string, RootWatch>();
  readonly #sessions = new Map<string, SessionAwareness>();

  constructor(private readonly enableWatch = true) {}

  /** Whether a live recursive watcher backs this root (vs the snapshot fallback). */
  watching(root: string): boolean {
    return this.#roots.get(resolve(root))?.watcher !== undefined;
  }

  /** Record a file state this session observed itself (own read/write/edit). */
  observeOwn(
    sessionId: string,
    root: string,
    absolutePath: string,
    state: SharedFileState,
  ): void {
    const path = this.#relative(root, absolutePath);
    const session = this.#sessions.get(sessionId);
    if (path === undefined || session === undefined) return;
    session.known.set(path, state);
    session.baseline?.set(path, state);
  }

  /** Record that a path this session observed is now gone. */
  forgetOwn(sessionId: string, root: string, absolutePath: string): void {
    const path = this.#relative(root, absolutePath);
    const session = this.#sessions.get(sessionId);
    if (path === undefined || session === undefined) return;
    session.known.delete(path);
    session.baseline?.delete(path);
  }

  /**
   * Changes made by others since `cursor` (a timestamp returned by the
   * previous call). Paths the session itself observed at their current state
   * are excluded. The returned cursor persists on the session record.
   */
  changes(
    sessionId: string,
    root: string,
    cursor: number,
  ): { paths: string[]; cursor: number } {
    const now = Date.now();
    const rootKey = resolve(root);
    const entry = this.#track(sessionId, rootKey);
    if (entry.watcher !== undefined) {
      this.#flush(entry);
      const seen = new Set<string>();
      for (const event of entry.buffer)
        if (event.ts > cursor) seen.add(event.path);
      const session = this.#sessions.get(sessionId)!;
      const paths = [...seen].filter((path) => {
        const known = session.known.get(path);
        let current: SharedFileState | undefined;
        try {
          const stat = statSync(join(rootKey, path));
          if (stat.isFile()) current = { mtimeMs: stat.mtimeMs, size: stat.size };
        } catch {
          current = undefined;
        }
        if (current === undefined) return known !== undefined;
        return (
          known === undefined ||
          known.mtimeMs !== current.mtimeMs ||
          known.size !== current.size
        );
      });
      return { paths: paths.sort(), cursor: now };
    }
    const session = this.#sessions.get(sessionId)!;
    const fresh = snapshotTree(rootKey);
    if (session.baseline === undefined) {
      session.baseline = fresh;
      return { paths: [], cursor: now };
    }
    const diff = diffSnapshots(session.baseline, fresh);
    session.baseline = fresh;
    return {
      paths: [...diff.created, ...diff.modified, ...diff.deleted].sort(),
      cursor: now,
    };
  }

  /** Stop tracking a session; closes the root watcher when the last ref leaves. */
  release(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    this.#sessions.delete(sessionId);
    const entry = this.#roots.get(session.rootKey);
    if (entry === undefined) return;
    entry.refs.delete(sessionId);
    if (entry.refs.size === 0) {
      entry.watcher?.close();
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      this.#roots.delete(session.rootKey);
    }
  }

  dispose(): void {
    for (const sessionId of [...this.#sessions.keys()]) this.release(sessionId);
  }

  #track(sessionId: string, rootKey: string): RootWatch {
    let session = this.#sessions.get(sessionId);
    if (session !== undefined && session.rootKey !== rootKey) {
      // The shared folder moved (ownership transfer): re-anchor the session.
      this.release(sessionId);
      session = undefined;
    }
    let entry = this.#roots.get(rootKey);
    if (entry === undefined) {
      entry = { refs: new Set(), watcher: undefined, pending: new Map(), timer: undefined, buffer: [] };
      this.#roots.set(rootKey, entry);
      if (this.enableWatch) this.#watch(rootKey, entry);
    }
    entry.refs.add(sessionId);
    if (session === undefined) {
      this.#sessions.set(sessionId, {
        rootKey,
        known: new Map(),
        baseline: undefined,
      });
    }
    return entry;
  }

  #watch(rootKey: string, entry: RootWatch): void {
    try {
      // Recursive watch requires Node >= 19.1 on Windows and Node >= 20 on
      // Linux; older runtimes throw ERR_FEATURE_NOT_SUPPORTED synchronously.
      const watcher = watch(rootKey, { recursive: true }, (_event, filename) => {
        if (typeof filename !== "string" || filename === "") return;
        const path = filename.replaceAll(sep, "/");
        if (isExcluded(path)) return;
        entry.pending.set(path, Date.now());
        entry.timer ??= setTimeout(() => this.#flush(entry), DEBOUNCE_MS);
        entry.timer.unref();
      });
      watcher.on("error", () => {
        watcher.close();
        if (entry.watcher === watcher) entry.watcher = undefined;
      });
      watcher.unref();
      entry.watcher = watcher;
    } catch {
      entry.watcher = undefined;
    }
  }

  #flush(entry: RootWatch): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    for (const [path, ts] of entry.pending) entry.buffer.push({ path, ts });
    entry.pending.clear();
    if (entry.buffer.length > BUFFER_LIMIT)
      entry.buffer.splice(0, entry.buffer.length - BUFFER_LIMIT);
  }

  #relative(root: string, absolutePath: string): string | undefined {
    const path = relative(resolve(root), resolve(absolutePath)).replaceAll(
      sep,
      "/",
    );
    if (path === "" || path === ".." || path.startsWith("../")) return undefined;
    return isExcluded(path) ? undefined : path;
  }
}
