import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  WorkspaceStore,
  workspaceDirectoryName,
  type Workspace,
} from "./workspace-store.js";
import { SessionIndex } from "./session-index.js";

type Move = { id: string; source: string; destination: string };
type Journal = { complete: boolean; projects: Workspace[]; moves: Move[] };

const save = (path: string, value: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
};

const boundedDirectory = (root: string, path: string) => {
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || dirname(path) !== root)
    throw new Error("unsafe_workspace_root");
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("unsafe_workspace_root");
  }
};

/** Run only while employee runtimes are stopped. A journal makes interrupted moves resumable. */
export function migrateWorkspaceDirectories(
  root: string,
  dshHome: string,
  dryRun = false,
): Move[] {
  if (!isAbsolute(root) || !isAbsolute(dshHome))
    throw new Error("absolute roots required");
  root = resolve(root);
  const store = new WorkspaceStore(root, dshHome);
  const journalPath = join(
    dshHome,
    "workagent",
    "workspace-directory-migration.json",
  );
  const prior: Journal | undefined = existsSync(journalPath)
    ? JSON.parse(readFileSync(journalPath, "utf8"))
    : undefined;
  let journal: Journal;
  if (prior && !prior.complete) {
    journal = prior;
  } else {
    const projects = store.list();
    const moves: Move[] = [];
    const reserved = new Set(
      readdirSync(root).map((name) => name.toLowerCase()),
    );
    for (const project of projects) {
      if (project.directory !== undefined) continue;
      const directory = workspaceDirectoryName(project.name);
      const source = join(root, project.id);
      const destination = join(root, directory);
      boundedDirectory(root, source);
      boundedDirectory(root, destination);
      if (!existsSync(source))
        throw new Error(`workspace_source_missing:${project.id}`);
      if (reserved.has(directory.toLowerCase()))
        throw new Error(`workspace_directory_exists:${directory}`);
      reserved.add(directory.toLowerCase());
      moves.push({ id: project.id, source, destination });
      project.directory = directory;
    }
    journal = { complete: false, projects, moves };
  }
  for (const move of journal.moves) {
    boundedDirectory(root, move.source);
    boundedDirectory(root, move.destination);
    if (existsSync(move.source) && existsSync(move.destination))
      throw new Error(`workspace_directory_exists:${move.destination}`);
    if (!existsSync(move.source) && !existsSync(move.destination))
      throw new Error(`workspace_source_missing:${move.id}`);
  }
  if (dryRun || journal.moves.length === 0) return journal.moves;
  if (!prior || prior.complete) save(journalPath, journal);
  for (const move of journal.moves) {
    if (existsSync(move.source)) renameSync(move.source, move.destination);
  }
  updateWorkspaceSessionPaths(dshHome, journal.moves);
  save(join(dshHome, "workagent", "workspaces.json"), journal.projects);
  save(journalPath, { ...journal, complete: true });
  return journal.moves;
}

/** Update explicit shared-session paths; ordinary sessions retain their stable workspace IDs. */
export function updateWorkspaceSessionPaths(
  dshHome: string,
  moves: Move[],
): void {
  const index = new SessionIndex(dshHome);
  for (const session of index.list()) {
    if (session.workspacePath === undefined) continue;
    for (const move of moves) {
      const rel = relative(move.source, session.workspacePath);
      if (
        isAbsolute(rel) ||
        rel === ".." ||
        rel.startsWith(`..\\`) ||
        rel.startsWith("../")
      )
        continue;
      index.set({ ...session, workspacePath: resolve(move.destination, rel) });
      break;
    }
  }
}
