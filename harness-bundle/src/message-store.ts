import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type StoredMessage = {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
};

const validMessage = (value: unknown): value is StoredMessage => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.sessionId === "string" &&
    (item.role === "user" || item.role === "assistant") &&
    typeof item.text === "string" &&
    typeof item.createdAt === "string"
  );
};

const safeSessionId = (sessionId: string): string => {
  if (!/^session-[a-zA-Z0-9-]+$/.test(sessionId))
    throw new Error("invalid_session_id");
  return sessionId;
};

export class MessageStore {
  readonly #root: string;
  readonly #seen = new Map<string, Set<string>>();

  constructor(dshHome: string) {
    this.#root = join(dshHome, "workagent", "personal-work", "messages");
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
  }

  list(sessionId: string): StoredMessage[] {
    const path = this.#path(sessionId);
    if (!existsSync(path)) {
      this.#seen.set(sessionId, new Set());
      return [];
    }
    const messages = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line): StoredMessage => {
        const parsed: unknown = JSON.parse(line);
        if (!validMessage(parsed) || parsed.sessionId !== sessionId)
          throw new Error("WorkAgent message log is invalid");
        return parsed;
      });
    this.#seen.set(sessionId, new Set(messages.map((message) => message.id)));
    return messages;
  }

  append(message: StoredMessage): void {
    safeSessionId(message.sessionId);
    const seen = this.#seen.get(message.sessionId);
    const ids =
      seen ?? new Set(this.list(message.sessionId).map((item) => item.id));
    if (ids.has(message.id)) return;
    const path = this.#path(message.sessionId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(message)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    ids.add(message.id);
    this.#seen.set(message.sessionId, ids);
  }

  delete(sessionId: string): void {
    const path = this.#path(sessionId);
    this.#seen.delete(sessionId);
    if (!existsSync(path)) return;
    const trash = join(this.#root, ".trash");
    mkdirSync(trash, { recursive: true, mode: 0o700 });
    renameSync(
      path,
      join(trash, `${Date.now()}-${safeSessionId(sessionId)}.jsonl`),
    );
  }

  #path(sessionId: string): string {
    return join(this.#root, `${safeSessionId(sessionId)}.jsonl`);
  }
}
