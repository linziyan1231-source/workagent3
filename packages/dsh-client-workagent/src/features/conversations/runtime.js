import { request } from "../../platform/api.js";
import { conversationCache, messageDelivery } from "./state.js";
import React from "react";

const RuntimeServices = React.createContext(null);

const standardSessionApi = (ctx) => ctx.connection?.api?.sessions;

const hasStandardSessions = (ctx) =>
  Boolean(ctx.sessions?.binding && standardSessionApi(ctx));

const rpcValue = (response) => {
  const result = response.result ?? response;
  if (!result.ok)
    throw new Error(
      result.error?.message || result.error?.code || "session_request_failed",
    );
  return result.value;
};

async function nativeSessionAction(ctx, sessionId, action, ...args) {
  // The stock helper mints an opaque RPC id. Supply our receipt id through
  // the same standard transport so the host can persist it and dedupe retries.
  if (action === "prompt" && args[2])
    return rpcValue(
      await request("/api/session.prompt", {
        method: "POST",
        body: JSON.stringify({
          type: "client-request",
          rpcId: args[2],
          method: "session.prompt",
          payload: {
            sessionId,
            content: args[0],
            mode: args[1],
            clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        }),
      }),
    );
  const session = ctx.sessions.binding(sessionId)?.session;
  if (typeof session?.[action] === "function")
    return rpcValue(await session[action](...args));
  const api = standardSessionApi(ctx);
  const payload =
    action === "prompt"
      ? { sessionId, content: args[0], mode: args[1] }
      : action === "updateQueue"
        ? { sessionId, itemId: args[0], action: args[1] }
        : action === "selectModel"
          ? { sessionId, ...args[0] }
          : { sessionId };
  return rpcValue(await api[action](payload));
}

function useNativeConversation(ctx, sessionId, enabled) {
  const [state, setState] = React.useState(() => ({
    value: conversationCache.get(sessionId, "native"),
    loading: !conversationCache.get(sessionId, "native"),
    error: "",
  }));
  const refresh = React.useRef(async () => {});
  const reload = React.useCallback(() => refresh.current(), []);
  React.useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let revision = 0;
    let generation = 0;
    let requestController;
    let loading = false;
    let binding;
    let current = conversationCache.get(sessionId, "native");
    let sequence = current?.sequence ?? -1;
    let lastPush = Date.now();
    let stopProjection = () => {};
    const accept = (value, nextSequence = value?.sequence) => {
      if (disposed || !value) return;
      if (nextSequence !== undefined && nextSequence < sequence) return;
      if (nextSequence !== undefined) sequence = nextSequence;
      current = value;
      revision += 1;
      conversationCache.set(sessionId, "native", value);
      setState({ value, loading: false, error: "" });
    };
    const bind = () => {
      const next = ctx.sessions.binding(sessionId);
      if (!next || next === binding) return;
      binding = next;
      stopProjection();
      const face = next.session.projections.faceOf("nativeSession");
      accept(face.getSnapshot());
      stopProjection = face.subscribe(() => {
        lastPush = Date.now();
        accept(face.getSnapshot());
      });
    };
    const load = async () => {
      loading = true;
      const currentGeneration = ++generation;
      const before = revision;
      requestController?.abort();
      const controller = new AbortController();
      requestController = controller;
      try {
        const block = rpcValue(
          await standardSessionApi(ctx).history(
            { sessionId },
            controller.signal,
          ),
        ).projections;
        const value = block?.values?.nativeSession;
        if (
          disposed ||
          controller.signal.aborted ||
          generation !== currentGeneration ||
          (value?.sequence === undefined && revision !== before)
        )
          return;
        if (!value) throw new Error("native_session_projection_unavailable");
        accept(value, block.asOfSeq);
      } catch (error) {
        if (
          !disposed &&
          !controller.signal.aborted &&
          generation === currentGeneration
        )
          setState((current) => ({
            ...current,
            loading: false,
            error: error.message,
          }));
      } finally {
        if (generation === currentGeneration) loading = false;
      }
    };
    refresh.current = load;
    bind();
    const stopList = ctx.sessions.list.subscribe(bind);
    const stopReset = ctx.on("connection/reset", () => {
      sequence = -1;
      bind();
      void load();
    });
    const onFocus = () => {
      if (!document.hidden) void load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    // A stalled downlink must not require a page refresh. Only recover
    // active/unsettled conversations, and avoid polling a healthy stream.
    const recovery = setInterval(() => {
      if (
        !document.hidden &&
        !loading &&
        Date.now() - lastPush >= 5000 &&
        (!current ||
          current.activity.state !== "idle" ||
          messageDelivery.get(sessionId).length)
      )
        void load();
    }, 5000);
    void load();
    return () => {
      disposed = true;
      requestController?.abort();
      stopProjection();
      stopList();
      stopReset();
      clearInterval(recovery);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      refresh.current = async () => {};
    };
  }, [sessionId, enabled]);
  return { ...state, reload };
}

export {
  RuntimeServices,
  hasStandardSessions,
  nativeSessionAction,
  useNativeConversation,
};
