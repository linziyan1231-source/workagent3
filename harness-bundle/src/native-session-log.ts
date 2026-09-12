import { MessageId, freezeMessage } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";
import {
  Session,
  SessionId,
  type SessionEvent,
  type SessionHeader,
  type JsonValue,
  type TurnEndReason,
} from "@deepseek-ai/dsh-session";
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { StoredMessage } from "./message-store.js";
import { readCodexMessageKinds } from "./codex-message-kinds.js";

export type NativeSessionEvent = { type: string; [key: string]: JsonValue };
export type NativeSessionMetadata = {
  id: string;
  engine: string;
  workspacePath: string;
  parentSessionId?: string;
  createdAt?: string | number;
  nativeId?: string;
};

declare module "@deepseek-ai/dsh-session" {
  interface SessionEventMap {
    "workagent/native/message": StoredMessage;
    "workagent/native/event": NativeSessionEvent;
    "workagent/native/imported": { version: 1 };
    "workagent/native/message-kind": {
      id: string;
      kind: NonNullable<StoredMessage["kind"]>;
    };
  }
  interface TurnEndReasonMap {
    "native-cancelled": { kind: "native-cancelled" };
  }
}

export function isNativeSession(session: Pick<Session, "header">): boolean {
  return session.header.agentPreset?.startsWith("workagent-native:") === true;
}

type Entry = { session: Session; detach: () => void; written: number };
const checkedId = (id: string): string => {
  if (!/^session-[a-zA-Z0-9_-]+$/.test(id))
    throw new Error("invalid_session_id");
  return id;
};

/** One canonical durable DSH event stream; visible messages are a rebuildable fold.
 * The ordinary persistence plugin must exclude these sessions: its coordinator
 * cannot restore required extension events in DSH 0.1.1-rc.2.
 */
export class NativeSessionLog {
  readonly #root: string;
  readonly #entries = new Map<string, Entry>();
  readonly #listeners: (() => void)[];
  #disposed = false;

  constructor(
    private readonly ctx: Context,
    dshHome: string,
    private readonly excludedPersistenceScope?: symbol,
  ) {
    this.#root = join(
      dshHome,
      "workagent",
      "personal-work",
      "native-sessions",
      "v1",
    );
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    this.#listeners = [
      ctx.on("session/event", (session) => {
        const entry = this.#entries.get(session.id);
        if (entry?.session === session) this.#persist(entry);
      }),
      ctx.on("session/flush", (session) => {
        const entry = this.#entries.get(session.id);
        if (entry?.session === session) this.#persist(entry);
      }),
    ];
  }

  open(meta: NativeSessionMetadata, legacyMessages: StoredMessage[]): Session {
    this.#assertAvailable(meta.id);
    const existing = this.#entries.get(meta.id);
    if (existing) return existing.session;
    const path = this.#path(meta.id);
    let session: Session;
    let written = 0;
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      const lines = raw.split("\n");
      // Only an incomplete final physical record is discardable. A malformed
      // newline-terminated record is committed corruption and must refuse.
      const final = lines.pop()!;
      let needsNewline = false;
      if (final) {
        try {
          JSON.parse(final);
          lines.push(final);
          needsNewline = true;
        } catch {
          truncateSync(path, Buffer.byteLength(raw) - Buffer.byteLength(final));
        }
      }
      const header = JSON.parse(lines.shift()!) as SessionHeader;
      const events = lines
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SessionEvent);
      session = this.ctx.sessions.prepare(SessionId(meta.id), {
        seed: events,
        meta: header,
        seedSource: "persistence",
      });
      if (
        !isNativeSession(session) ||
        session.header.cwd !== meta.workspacePath ||
        session.header.agentPreset !== `workagent-native:${meta.engine}`
      )
        throw new Error("native_session_metadata_mismatch");
      written = events.length;
      if (needsNewline) this.#write(path, "\n", "a");
    } else {
      session = this.ctx.sessions.prepare(SessionId(meta.id), {
        meta: {
          cwd: meta.workspacePath,
          agentPreset: `workagent-native:${meta.engine}`,
          ...(meta.parentSessionId
            ? { parentSession: SessionId(meta.parentSessionId) }
            : {}),
          ...(meta.createdAt === undefined
            ? {}
            : {
                createdAt:
                  typeof meta.createdAt === "number"
                    ? meta.createdAt
                    : Date.parse(meta.createdAt),
              }),
        },
      });
      this.#write(path, `${JSON.stringify(session.header)}\n`, "wx");
    }
    // Cordis's public subject filter is captured by DSH's scopeTarget at enter.
    // Exclude only the isolated stock backend; all ordinary session observers
    // still see this exact Session and its canonical accepted events.
    if (this.excludedPersistenceScope)
      Object.defineProperty(session, Context.filter, {
        value: (listener: Context) =>
          listener[Context.isolate].sessionPersistence !==
          this.excludedPersistenceScope,
      });
    const entry: Entry = {
      session,
      written,
      detach: this.ctx.sessions.enter(session),
    };
    this.#entries.set(meta.id, entry);
    try {
      this.#persist(entry); // includes Session's unpublished end-seed marker
      this.ctx.sessions.announce(session);
      if (
        !session.events.some(
          (event) => event.type === "workagent/native/imported",
        )
      ) {
        for (const message of legacyMessages) {
          if (message.sessionId !== meta.id)
            throw new Error("native_message_session_mismatch");
          this.appendMessage(message);
        }
        session.append("workagent/native/imported", { version: 1 });
      }
      this.#ensureUserMessages(session);
      if (meta.engine === "codex" && meta.nativeId && process.env.CODEX_HOME) {
        const unclassified = this.messages(meta.id).filter(
          (message) => message.role === "assistant" && !message.kind,
        );
        if (unclassified.length) {
          const kinds = readCodexMessageKinds(
            process.env.CODEX_HOME,
            meta.nativeId,
          );
          for (const message of unclassified) {
            const kind = kinds.get(message.id);
            if (kind)
              session.append("workagent/native/message-kind", {
                id: message.id,
                kind,
              });
          }
        }
      }
      const boundary = session.events.findLast(
        (event) => event.type === "turn/start" || event.type === "turn/end",
      );
      if (boundary?.type === "turn/start")
        session.append("turn/end", {
          turn: boundary.data.turn,
          reason: { kind: "interrupted" },
        });
      this.#persist(entry);
      return session;
    } catch (error) {
      entry.detach();
      this.#entries.delete(meta.id);
      throw error;
    }
  }

  appendMessage(message: StoredMessage): void {
    const entry = this.#require(message.sessionId);
    if (
      this.messages(message.sessionId).some((item) => item.id === message.id)
    ) {
      this.#ensureUserMessages(entry.session);
      this.#persist(entry);
      return;
    }
    entry.session.append("workagent/native/message", message);
    this.#ensureUserMessages(entry.session);
    this.#persist(entry);
  }

  appendEvent(sessionId: string, event: NativeSessionEvent): void {
    const entry = this.#require(sessionId);
    if (event.type === "turn/start") {
      if (!Number.isSafeInteger(event.turn) || Number(event.turn) < 0)
        throw new Error("invalid_native_turn");
      entry.session.append("turn/start", { turn: event.turn as number });
    } else if (event.type === "turn/end") {
      if (!Number.isSafeInteger(event.turn) || Number(event.turn) < 0)
        throw new Error("invalid_native_turn");
      entry.session.append("turn/end", {
        turn: event.turn as number,
        reason: event.reason as TurnEndReason,
      });
    } else {
      const previous = entry.session.events;
      entry.session.append("workagent/native/event", event);
      const boundary = previous.findLast(
        (item) => item.type === "turn/start" || item.type === "turn/end",
      );
      if (event.type === "turn.started") {
        const duplicate =
          typeof event.turnId === "string" &&
          previous.some(
            (item) =>
              item.type === "workagent/native/event" &&
              item.data.type === "turn.started" &&
              item.data.turnId === event.turnId,
          );
        if (!duplicate && boundary?.type !== "turn/start") {
          entry.session.append("turn/start", {
            turn: boundary ? boundary.data.turn + 1 : 0,
          });
        }
      } else if (
        ["turn.completed", "turn.cancelled", "turn.failed"].includes(
          event.type,
        ) &&
        boundary?.type === "turn/start"
      ) {
        const started = previous.findLast(
          (item) =>
            item.type === "workagent/native/event" &&
            item.data.type === "turn.started",
        );
        if (
          started?.type === "workagent/native/event" &&
          (event.turnId === undefined || started.data.turnId === event.turnId)
        ) {
          const reason: TurnEndReason =
            event.type === "turn.completed"
              ? { kind: "completed" }
              : event.type === "turn.cancelled"
                ? { kind: "native-cancelled" }
                : {
                    kind: "error",
                    error: {
                      message:
                        typeof event.message === "string"
                          ? event.message
                          : "native_turn_failed",
                      code:
                        typeof event.code === "string" ? event.code : "UNKNOWN",
                    },
                  };
          entry.session.append("turn/end", {
            turn: boundary.data.turn,
            reason,
          });
        }
      }
    }
    this.#persist(entry);
  }

  messages(sessionId: string): StoredMessage[] {
    checkedId(sessionId);
    const events = this.#entries.get(sessionId)?.session.events ?? [];
    const kinds = new Map(
      events.flatMap((event) =>
        event.type === "workagent/native/message-kind"
          ? [[event.data.id, event.data.kind] as const]
          : [],
      ),
    );
    return events.flatMap((event) =>
      event.type === "workagent/native/message"
        ? [
            {
              ...event.data,
              ...(kinds.has(event.data.id)
                ? { kind: kinds.get(event.data.id)! }
                : {}),
            },
          ]
        : [],
    );
  }

  get(sessionId: string): Session | undefined {
    return this.#entries.get(sessionId)?.session;
  }

  owns(sessionId: string): boolean {
    if (!/^session-[a-zA-Z0-9_-]+$/.test(sessionId)) return false;
    return (
      existsSync(this.#path(sessionId)) ||
      existsSync(this.#tombstone(sessionId))
    );
  }

  location(sessionId: string): string {
    return this.#path(sessionId);
  }

  raw(
    sessionId: string,
  ): { meta: SessionHeader; filename: string; content: string } | undefined {
    if (
      existsSync(this.#tombstone(sessionId)) ||
      !existsSync(this.#path(sessionId))
    )
      return;
    const content = readFileSync(this.#path(sessionId), "utf8");
    const meta = JSON.parse(
      content.slice(0, content.indexOf("\n")),
    ) as SessionHeader;
    return { meta, filename: `${sessionId}.jsonl`, content };
  }

  list(): SessionHeader[] {
    return readdirSync(this.#root)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) => {
        const raw = this.raw(name.slice(0, -6));
        return raw ? [raw.meta] : [];
      });
  }

  inspect(sessionId: string): Session {
    this.#assertAvailable(sessionId);
    const live = this.get(sessionId);
    if (live) return live;
    const raw = this.raw(sessionId);
    if (!raw) throw new Error("native_session_not_found");
    const lines = raw.content.split("\n");
    lines.shift();
    const last = lines.pop()!;
    if (last) {
      try {
        JSON.parse(last);
        lines.push(last);
      } catch {
        /* torn physical tail */
      }
    }
    const session = Session.fromRestore(
      SessionId(sessionId),
      lines.filter(Boolean).map((line) => JSON.parse(line) as SessionEvent),
      raw.meta,
    );
    const boundary = session.events.findLast(
      (event) => event.type === "turn/start" || event.type === "turn/end",
    );
    if (boundary?.type === "turn/start")
      session.append("turn/end", {
        turn: boundary.data.turn,
        reason: { kind: "interrupted" },
      });
    return session;
  }

  /** Commit crash recovery through a detached real Session, without publishing
   * it or starting an engine. Native execution publication stays with open(). */
  load(sessionId: string): Session {
    const session = this.inspect(sessionId);
    if (this.get(sessionId)) return session;
    const raw = this.raw(sessionId)!;
    const lines = raw.content.split("\n");
    lines.shift();
    const tail = lines.pop()!;
    if (tail) {
      let complete = false;
      try {
        JSON.parse(tail);
        lines.push(tail);
        complete = true;
      } catch {
        truncateSync(
          this.#path(sessionId),
          Buffer.byteLength(raw.content) - Buffer.byteLength(tail),
        );
      }
      if (complete) this.#write(this.#path(sessionId), "\n", "a");
    }
    const written = lines.filter(Boolean).length;
    const suffix = session.events.slice(written);
    if (suffix.length)
      this.#write(
        this.#path(sessionId),
        suffix.map((event) => `${JSON.stringify(event)}\n`).join(""),
        "a",
      );
    return session;
  }

  delete(sessionId: string): void {
    checkedId(sessionId);
    const marker = this.#tombstone(sessionId);
    if (!existsSync(marker))
      this.#write(
        marker,
        JSON.stringify({ version: 1, deletedAt: Date.now() }),
        "wx",
      );
    const entry = this.#entries.get(sessionId);
    entry?.detach();
    this.#entries.delete(sessionId);
    const path = this.#path(sessionId);
    if (existsSync(path)) renameSync(path, `${path}.deleted`);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    for (const entry of this.#entries.values()) this.#persist(entry);
    for (const entry of this.#entries.values()) entry.detach();
    this.#entries.clear();
    for (const stop of this.#listeners) stop();
    this.#disposed = true;
  }

  #ensureUserMessages(session: Session): void {
    const existing = new Set(
      session.events.flatMap((event) =>
        event.type === "user/message" ? [String(event.data.id)] : [],
      ),
    );
    for (const event of session.events) {
      if (
        event.type !== "workagent/native/message" ||
        event.data.role !== "user" ||
        existing.has(event.data.id)
      )
        continue;
      session.append(
        "user/message",
        freezeMessage({
          id: MessageId(event.data.id),
          role: "user",
          content: [{ type: "text", text: event.data.text }],
          source: { kind: "user" },
        }),
        { surfaceOp: "append", sourceEventSeqs: [event.seq] },
      );
      existing.add(event.data.id);
    }
  }

  #require(id: string): Entry {
    this.#assertAvailable(id);
    const entry = this.#entries.get(id);
    if (!entry) throw new Error("native_session_not_open");
    return entry;
  }
  #assertAvailable(id: string): void {
    checkedId(id);
    if (this.#disposed) throw new Error("native_session_log_disposed");
    if (existsSync(this.#tombstone(id)))
      throw new Error("native_session_deleted");
  }
  #path(id: string): string {
    return join(this.#root, `${checkedId(id)}.jsonl`);
  }
  #tombstone(id: string): string {
    return join(this.#root, `${checkedId(id)}.tombstone`);
  }
  #persist(entry: Entry): void {
    const events = entry.session.events.slice(entry.written);
    if (!events.length) return;
    this.#write(
      this.#path(entry.session.id),
      events.map((event) => `${JSON.stringify(event)}\n`).join(""),
      "a",
    );
    entry.written = entry.session.seq;
  }
  #write(path: string, content: string, flags: string): void {
    const fd = openSync(path, flags, 0o600);
    const size = fstatSync(fd).size;
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } catch (error) {
      ftruncateSync(fd, size);
      fsyncSync(fd);
      throw error;
    } finally {
      closeSync(fd);
    }
  }
}
