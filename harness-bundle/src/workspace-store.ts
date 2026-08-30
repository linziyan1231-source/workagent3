import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { randomUUID } from "node:crypto";

export type Workspace = {
  id: string;
  name: string;
  createdAt: string;
};

export type WorkspaceEntry = {
  name: string;
  path: string;
  kind: "directory" | "file";
  size: number;
  modifiedAt: string;
};

export type WorkspaceAsset = {
  id: string;
  workspaceId: string;
  sessionId: string;
  kind: "attachment" | "artifact";
  name: string;
  path: string;
  mediaType: string;
  size: number;
  createdAt: string;
};

const validWorkspace = (value: unknown): value is Workspace => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.createdAt === "string"
  );
};

const validAsset = (value: unknown): value is WorkspaceAsset => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.workspaceId === "string" &&
    typeof item.sessionId === "string" &&
    (item.kind === "attachment" || item.kind === "artifact") &&
    typeof item.name === "string" &&
    typeof item.path === "string" &&
    typeof item.mediaType === "string" &&
    typeof item.size === "number" &&
    typeof item.createdAt === "string"
  );
};

const validComponent = (value: string, error: string): string => {
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    trimmed.length > 255 ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes(":")
  )
    throw new Error(error);
  return trimmed;
};

const validateRelativePath = (value: string, allowEmpty = true): string => {
  const normalized = value.replaceAll("\\", "/");
  if (normalized === "" && allowEmpty) return "";
  if (
    normalized === "" ||
    isAbsolute(value) ||
    normalized.startsWith("/") ||
    normalized.includes(":") ||
    normalized
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error("invalid_relative_path");
  return normalized;
};

export class WorkspaceStore {
  readonly #root: string;
  readonly #indexPath: string;
  readonly #assetIndexPath: string;
  readonly #workspaces = new Map<string, Workspace>();
  readonly #assets = new Map<string, WorkspaceAsset>();

  constructor(root: string, dshHome: string) {
    if (!isAbsolute(root)) throw new Error("workspace root must be absolute");
    this.#root = resolve(root);
    this.#indexPath = join(dshHome, "workagent", "workspaces.json");
    this.#assetIndexPath = join(dshHome, "workagent", "workspace-assets.json");
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    if (existsSync(this.#indexPath)) {
      const parsed: unknown = JSON.parse(readFileSync(this.#indexPath, "utf8"));
      if (!Array.isArray(parsed) || !parsed.every(validWorkspace))
        throw new Error("WorkAgent workspace index is invalid");
      for (const workspace of parsed)
        this.#workspaces.set(workspace.id, workspace);
    }
    if (existsSync(this.#assetIndexPath)) {
      const parsed: unknown = JSON.parse(
        readFileSync(this.#assetIndexPath, "utf8"),
      );
      if (!Array.isArray(parsed) || !parsed.every(validAsset))
        throw new Error("WorkAgent workspace asset index is invalid");
      for (const asset of parsed) this.#assets.set(asset.id, asset);
    }
  }

  list(): Workspace[] {
    return [...this.#workspaces.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  get(id: string): Workspace | undefined {
    return this.#workspaces.get(id);
  }

  create(name: string): Workspace {
    const workspace: Workspace = {
      id: `workspace-${randomUUID()}`,
      name,
      createdAt: new Date().toISOString(),
    };
    mkdirSync(join(this.#root, workspace.id), { mode: 0o700 });
    this.#workspaces.set(workspace.id, workspace);
    this.#save();
    return workspace;
  }

  ensureDefault(): Workspace {
    return this.list()[0] ?? this.create("Personal workspace");
  }

  engineRoot(id: string): string {
    return this.#workspaceRoot(id);
  }

  listFiles(id: string, path = ""): WorkspaceEntry[] {
    const directory = this.#resolve(id, path, true);
    if (!statSync(directory).isDirectory()) throw new Error("not_a_directory");
    return readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.name !== ".workagent-trash" &&
          entry.name !== ".workagent" &&
          (entry.isDirectory() || entry.isFile()),
      )
      .map((entry): WorkspaceEntry => {
        const absolute = join(directory, entry.name);
        const stat = statSync(absolute);
        const child = path === "" ? entry.name : `${path}/${entry.name}`;
        return {
          name: entry.name,
          path: child,
          kind: entry.isDirectory() ? "directory" : "file",
          size: entry.isFile() ? stat.size : 0,
          modifiedAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) =>
        a.kind === b.kind
          ? a.name.localeCompare(b.name)
          : a.kind === "directory"
            ? -1
            : 1,
      );
  }

  read(id: string, path: string): Buffer {
    const absolute = this.#resolve(id, path, false);
    const stat = statSync(absolute);
    if (!stat.isFile()) throw new Error("not_a_file");
    return readFileSync(absolute);
  }

  write(id: string, path: string, content: Buffer): WorkspaceEntry {
    const absolute = this.#resolve(id, path, false, true);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    this.#assertNoLinks(this.#workspaceRoot(id), dirname(absolute), true);
    const temporary = join(
      dirname(absolute),
      `.${basename(absolute)}.${process.pid}.tmp`,
    );
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, absolute);
    const stat = statSync(absolute);
    return {
      name: basename(absolute),
      path: validateRelativePath(path, false),
      kind: "file",
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  listAssets(workspaceId: string, sessionId: string): WorkspaceAsset[] {
    this.#workspaceRoot(workspaceId);
    return [...this.#assets.values()]
      .filter(
        (asset) =>
          asset.workspaceId === workspaceId && asset.sessionId === sessionId,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  addAttachment(
    workspaceId: string,
    sessionId: string,
    name: string,
    mediaType: string,
    content: Buffer,
  ): WorkspaceAsset {
    const safeSession = validComponent(sessionId, "invalid_session_id");
    const safeName = validComponent(name, "invalid_asset_name");
    const id = `asset-${randomUUID()}`;
    const path = `.workagent/sessions/${safeSession}/attachments/${id}-${safeName}`;
    const entry = this.write(workspaceId, path, content);
    return this.#addAsset({
      id,
      workspaceId,
      sessionId,
      kind: "attachment",
      name: safeName,
      path,
      mediaType: mediaType.trim() || "application/octet-stream",
      size: entry.size,
      createdAt: new Date().toISOString(),
    });
  }

  registerArtifact(
    workspaceId: string,
    sessionId: string,
    path: string,
    name?: string,
    mediaType = "application/octet-stream",
  ): WorkspaceAsset {
    validComponent(sessionId, "invalid_session_id");
    const normalizedPath = validateRelativePath(path, false);
    const absolute = this.#resolve(workspaceId, normalizedPath, false);
    const stat = statSync(absolute);
    if (!stat.isFile()) throw new Error("not_a_file");
    return this.#addAsset({
      id: `asset-${randomUUID()}`,
      workspaceId,
      sessionId,
      kind: "artifact",
      name: validComponent(name ?? basename(absolute), "invalid_asset_name"),
      path: normalizedPath,
      mediaType: mediaType.trim() || "application/octet-stream",
      size: stat.size,
      createdAt: new Date().toISOString(),
    });
  }

  mkdir(id: string, path: string): void {
    const absolute = this.#resolve(id, path, false, true);
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    this.#assertNoLinks(this.#workspaceRoot(id), absolute, false);
  }

  move(id: string, source: string, destination: string): void {
    const from = this.#resolve(id, source, false);
    const to = this.#resolve(id, destination, false, true);
    if (existsSync(to)) throw new Error("destination_exists");
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    this.#assertNoLinks(this.#workspaceRoot(id), dirname(to), true);
    renameSync(from, to);
  }

  delete(id: string, path: string): void {
    const source = this.#resolve(id, path, false);
    const trashRoot = join(this.#workspaceRoot(id), ".workagent-trash");
    mkdirSync(trashRoot, { mode: 0o700, recursive: true });
    const target = join(
      trashRoot,
      `${Date.now()}-${randomUUID()}-${basename(source)}`,
    );
    renameSync(source, target);
  }

  #workspaceRoot(id: string): string {
    if (!this.#workspaces.has(id)) throw new Error("workspace_not_found");
    const root = join(this.#root, id);
    if (!existsSync(root)) throw new Error("workspace_not_found");
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("unsafe_workspace_root");
    return root;
  }

  #resolve(
    id: string,
    path: string,
    allowEmpty: boolean,
    allowMissing = false,
  ): string {
    const normalized = validateRelativePath(path, allowEmpty);
    const root = this.#workspaceRoot(id);
    const target = resolve(root, normalized);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("path_outside_workspace");
    this.#assertNoLinks(root, target, allowMissing);
    return target;
  }

  #assertNoLinks(root: string, target: string, allowMissing: boolean): void {
    const parts = relative(root, target).split(/[\\/]/).filter(Boolean);
    let cursor = root;
    for (const part of parts) {
      cursor = join(cursor, part);
      if (!existsSync(cursor)) {
        if (allowMissing) return;
        throw new Error("file_not_found");
      }
      if (lstatSync(cursor).isSymbolicLink())
        throw new Error("reparse_point_rejected");
    }
  }

  #save(): void {
    mkdirSync(dirname(this.#indexPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#indexPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.list(), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, this.#indexPath);
  }

  #addAsset(asset: WorkspaceAsset): WorkspaceAsset {
    this.#assets.set(asset.id, asset);
    this.#saveAssets();
    return asset;
  }

  #saveAssets(): void {
    mkdirSync(dirname(this.#assetIndexPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#assetIndexPath}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify([...this.#assets.values()], null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporary, this.#assetIndexPath);
  }
}
