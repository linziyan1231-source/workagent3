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
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { randomUUID } from "node:crypto";
import { link, open, rename, rm, writeFile } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { FileMoves } from "./file-moves.js";
import { WorkspaceSearch } from "./workspace-search.js";
import { ResumableUploads } from "./resumable-upload.js";

import { MAX_UPLOAD_BYTES } from "@workagent/contracts/upload-policy";
export { MAX_UPLOAD_BYTES } from "@workagent/contracts/upload-policy";

export type Workspace = {
  id: string;
  name: string;
  /** Fixed folder name; absent only for projects created before named directories. */
  directory?: string;
  scope?: "personal" | "team";
  createdAt: string;
};

export type WorkspaceEntry = {
  fileId?: string;
  name: string;
  path: string;
  kind: "directory" | "file";
  size: number;
  modifiedAt: string;
};

export type WorkspaceAsset = {
  fileId?: string;
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
    (item.directory === undefined || typeof item.directory === "string") &&
    (item.scope === undefined ||
      item.scope === "personal" ||
      item.scope === "team") &&
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

export const workspaceDirectoryName = (name: string): string => {
  const value = validComponent(name, "invalid_workspace_name");
  if (
    value.length > 120 ||
    /[<>:"/\\|?*\x00-\x1f]/.test(value) ||
    /[. ]$/.test(value) ||
    /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value) ||
    value.toLowerCase().startsWith(".workagent")
  )
    throw new Error("invalid_workspace_name");
  return value;
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
  readonly search = new WorkspaceSearch(
    (id, path) => this.#resolve(id, path, true),
    (id, path) => this.locate(id, path),
  );
  readonly uploads: ResumableUploads;
  readonly moves: FileMoves;
  readonly #root: string;
  readonly #indexPath: string;
  readonly #assetIndexPath: string;
  readonly #attachmentRoot: string;
  readonly #workspaces = new Map<string, Workspace>();
  readonly #assets = new Map<string, WorkspaceAsset>();

  constructor(
    root: string,
    dshHome: string,
    readonly shared = false,
    readonly recycleShared?: (
      projectId: string,
      path: string,
    ) => Promise<unknown>,
  ) {
    if (!isAbsolute(root)) throw new Error("workspace root must be absolute");
    this.#root = resolve(root);
    this.#indexPath = join(dshHome, "workagent", "workspaces.json");
    this.#assetIndexPath = join(dshHome, "workagent", "workspace-assets.json");
    this.#attachmentRoot = join(dshHome, "workagent", "chat-attachments");
    this.uploads = new ResumableUploads(
      join(dshHome, "workagent", "uploads"),
      (id, path) => {
        this.#resolve(id, path, true, true);
      },
      (id, path, stream, conflict) =>
        this.writeStream(id, path, stream, false, conflict === "rename"),
      true,
    );
    if (!shared) mkdirSync(this.#root, { recursive: true, mode: 0o700 });
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
    this.moves = new FileMoves(
      join(dshHome, "workagent", "file-moves.json"),
      (id, path, missing) => {
        if (
          path
            .replaceAll("\\", "/")
            .split("/")
            .some((part) => part.toLowerCase().startsWith(".workagent"))
        )
          throw new Error("invalid_move");
        return this.#resolve(id, path, false, missing);
      },
      (id, moves) => {
        for (const move of moves)
          for (const asset of this.#assets.values()) {
            if (
              asset.workspaceId === id &&
              (asset.path === move.source ||
                asset.path.startsWith(move.source + "/"))
            ) {
              asset.path =
                move.destination + asset.path.slice(move.source.length);
              asset.name = basename(asset.path);
            }
          }
        this.#saveAssets();
      },
    );
  }

  list(): Workspace[] {
    return [...this.#workspaces.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  get(id: string): Workspace | undefined {
    if (this.shared) {
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) return undefined;
      const root = join(this.#root, id);
      if (!existsSync(root)) return undefined;
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
      return {
        id,
        name: id,
        directory: id,
        scope: "team",
        createdAt: stat.birthtime.toISOString(),
      };
    }
    return this.#workspaces.get(id);
  }

  create(name: string, scope: "personal" | "team" = "personal"): Workspace {
    const directory = workspaceDirectoryName(name);
    if (
      readdirSync(this.#root).some(
        (entry) => entry.toLowerCase() === directory.toLowerCase(),
      )
    )
      throw new Error("workspace_directory_exists");
    const workspace: Workspace = {
      id: `workspace-${randomUUID()}`,
      name: directory,
      directory,
      scope,
      createdAt: new Date().toISOString(),
    };
    try {
      mkdirSync(join(this.#root, directory), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error("workspace_directory_exists");
      throw error;
    }
    this.#workspaces.set(workspace.id, workspace);
    this.#save();
    return workspace;
  }

  ensureDefault(): Workspace {
    const workspaces = this.list();
    return (
      workspaces.find((workspace) => workspace.name === "Personal workspace") ??
      workspaces.find((workspace) => workspace.scope !== "team") ??
      this.create("Personal workspace")
    );
  }

  rename(id: string, name: string): Workspace {
    const workspace = this.#workspaces.get(id);
    if (workspace === undefined) throw new Error("workspace_not_found");
    workspace.name = name;
    this.#save();
    return workspace;
  }

  remove(id: string): void {
    if (!this.#workspaces.has(id)) throw new Error("workspace_not_found");
    const source = this.#workspaceRoot(id);
    const trashRoot = join(this.#root, ".workagent-project-trash");
    mkdirSync(trashRoot, { mode: 0o700, recursive: true });
    renameSync(source, join(trashRoot, `${Date.now()}-${randomUUID()}-${id}`));
    this.moves.removeWorkspace(id);
    this.#workspaces.delete(id);
    for (const [assetId, asset] of this.#assets) {
      if (asset.workspaceId === id) this.#assets.delete(assetId);
    }
    this.#save();
    this.#saveAssets();
  }

  engineRoot(id: string): string {
    return this.#workspaceRoot(id);
  }

  locate(
    id: string,
    reference: string,
    fileId?: string,
    historical = false,
  ): WorkspaceEntry {
    let path = (
      isAbsolute(reference)
        ? relative(this.#workspaceRoot(id), reference)
        : reference
    ).replaceAll("\\", "/");
    if (fileId || historical) path = this.moves.reference(id, path, fileId);
    const absolute = this.#resolve(id, path, false);
    const stat = statSync(absolute);
    if (!stat.isFile()) throw new Error("not_a_file");
    return {
      fileId: this.moves.identify(id, path),
      path,
      name: basename(absolute),
      kind: "file",
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
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
          fileId: this.moves.identify(id, child),
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

  async readStream(
    id: string,
    path: string,
    fileId?: string,
    historical = false,
  ) {
    if (fileId || historical) path = this.moves.reference(id, path, fileId);
    const file = await open(this.#resolve(id, path, false), "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("not_a_file");
      return { size: stat.size, stream: file.createReadStream() };
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async writeStream(
    id: string,
    path: string,
    content: AsyncIterable<Uint8Array>,
    overwrite = true,
    renameOnConflict = false,
  ): Promise<WorkspaceEntry> {
    this.moves.writes.set(id, (this.moves.writes.get(id) ?? 0) + 1);
    try {
      return await this.#writeStream(
        id,
        path,
        content,
        overwrite,
        renameOnConflict,
      );
    } finally {
      this.moves.writes.set(id, (this.moves.writes.get(id) ?? 1) - 1);
    }
  }

  async #writeStream(
    id: string,
    path: string,
    content: AsyncIterable<Uint8Array>,
    overwrite = true,
    renameOnConflict = false,
  ): Promise<WorkspaceEntry> {
    let absolute = this.#resolve(id, path, false, true);
    if (!overwrite && !renameOnConflict && existsSync(absolute))
      throw new Error("destination_exists");
    const storage = this.#storage(id, validateRelativePath(path, false));
    const staging = join(storage.root, ".workagent", "uploads");
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    this.#assertNoLinks(storage.root, staging, false);
    const temporary = join(staging, `${randomUUID()}.part`);
    const file = await open(temporary, "wx", 0o600);
    async function* limited() {
      let size = 0;
      for await (const chunk of content) {
        size += chunk.byteLength;
        if (size > MAX_UPLOAD_BYTES) throw new Error("request_too_large");
        yield chunk;
      }
    }
    try {
      try {
        // writeFile consumes the iterable incrementally with backpressure.
        await writeFile(file, limited());
      } finally {
        await file.close();
      }
      // Recheck after the upload: folders may have changed while receiving it.
      this.#resolve(id, path, false, true);
      mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
      this.#assertNoLinks(storage.root, dirname(absolute), false);
      if (overwrite) await rename(temporary, absolute);
      else {
        const extension = extname(path);
        const stem = path.slice(0, path.length - extension.length);
        let suffix = 0;
        for (;;) {
          try {
            // Atomically publish once; conflicts reuse the same completed bytes.
            await link(temporary, absolute);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (!renameOnConflict) throw new Error("destination_exists");
            path = `${stem} (${++suffix})${extension}`;
            absolute = this.#resolve(id, path, false, true);
          }
        }
      }
      const stat = statSync(absolute);
      return {
        fileId: this.moves.identify(id, validateRelativePath(path, false)),
        name: basename(absolute),
        path: validateRelativePath(path, false),
        kind: "file",
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  editText(
    id: string,
    path: string,
    original: string,
    text: string,
  ): WorkspaceEntry {
    const absolute = this.#resolve(id, path, false);
    if (
      statSync(absolute).size > 2 * 1024 * 1024 ||
      Buffer.byteLength(text) > 2 * 1024 * 1024
    )
      throw new Error("request_too_large");
    const bytes = readFileSync(absolute);
    if (!isUtf8(bytes)) throw new Error("unsupported_text_encoding");
    const current = bytes.toString("utf8");
    // Fetch's UTF-8 decoder removes a BOM. Preserve it when saving Windows files.
    const bom =
      current.startsWith("\uFEFF") && !original.startsWith("\uFEFF")
        ? "\uFEFF"
        : "";
    if (current !== bom + original) throw new Error("file_changed");
    return this.write(id, path, Buffer.from(bom + text, "utf8"));
  }

  write(
    id: string,
    path: string,
    content: Buffer,
    overwrite = true,
  ): WorkspaceEntry {
    const absolute = this.#resolve(id, path, false, true);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    this.#assertNoLinks(this.#workspaceRoot(id), dirname(absolute), true);
    if (!overwrite) {
      try {
        writeFileSync(absolute, content, { mode: 0o600, flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error("destination_exists");
        throw error;
      }
    } else {
      const temporary = join(
        dirname(absolute),
        `.${basename(absolute)}.${process.pid}.tmp`,
      );
      writeFileSync(temporary, content, { mode: 0o600 });
      renameSync(temporary, absolute);
    }
    const stat = statSync(absolute);
    return {
      fileId: this.moves.identify(id, validateRelativePath(path, false)),
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
      .map((asset) => {
        if (
          !asset.fileId &&
          existsSync(this.#resolve(workspaceId, asset.path, false, true))
        )
          asset.fileId = this.moves.identify(workspaceId, asset.path);
        return asset;
      })
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

  async addAttachmentStream(
    workspaceId: string,
    sessionId: string,
    name: string,
    mediaType: string,
    content: AsyncIterable<Uint8Array>,
  ): Promise<WorkspaceAsset> {
    const safeSession = validComponent(sessionId, "invalid_session_id");
    const safeName = validComponent(name, "invalid_asset_name");
    const id = `asset-${randomUUID()}`;
    const path = `.workagent/sessions/${safeSession}/attachments/${id}-${safeName}`;
    const entry = await this.writeStream(workspaceId, path, content, false);
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
    const result = this.moves.request(id, [{ source, destination }]);
    if (result.state === "failed") throw new Error(result.error);
  }

  delete(id: string, path: string): void | Promise<void> {
    const source = this.#resolve(id, path, false);
    if (this.shared) {
      const recycle = this.recycleShared;
      if (!recycle) throw new Error("shared_trash_unavailable");
      this.moves.writes.set(id, (this.moves.writes.get(id) ?? 0) + 1);
      return (async () => {
        try {
          await recycle(id, path);
          this.moves.deleted(id, path);
        } finally {
          this.moves.writes.set(id, (this.moves.writes.get(id) ?? 1) - 1);
        }
      })();
    }
    const trashRoot = join(this.#workspaceRoot(id), ".workagent-trash");
    mkdirSync(trashRoot, { mode: 0o700, recursive: true });
    const target = join(
      trashRoot,
      `${Date.now()}-${randomUUID()}-${basename(source)}`,
    );
    renameSync(source, target);
    this.moves.deleted(id, path);
  }

  #workspaceRoot(id: string): string {
    if ((this.shared || id !== "default") && !this.get(id))
      throw new Error("workspace_not_found");
    const root = join(
      this.#root,
      id === "default"
        ? ".workagent-unassigned"
        : validComponent(
            this.get(id)!.directory ?? id,
            "unsafe_workspace_root",
          ),
    );
    if (id === "default") mkdirSync(root, { recursive: true, mode: 0o700 });
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
    const { root, path: storedPath } = this.#storage(id, normalized);
    const target = resolve(root, storedPath);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("path_outside_workspace");
    this.#assertNoLinks(root, target, allowMissing);
    return target;
  }

  /** Virtual attachment paths resolve outside project files, under employee data. */
  #storage(id: string, path: string): { root: string; path: string } {
    const project = this.#workspaceRoot(id);
    const prefix = ".workagent-attachments/";
    if (!path.startsWith(prefix)) return { root: project, path };
    const root = join(
      this.#attachmentRoot,
      validComponent(id, "invalid_workspace_name"),
    );
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.#assertNoLinks(dirname(this.#attachmentRoot), root, false);
    return { root, path: path.slice(prefix.length) };
  }

  referencePath(id: string, path: string, fileId?: string): string {
    path = this.moves.reference(id, path, fileId);
    const absolute = this.#resolve(id, path, false);
    if (!statSync(absolute).isFile()) throw new Error("not_a_file");
    return absolute;
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
    asset.fileId = this.moves.identify(asset.workspaceId, asset.path);
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
