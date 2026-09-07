import { Context } from "@deepseek-ai/cordis";
import {
  SessionPersistence,
  SessionPersistenceRevision,
  type SessionInspection,
} from "@deepseek-ai/dsh-session-persistence";
import {
  JsonlSessionPersistence,
  type Config as JsonlConfig,
} from "@deepseek-ai/dsh-session-persistence-jsonl";
import {
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from "@deepseek-ai/dsh-session";
import { dirname } from "node:path";
import { statSync } from "node:fs";
import { isNativeSession, NativeSessionLog } from "./native-session-log.js";
import { registerNativeSessionProjection } from "./native-session-projection.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    workagentNativeLog: NativeSessionLog;
  }
}

export type Config = JsonlConfig & { dshHome?: string };

/** Public persistence provider: native required extensions and stock Harness
 * events share the API, while each identity has exactly one durable writer.
 */
export class WorkAgentSessionPersistence extends SessionPersistence {
  static inject = ["sessions"];
  static Config: typeof JsonlSessionPersistence.Config =
    JsonlSessionPersistence.Config;
  readonly supportsRawArtifacts = true;
  readonly standard: JsonlSessionPersistence;
  readonly nativeLog: NativeSessionLog;

  constructor(ctx: Context, config: Config) {
    super(ctx);
    const scope = Symbol("workagent-standard-persistence");
    // The public service isolation map identifies stock persistence listeners.
    // Native Session subject filters exclude only this exact child scope.
    this.standard = new JsonlSessionPersistence(
      ctx.isolate("sessionPersistence", scope),
      config,
    );
    this.nativeLog = new NativeSessionLog(
      ctx,
      config.dshHome ?? process.env.DSH_HOME ?? dirname(config.root),
      scope,
    );
    ctx.provide("workagentNativeLog", this.nativeLog);
    ctx.inject(["sessionProjections"], registerNativeSessionProjection);
    ctx.effect(() => () => this.nativeLog.dispose());
  }

  locate(meta: SessionHeader) {
    return isNativeSession({ header: meta })
      ? { kind: "jsonl", path: this.nativeLog.location(meta.id) }
      : this.standard.locate(meta);
  }
  async readRaw(id: SessionId, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return this.nativeLog.owns(id)
      ? this.nativeLog.raw(id)
      : this.standard.readRaw(id, signal);
  }
  async create(meta: SessionHeader): Promise<void> {
    if (!isNativeSession({ header: meta })) return this.standard.create(meta);
    // Native creation belongs to SessionIndex + NativeSessionLog.open, which
    // retain workspace and engine authorization; generic persistence cannot
    // mint an executable native identity.
    if (!this.nativeLog.get(meta.id))
      throw new Error("native_session_owner_required");
  }
  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    if (!this.nativeLog.owns(id)) return this.standard.append(id, events);
    const session = this.nativeLog.get(id);
    if (!session) throw new Error("native_session_owner_required");
    for (const event of events) {
      if (JSON.stringify(session.events[event.seq]) !== JSON.stringify(event))
        throw new Error("native_session_append_requires_accepted_event");
    }
    await this.ctx.sessions.flush(session);
  }
  async prepare(id: SessionId, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.nativeLog.owns(id))
      throw new Error("native_session_owner_required");
    return this.standard.prepare(id, signal);
  }
  async load(id: SessionId): Promise<SessionInspection> {
    if (!this.nativeLog.owns(id)) return this.standard.load(id);
    const current = this.nativeLog.get(id);
    if (current) {
      const boundary = current.events.findLast(
        (event) => event.type === "turn/start" || event.type === "turn/end",
      );
      if (boundary?.type === "turn/start")
        throw new Error("native_session_live_turn_open");
      await this.ctx.sessions.flush(current);
      return { meta: current.header, events: current.events };
    }
    const restored = this.nativeLog.load(id);
    return { meta: restored.header, events: restored.events };
  }
  async inspect(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionInspection> {
    signal?.throwIfAborted();
    if (!this.nativeLog.owns(id)) return this.standard.inspect(id, signal);
    const session = this.nativeLog.inspect(id);
    return { meta: session.header, events: session.events };
  }
  async readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0)
      throw new Error("invalid_from_seq");
    if (!this.nativeLog.owns(id))
      return this.standard.readFrom(id, fromSeq, signal);
    const raw = this.nativeLog.raw(id);
    if (!raw) throw new Error("native_session_deleted");
    const lines = raw.content.split("\n");
    lines.shift();
    const tail = lines.pop()!;
    if (tail) {
      try {
        JSON.parse(tail);
        lines.push(tail);
      } catch {
        /* incomplete physical record */
      }
    }
    const events = lines
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionEvent);
    // Public Session restoration validates every envelope and contiguous seq;
    // readFrom returns only physical events, never its end-seed marker.
    this.nativeLog.inspect(id);
    return {
      meta: raw.meta,
      events: events.filter((event) => event.seq >= fromSeq),
    };
  }
  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted();
    return [...(await this.standard.list(signal)), ...this.nativeLog.list()];
  }
  async listSnapshots(signal?: AbortSignal) {
    signal?.throwIfAborted();
    return [
      ...(await this.standard.listSnapshots(signal)),
      ...this.nativeLog.list().map((header) => {
        const path = this.nativeLog.location(header.id);
        const stat = statSync(path, { bigint: true });
        return {
          header,
          revision: SessionPersistenceRevision(
            `workagent-native:${path}:${stat.size}:${stat.mtimeNs}`,
          ),
        };
      }),
    ];
  }
}

export default WorkAgentSessionPersistence;
