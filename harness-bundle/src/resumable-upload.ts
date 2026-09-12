import { randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceEntry } from "./workspace-store.js";
import { MAX_UPLOAD_BYTES } from "@workagent/contracts/upload-policy";

export type UploadSession = {
  id: string;
  workspaceId: string;
  path: string;
  name: string;
  size: number;
  lastModified: number;
  offset: number;
  createdAt: number;
  updatedAt: number;
  completed?: WorkspaceEntry;
  conflict?: "rename";
};
const chunkLimit = 8 * 1024 * 1024;
const lifetime = 7 * 24 * 60 * 60 * 1000;

export class ResumableUploads {
  readonly #busy = new Set<string>();
  constructor(
    readonly root: string,
    readonly validate: (workspaceId: string, path: string) => void,
    readonly commit: (
      workspaceId: string,
      path: string,
      stream: AsyncIterable<Uint8Array>,
      conflict?: "rename",
    ) => Promise<WorkspaceEntry>,
    readonly keepReceipts = false,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.cleanup();
  }
  #paths(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("upload_not_found");
    return {
      metadata: join(this.root, `${id}.json`),
      data: join(this.root, `${id}.part`),
    };
  }
  #save(row: UploadSession) {
    const path = this.#paths(row.id).metadata;
    writeFileSync(`${path}.tmp`, JSON.stringify(row), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  cleanup() {
    const now = Date.now();
    for (const name of readdirSync(this.root)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const row = JSON.parse(
        readFileSync(join(this.root, name), "utf8"),
      ) as UploadSession;
      if (now - row.updatedAt > lifetime && !this.#busy.has(row.id)) {
        const paths = this.#paths(row.id);
        rmSync(paths.data, { force: true });
        rmSync(paths.metadata, { force: true });
      }
    }
  }
  list(workspaceId: string) {
    this.validate(workspaceId, "");
    this.cleanup();
    return readdirSync(this.root)
      .filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))
      .map(
        (name) =>
          JSON.parse(
            readFileSync(join(this.root, name), "utf8"),
          ) as UploadSession,
      )
      .filter((row) => row.workspaceId === workspaceId && !row.completed)
      .map((row) => this.get(workspaceId, row.id));
  }
  get(workspaceId: string, id: string): UploadSession {
    const paths = this.#paths(id);
    if (!existsSync(paths.metadata)) throw new Error("upload_not_found");
    const row = JSON.parse(
      readFileSync(paths.metadata, "utf8"),
    ) as UploadSession;
    if (row.workspaceId !== workspaceId) throw new Error("upload_not_found");
    if (row.completed) {
      this.validate(workspaceId, "");
      return row;
    }
    this.validate(workspaceId, row.path);
    // The durable file length also recovers a crash between data and metadata writes.
    return { ...row, offset: statSync(paths.data).size };
  }
  create(
    workspaceId: string,
    input: {
      path: string;
      name: string;
      size: number;
      lastModified: number;
      conflict?: "rename";
    },
  ) {
    if (
      !input.path ||
      typeof input.path !== "string" ||
      typeof input.name !== "string" ||
      input.name.length > 255 ||
      !Number.isSafeInteger(input.size) ||
      input.size < 0 ||
      !Number.isSafeInteger(input.lastModified) ||
      input.lastModified < 0 ||
      (input.conflict !== undefined && input.conflict !== "rename")
    )
      throw new Error("invalid_upload");
    if (input.size > MAX_UPLOAD_BYTES) throw new Error("request_too_large");
    this.validate(workspaceId, input.path);
    this.cleanup();
    if (
      readdirSync(this.root).filter((name) => name.endsWith(".part")).length >=
      32
    )
      throw new Error("upload_limit_reached");
    const row: UploadSession = {
      ...input,
      id: randomUUID(),
      workspaceId,
      offset: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    writeFileSync(this.#paths(row.id).data, Buffer.alloc(0), {
      mode: 0o600,
      flag: "wx",
    });
    this.#save(row);
    return row;
  }
  async append(
    workspaceId: string,
    id: string,
    offset: number,
    source: AsyncIterable<Uint8Array>,
  ) {
    if (this.#busy.has(id)) throw new Error("upload_busy");
    this.#busy.add(id);
    try {
      const row = this.get(workspaceId, id);
      if (!Number.isSafeInteger(offset) || offset !== row.offset)
        throw new Error("upload_offset_conflict");
      const file = await open(this.#paths(id).data, "r+");
      let added = 0;
      try {
        for await (const value of source) {
          added += value.byteLength;
          if (added > chunkLimit || row.offset + added > row.size)
            throw new Error("invalid_upload_chunk");
          let position = 0;
          while (position < value.byteLength) {
            const { bytesWritten } = await file.write(
              value,
              position,
              value.byteLength - position,
              offset + added - value.byteLength + position,
            );
            position += bytesWritten;
          }
        }
        await file.sync();
      } catch (error) {
        await file.truncate(offset);
        throw error;
      } finally {
        await file.close();
      }
      row.offset += added;
      row.updatedAt = Date.now();
      this.#save(row);
      return row;
    } finally {
      this.#busy.delete(id);
    }
  }
  async finish(workspaceId: string, id: string) {
    if (this.#busy.has(id)) throw new Error("upload_busy");
    this.#busy.add(id);
    try {
      const row = this.get(workspaceId, id);
      if (row.offset !== row.size) throw new Error("upload_incomplete");
      if (row.completed) return row.completed;
      const paths = this.#paths(id);
      async function* content() {
        yield* createReadStream(paths.data);
      }
      const result = await this.commit(
        workspaceId,
        row.path,
        content(),
        row.conflict,
      );
      if (this.keepReceipts)
        this.#save({ ...row, completed: result, updatedAt: Date.now() });
      rmSync(paths.data, { force: true });
      if (!this.keepReceipts) rmSync(paths.metadata, { force: true });
      return result;
    } finally {
      this.#busy.delete(id);
    }
  }
  cancel(workspaceId: string, id: string) {
    if (this.#busy.has(id)) throw new Error("upload_busy");
    this.get(workspaceId, id);
    const paths = this.#paths(id);
    rmSync(paths.data, { force: true });
    rmSync(paths.metadata, { force: true });
  }
}
