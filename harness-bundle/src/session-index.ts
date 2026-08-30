import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type StoredSession = {
  id: string;
  nativeId: string;
  engine: "harness" | "codex" | "kimi";
  title: string;
  createdAt: string;
  updatedAt: string;
  workspaceId?: string;
};

const valid = (value: unknown): value is StoredSession => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.nativeId === "string" &&
    (item.engine === "harness" ||
      item.engine === "codex" ||
      item.engine === "kimi") &&
    typeof item.title === "string" &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string" &&
    (item.workspaceId === undefined || typeof item.workspaceId === "string")
  );
};

export class SessionIndex {
  readonly #path: string;
  readonly #sessions = new Map<string, StoredSession>();

  constructor(dshHome: string) {
    this.#path = join(dshHome, "workagent", "sessions.json");
    if (!existsSync(this.#path)) return;
    const parsed: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
    if (!Array.isArray(parsed) || !parsed.every(valid))
      throw new Error("WorkAgent session index is invalid");
    for (const session of parsed) this.#sessions.set(session.id, session);
  }

  list(): StoredSession[] {
    return [...this.#sessions.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  set(session: StoredSession): void {
    this.#sessions.set(session.id, session);
    this.#save();
  }

  delete(id: string): void {
    if (!this.#sessions.delete(id)) return;
    this.#save();
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.list(), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, this.#path);
  }
}
