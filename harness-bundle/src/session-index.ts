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
  replyTo?: { id: string; text: string };
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
  fileRevision?: number;
  sharedCursor?: number;
  queue?: QueuedInput[];
  creation?: SessionCreation;
};

export type SessionCreation = {
  operationId: string;
  input: {
    engine: "harness" | "codex" | "kimi";
    title: string;
    workspace: string;
    presetId: string;
    modelId?: string;
    thinkingEffort?: string;
    permissionMode?: "read_only" | "workspace_write" | "full_access";
  };
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
    (item.sharedCursor === undefined ||
      typeof item.sharedCursor === "number") &&
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
  readonly #operationsPath: string;
  readonly #sessions = new Map<string, StoredSession>();
  readonly #cancelledOperations = new Set<string>();

  constructor(dshHome: string) {
    this.#path = join(dshHome, "workagent", "sessions.json");
    this.#operationsPath = join(
      dshHome,
      "workagent",
      "session-operations.json",
    );
    if (existsSync(this.#operationsPath)) {
      const parsed: unknown = JSON.parse(
        readFileSync(this.#operationsPath, "utf8"),
      );
      if (
        !Array.isArray(parsed) ||
        !parsed.every((id) => typeof id === "string")
      )
        throw new Error("WorkAgent session operations are invalid");
      for (const id of parsed) this.#cancelledOperations.add(id);
    }
    if (existsSync(this.#path)) {
      const parsed: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
      if (!Array.isArray(parsed) || !parsed.every(valid))
        throw new Error("WorkAgent session index is invalid");
      for (const session of parsed) this.#sessions.set(session.id, session);
    }
  }

  list(): StoredSession[] {
    return [...this.#sessions.values()]
      .filter(
        (session) =>
          !session.creation ||
          !this.#cancelledOperations.has(session.creation.operationId),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  operation(creation: SessionCreation): StoredSession | undefined {
    if (this.#cancelledOperations.has(creation.operationId))
      throw new Error("operation_deleted");
    const existing = [...this.#sessions.values()].find(
      (session) => session.creation?.operationId === creation.operationId,
    );
    if (
      existing &&
      JSON.stringify(existing.creation!.input) !==
        JSON.stringify(creation.input)
    )
      throw new Error("operation_conflict");
    return existing;
  }

  lookupOperation(operationId: string) {
    const session = [...this.#sessions.values()].find(
      (row) => row.creation?.operationId === operationId,
    );
    const cancelled = this.#cancelledOperations.has(operationId);
    if (!session && !cancelled) return undefined;
    return {
      session,
      state: cancelled ? (session ? "deleting" : "deleted") : "ready",
    };
  }

  cancelOperation(operationId: string): void {
    if (this.#cancelledOperations.has(operationId)) return;
    this.#save(this.#operationsPath, [
      ...this.#cancelledOperations,
      operationId,
    ]);
    this.#cancelledOperations.add(operationId);
  }

  createOnce(
    session: StoredSession & { creation: SessionCreation },
  ): StoredSession {
    const existing = this.operation(session.creation);
    if (existing) return existing;
    this.set(session);
    return session;
  }

  set(session: StoredSession): void {
    const sessions = new Map(this.#sessions);
    sessions.set(session.id, session);
    this.#save(this.#path, [...sessions.values()]);
    this.#sessions.set(session.id, session);
  }

  delete(id: string): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    // The intent must survive before removing the session. A crash between
    // these writes leaves a retryable deleting operation. Keep sessions.json
    // readable by rollback software, which has no tombstone filtering.
    if (session.creation) this.cancelOperation(session.creation.operationId);
    const sessions = new Map(this.#sessions);
    sessions.delete(id);
    this.#save(this.#path, [...sessions.values()]);
    this.#sessions.delete(id);
  }

  #save(path: string, rows: unknown[]): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(rows, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, path);
  }
}
