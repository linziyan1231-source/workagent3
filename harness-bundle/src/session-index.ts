import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  presetBindingSchema,
  sessionLastTurnSchema,
  type PresetBinding,
  type RuntimeSession,
} from "@workagent/contracts";

export type QueuedInput = {
  messageId: string;
  content: string;
  displayContent?: string;
  error?: string;
};

export type StoredSession = {
  id: string;
  nativeId: string;
  engine: "harness" | "codex" | "kimi";
  title: string;
  createdAt: string;
  updatedAt: string;
  workspaceId?: string;
  workspacePath?: string;
  channelKey?: string;
  internal?: boolean;
  modelId?: string;
  thinkingEffort?: string;
  permissionMode?: "read_only" | "workspace_write" | "full_access";
  preset?: PresetBinding;
  lastTurn?: RuntimeSession["lastTurn"];
  parentSessionId?: string;
  branchKind?: "fork" | "edit" | "side_chat";
  anchorMessageId?: string;
  contextMode?: "native" | "transcript";
  pendingContext?: string;
  queue?: QueuedInput[];
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
    (item.queue === undefined ||
      (Array.isArray(item.queue) &&
        item.queue.every(
          (row) =>
            row &&
            typeof row.messageId === "string" &&
            typeof row.content === "string" &&
            (row.displayContent === undefined ||
              typeof row.displayContent === "string") &&
            (row.error === undefined || typeof row.error === "string"),
        ))) &&
    (item.parentSessionId === undefined ||
      typeof item.parentSessionId === "string") &&
    (item.anchorMessageId === undefined ||
      typeof item.anchorMessageId === "string") &&
    (item.pendingContext === undefined ||
      typeof item.pendingContext === "string") &&
    (item.contextMode === undefined ||
      item.contextMode === "native" ||
      item.contextMode === "transcript") &&
    (item.branchKind === undefined ||
      ["fork", "edit", "side_chat"].includes(String(item.branchKind))) &&
    (item.lastTurn === undefined ||
      sessionLastTurnSchema.safeParse(item.lastTurn).success) &&
    (item.workspaceId === undefined || typeof item.workspaceId === "string") &&
    (item.channelKey === undefined || typeof item.channelKey === "string") &&
    (item.workspacePath === undefined ||
      typeof item.workspacePath === "string") &&
    (item.internal === undefined || typeof item.internal === "boolean") &&
    (item.modelId === undefined || typeof item.modelId === "string") &&
    (item.thinkingEffort === undefined ||
      typeof item.thinkingEffort === "string") &&
    (item.permissionMode === undefined ||
      item.permissionMode === "read_only" ||
      item.permissionMode === "workspace_write" ||
      item.permissionMode === "full_access") &&
    (item.preset === undefined ||
      presetBindingSchema.safeParse(item.preset).success)
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
