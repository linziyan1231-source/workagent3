import {
  ApprovalRequestId,
  type ApprovalOutcome,
} from "@deepseek-ai/dsh-user-approval";
import type { PendingInteraction } from "./approval-bridge.js";
import type { Context } from "@deepseek-ai/cordis";
import {
  ApiProxyService,
  RpcId,
  type MuxFrame,
  type ApiProxy,
  type Config,
  type RpcError,
  type RpcRequest,
  type RpcResponse,
  type SessionSummary,
} from "@deepseek-ai/dsh-host-apiproxy";
import { SessionId } from "@deepseek-ai/dsh-session";
import { resolve } from "node:path";
import type { NativeSessionPort } from "./native-session-port.js";

class NativeRpcError extends Error {
  constructor(readonly error: RpcError) {
    super(error.message);
  }
}
async function respond<T>(
  request: RpcRequest<unknown>,
  run: () => T | Promise<T>,
): Promise<RpcResponse<T>> {
  try {
    return { rpcId: request.rpcId, result: { ok: true, value: await run() } };
  } catch (error) {
    return {
      rpcId: request.rpcId,
      result: {
        ok: false,
        error:
          error instanceof NativeRpcError
            ? error.error
            : {
                code: "internal",
                message: error instanceof Error ? error.message : String(error),
                details: {},
              },
      },
    };
  }
}
const fail = (error: RpcError): never => {
  throw new NativeRpcError(error);
};

/** Route native-owned identities before any stock operation can acquire an Agent. */
export function wrapNativeSessionApi(
  ctx: Context,
  base: ApiProxy,
  port: NativeSessionPort,
): ApiProxy {
  const stock = base.sessions;
  const stockEvents = base.events;
  const stockRespond = base.respond.bind(base);
  const requireSession = (id: SessionId) =>
    port.session(id) ??
    fail({
      code: "session-not-found",
      message: "Native session is unavailable",
      details: { sessionId: id },
    });
  const textOnly = (parts: readonly { type: string; text?: string }[]) => {
    if (parts.some((part) => part.type !== "text"))
      fail({
        code: "attachment-error",
        message: "Native sessions currently accept text only",
        details: { reason: "native-text-only" },
      });
    return parts.map((part) => part.text ?? "").join("");
  };
  const sessions: ApiProxy["sessions"] = {
    ...stock,
    async list(request) {
      const result = await stock.list(request);
      if (!result.result.ok) return result;
      const rows = new Map(
        result.result.value.items.map((row) => [row.sessionId, row]),
      );
      for (const item of port.list()) {
        const id = SessionId(item.id);
        const session = port.session(id);
        const previous = rows.get(id);
        const row: SessionSummary = {
          ...previous,
          sessionId: id,
          updatedAt: Date.parse(item.updatedAt),
          running:
            item.activity?.state === "running" ||
            item.activity?.state === "retrying",
          blank:
            port.messages(id).length === 0 &&
            !session?.events.some((event) => event.type === "turn/start"),
          cwd: item.workspacePath,
          agentPreset: `workagent-native:${item.engine}`,
          ...(item.parentSessionId
            ? { parentSessionId: SessionId(item.parentSessionId) }
            : {}),
        };
        rows.set(id, row);
      }
      return {
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            items: [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt),
          },
        },
      };
    },
    create(request) {
      const { sessionId, cwd, workspaceId, agentPreset } = request.payload;
      if (sessionId && port.owns(sessionId))
        return respond(request, () => {
          const session = requireSession(sessionId);
          if (workspaceId)
            fail({
              code: "workspace-attach-failed",
              message: "Adopt native sessions through their existing workspace",
              details: { sessionId, workspaceId },
            });
          if (
            cwd !== undefined &&
            resolve(cwd) !== resolve(session.header.cwd ?? "")
          )
            fail({
              code: "session-conflict",
              message: "Native session workspace differs",
              details: {
                sessionId,
                requestedCwd: cwd,
                ...(session.header.cwd === undefined
                  ? {}
                  : { existingCwd: session.header.cwd }),
              },
            });
          if (
            agentPreset !== undefined &&
            agentPreset !== session.header.agentPreset
          )
            fail({
              code: "agent-preset-conflict",
              message: "Native session engine differs",
              details: {
                sessionId,
                requestedPreset: agentPreset,
                ...(session.header.agentPreset === undefined
                  ? {}
                  : { existingPreset: session.header.agentPreset }),
              },
            });
          return {
            sessionId,
            ...(session.header.agentPreset === undefined
              ? {}
              : { agentPreset: session.header.agentPreset }),
          };
        });
      if (agentPreset?.startsWith("workagent-native:"))
        return respond(request, () =>
          fail({
            code: "agent-preset-invalid",
            message: "Create native sessions through WorkAgent",
            details: {
              agentPreset,
              reason: "native-session-create-unavailable",
            },
          }),
        );
      return stock.create(request);
    },
    history(request) {
      if (
        port.owns(request.payload.sessionId) &&
        !port.session(request.payload.sessionId)
      )
        return respond(request, () =>
          fail({
            code: "session-not-found",
            message: "Native session is unavailable",
            details: { sessionId: request.payload.sessionId },
          }),
        );
      return stock.history(request);
    },
    prompt(request) {
      const { sessionId, content, mode } = request.payload;
      if (!port.owns(sessionId)) return stock.prompt(request);
      return respond(request, async () => {
        requireSession(sessionId);
        await port.prompt(
          sessionId,
          textOnly(content),
          mode,
          String(request.rpcId),
        );
        return { accepted: true as const };
      });
    },
    cancel(request) {
      const { sessionId } = request.payload;
      if (!port.owns(sessionId)) return stock.cancel(request);
      return respond(request, async () => {
        requireSession(sessionId);
        await port.cancel(sessionId);
        return { accepted: true as const };
      });
    },
    updateQueue(request) {
      const { sessionId, itemId, action } = request.payload;
      if (!port.owns(sessionId)) return stock.updateQueue(request);
      return respond(request, async () => {
        requireSession(sessionId);
        if (action.kind === "edit") textOnly(action.content);
        await port.updateQueue(sessionId, itemId, action);
        return { accepted: true as const };
      });
    },
    models(request) {
      const { sessionId } = request.payload;
      if (!port.owns(sessionId)) return stock.models(request);
      return respond(request, () => {
        requireSession(sessionId);
        return port.models(sessionId);
      });
    },
    selectModel(request) {
      const { sessionId, ...selection } = request.payload;
      if (!port.owns(sessionId)) return stock.selectModel(request);
      return respond(request, async () => {
        requireSession(sessionId);
        return { selected: await port.selectModel(sessionId, selection) };
      });
    },
    rename(request) {
      const { sessionId, title } = request.payload;
      if (!port.owns(sessionId)) return stock.rename(request);
      return respond(request, () => {
        const session = requireSession(sessionId);
        if (!title.trim())
          fail({
            code: "title-invalid",
            message: "Title must not be empty",
            details: { sessionId },
          });
        const accepted = port.rename(sessionId, title);
        return { title: accepted, seq: session.events.at(-1)?.seq ?? -1 };
      });
    },
    fork(request) {
      const { sessionId, atSeq } = request.payload;
      if (!port.owns(sessionId)) return stock.fork(request);
      return respond(request, async () => {
        const session = requireSession(sessionId);
        const events = session.events;
        const ends = events.filter((event) => event.type === "turn/end");
        const boundary =
          atSeq === undefined || atSeq > (events.at(-1)?.seq ?? -1)
            ? ends.at(-1)
            : ends.find((event) => event.seq >= atSeq);
        if (!boundary)
          fail({
            code: "fork-unavailable",
            message: "Native fork requires a completed turn boundary",
            details: { sessionId },
          });
        const start = events.findLast(
          (event) =>
            event.type === "turn/start" &&
            event.data.turn === boundary!.data.turn &&
            event.seq < boundary!.seq,
        );
        const message = events.findLast(
          (event) =>
            start !== undefined &&
            event.seq > start.seq &&
            event.seq <= boundary!.seq &&
            event.type === "workagent/native/message",
        );
        const messageId =
          message?.type === "workagent/native/message"
            ? message.data.id
            : undefined;
        if (
          !messageId ||
          !port.messages(sessionId).some((message) => message.id === messageId)
        )
          fail({
            code: "fork-unavailable",
            message: "Completed native turn has no visible anchor",
            details: { sessionId },
          });
        const child = await port.fork(sessionId, messageId);
        return { sessionId: SessionId(child.id) };
      });
    },
  };
  const approvalPrefix = "workagent-native-approval:";
  const requested = (item: PendingInteraction): RpcRequest<MuxFrame> => ({
    rpcId: RpcId(`${approvalPrefix}${item.id}`),
    payload: {
      type: "approval/requested",
      sessionId: SessionId(item.sessionId),
      approvalId: ApprovalRequestId(item.id),
      toolName: item.tool,
      reason: item.summary,
    },
  });
  const events: ApiProxy["events"] = {
    ...stockEvents,
    async *mux(request, signal) {
      const lifetime = new AbortController();
      const iterator = stockEvents
        .mux(request, AbortSignal.any([signal, lifetime.signal]))
        [Symbol.asyncIterator]();
      // Open the underlying subscription before reading the reconnect baseline.
      let next = iterator.next();
      const sent = new Set<string>();
      try {
        for (const item of port.approvals()) {
          if (!port.owns(item.sessionId) || !port.session(item.sessionId))
            continue;
          sent.add(item.id);
          yield requested(item);
        }
        while (!signal.aborted) {
          const current = await next;
          if (current.done) return;
          next = iterator.next();
          yield current.value;
          const frame = current.value.payload;
          if (
            frame.type !== "session/event" ||
            !port.owns(frame.sessionId) ||
            frame.event.type !== "workagent/native/event"
          )
            continue;
          const event = frame.event.data;
          if (typeof event.approvalId !== "string") continue;
          if (
            event.type === "approval.requested" &&
            !sent.has(event.approvalId)
          ) {
            const pending = port
              .approvals()
              .find(
                (item) =>
                  item.id === event.approvalId &&
                  item.sessionId === frame.sessionId,
              );
            if (pending) {
              sent.add(pending.id);
              yield requested(pending);
            }
          } else if (event.type === "approval.resolved") {
            const outcomes: Record<string, ApprovalOutcome> = {
              allowed: "allowed-once",
              rejected: "rejected",
              cancelled: "cancelled",
              unavailable: "unavailable",
            };
            const outcome =
              typeof event.outcome === "string"
                ? outcomes[event.outcome]
                : undefined;
            if (outcome)
              yield {
                rpcId: RpcId(
                  `workagent-native-resolution:${event.approvalId}:${frame.event.seq}`,
                ),
                payload: {
                  type: "approval/resolved",
                  sessionId: frame.sessionId,
                  approvalId: ApprovalRequestId(event.approvalId),
                  outcome,
                },
              };
          }
        }
      } finally {
        lifetime.abort();
        await next.catch(() => undefined);
        await iterator.return?.();
      }
    },
  };
  return {
    ...base,
    sessions,
    events,
    async respond(message) {
      if (!message.rpcId.startsWith(approvalPrefix))
        return stockRespond(message);
      const id = message.rpcId.slice(approvalPrefix.length);
      const pending = port
        .approvals()
        .find(
          (item) =>
            item.id === id &&
            port.owns(item.sessionId) &&
            port.session(item.sessionId),
        );
      if (!pending) return { accepted: false, reason: "not-pending" };
      if (!message.result.ok)
        return { accepted: false, reason: "bad-response" };
      const payload = message.result.value as {
        sessionId?: unknown;
        approvalId?: unknown;
        outcome?: unknown;
      } | null;
      if (
        !payload ||
        payload.sessionId !== pending.sessionId ||
        payload.approvalId !== id ||
        (payload.outcome !== "allowed-once" && payload.outcome !== "rejected")
      )
        return { accepted: false, reason: "bad-response" };
      return port.respondApproval(
        pending.sessionId,
        id,
        payload.outcome === "allowed-once" ? "allow" : "reject",
      )
        ? { accepted: true }
        : { accepted: false, reason: "not-pending" };
    },
  };
}

export default class NativeSessionApiService extends ApiProxyService {
  static override inject = [...ApiProxyService.inject, "workagentSessions"];
  declare readonly sessions: ApiProxy["sessions"];
  declare readonly events: ApiProxy["events"];
  declare readonly respond: ApiProxy["respond"];
  constructor(ctx: Context, config: Config) {
    super(ctx, config);
    const wrapped = wrapNativeSessionApi(ctx, this, ctx.workagentSessions);
    this.sessions = wrapped.sessions;
    this.events = wrapped.events;
    this.respond = wrapped.respond;
  }
}
