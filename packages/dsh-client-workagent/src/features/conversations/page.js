import { Markdown, workbench } from "../content/index.js";
import { navigation } from "../../host/navigation.js";
import { trackConversationScroll } from "./scroll.js";
import { sidebarState } from "../../host/compatibility.js";
import { apiRoot, request } from "../../platform/api.js";
import { useSessionResource as useResource } from "./resources.js";
import { SessionAvatar } from "../agents/avatar-components.js";
import { Button } from "../../ui/elements.js";
import { Dialog } from "../../ui/dialog.js";
import { Icon } from "../../ui/icons.js";
import {
  displayPresetName,
  displaySessionTitle,
  friendlyError,
} from "../../ui/labels.js";
import { MessageActions } from "../../ui/message-actions.js";
import { SharedPage } from "../collaboration/page.js";
import {
  ComposerForm,
  ComposerInput,
  submitComposerOnEnter,
} from "./composer.js";
import { useBusyEnter } from "./preferences.js";
import {
  RuntimeServices,
  hasStandardSessions,
  nativeSessionAction,
  useNativeConversation,
} from "./runtime.js";
import {
  SESSIONS_CHANGED_EVENT,
  conversationCache,
  messageDelivery,
} from "./state.js";
import React from "react";
import { createElement as h } from "react";

function ConversationMessageTarget({ sessionId }) {
  const routeSearch = navigation.useSearch();
  const locateMessage = React.useCallback((messageId) => {
    const escaped = globalThis.CSS?.escape
      ? globalThis.CSS.escape(messageId)
      : messageId.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    let target = document.querySelector(
      `[data-message-id="${escaped}"], #message-${escaped}`,
    );
    if (!target) return false;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("workagent-message-highlight");
    globalThis.setTimeout(
      () => target.classList.remove("workagent-message-highlight"),
      3000,
    );
    return true;
  }, []);
  React.useEffect(() => {
    const messageId = new URLSearchParams(routeSearch).get("message");
    if (!messageId) return;
    let attempts = 0;
    const timer = globalThis.setInterval(() => {
      attempts += 1;
      if (locateMessage(messageId) || attempts >= 40)
        globalThis.clearInterval(timer);
    }, 100);
    return () => globalThis.clearInterval(timer);
  }, [sessionId, routeSearch, locateMessage]);
  return null;
}

function RuntimeConversation({
  sessionId,
  side = false,
  onSideChat,
  sideHeader,
}) {
  const busyEnter = useBusyEnter();
  const submitGesture = React.useRef(false);
  const routeParams = new URLSearchParams(navigation.useSearch());
  const id = encodeURIComponent(sessionId);
  const [sessionState] = useResource(`${apiRoot}/sessions/${id}`);
  const ctx = React.useContext(RuntimeServices);
  const standard = hasStandardSessions(ctx);
  const native =
    standard && ["codex", "kimi", "acp"].includes(sessionState.rows[0]?.engine);
  const legacy = !standard || sessionState.rows[0]?.engine === "harness";
  const nativeState = useNativeConversation(ctx, sessionId, native);
  const [legacyQueueState, reloadQueue] = useResource(
    legacy ? `${apiRoot}/sessions/${id}/queue` : null,
  );
  const [legacyMessageState, reloadMessages] = useResource(
    legacy ? `${apiRoot}/sessions/${id}/messages` : null,
  );
  const messageState = native
    ? {
        loading: nativeState.loading,
        rows: nativeState.value?.messages ?? [],
      }
    : legacyMessageState;
  const messageList = React.useRef(null);
  React.useLayoutEffect(() => {
    if (messageState.loading) return;
    const list = messageList.current;
    if (!list) return;
    return trackConversationScroll(
      list,
      sidebarState(),
      conversationCache,
      sessionId,
      side,
    );
  }, [sessionId, messageState.loading, side]);
  const queueState = native
    ? { rows: nativeState.value?.metadata?.queue ?? [] }
    : legacyQueueState;
  const receipts = messageDelivery.useRows(sessionId);
  const scrollReceipt = React.useRef(null);
  const knownIds = new Set([
    ...messageState.rows.map((row) => row.id),
    ...queueState.rows.map((row) => row.messageId),
  ]);
  const pending = receipts.filter((row) => !knownIds.has(row.id));
  const visibleMessages = [
    ...messageState.rows,
    ...pending.filter((row) => !row.queued),
  ];
  const visibleQueue = [
    ...queueState.rows,
    ...pending
      .filter((row) => row.queued)
      .map((row) => ({ ...row, messageId: row.id, content: row.text })),
  ];
  React.useEffect(() => {
    messageDelivery.reconcile(sessionId, messageState.rows, queueState.rows);
  }, [sessionId, messageState.rows, queueState.rows, receipts]);
  React.useLayoutEffect(() => {
    if (!scrollReceipt.current) return;
    const target = messageList.current?.querySelector(
      `[data-message-id="${scrollReceipt.current}"]`,
    );
    if (target) {
      target.scrollIntoView({ block: "nearest" });
      scrollReceipt.current = null;
    }
  }, [receipts]);
  const [input, setInput] = workbench.useDraft(
    sessionId,
    sessionState.rows[0]?.id === sessionId,
  );
  const historyCursor = React.useRef({ index: -1, saved: "" });
  const retryDraft = React.useRef(null);
  const currentInput = React.useRef(input);
  currentInput.current = input;
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState("");
  const [error, setError] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [forkTarget, setForkTarget] = React.useState(null);
  const [attachmentsBusy, setAttachmentsBusy] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const [editContent, setEditContent] = React.useState("");
  const session = native
    ? { ...sessionState.rows[0], ...nativeState.value?.metadata }
    : sessionState.rows[0];
  const activityRevision = React.useRef(0);
  React.useEffect(() => {
    if (!native) return;
    const value = nativeState.value;
    if (value) {
      setBusy(value.activity.state !== "idle");
      setDraft(value.draft || "");
      setProgress(
        value.activity.state === "retrying"
          ? "模型服务暂不可用，正在自动重试…"
          : value.activeTool
            ? "正在执行工具…"
            : value.progress || "",
      );
      if (value.activity.message)
        setError(friendlyError(value.activity.message));
      else if (value.lastEvent?.type === "turn.started") setError("");
      if (
        [
          "turn.started",
          "turn.retrying",
          "turn.completed",
          "turn.failed",
          "turn.cancelled",
          "session.metadata",
        ].includes(value.lastEvent?.type)
      )
        window.dispatchEvent(new window.Event(SESSIONS_CHANGED_EVENT));
    }
    if (nativeState.error) setError(friendlyError(nativeState.error));
  }, [native, nativeState.value, nativeState.error]);
  const syncActivity = React.useCallback(async () => {
    if (native) return nativeState.reload();
    if (!legacy) return;
    const revision = activityRevision.current;
    try {
      const current = await request(`${apiRoot}/sessions/${id}`);
      if (revision !== activityRevision.current || !current.activity) return;
      void reloadQueue();
      const active = current.activity.state !== "idle";
      setBusy(active);
      setProgress(
        current.activity.state === "retrying"
          ? "模型服务暂不可用，正在自动重试…"
          : "",
      );
      if (!active) {
        setDraft("");
        if (current.activity.message)
          setError(friendlyError(current.activity.message));
        void reloadMessages();
      }
    } catch {
      setProgress("连接中断，正在重新连接…");
    }
  }, [id, reloadMessages, native, legacy, nativeState.reload]);

  React.useEffect(() => {
    if (!busy || !legacy) return;
    const timer = setInterval(() => void syncActivity(), 5000);
    return () => clearInterval(timer);
  }, [busy, syncActivity, legacy]);

  React.useEffect(() => {
    if (!legacy || typeof EventSource === "undefined") return undefined;
    const stream = new EventSource(`${apiRoot}/sessions/${id}/events`);
    stream.onopen = () => void syncActivity();
    stream.onmessage = (event) => {
      let value;
      try {
        value = JSON.parse(event.data);
      } catch {
        return;
      }
      activityRevision.current += 1;
      if (
        [
          "turn.started",
          "turn.retrying",
          "turn.completed",
          "turn.failed",
          "turn.cancelled",
        ].includes(value.type)
      )
        window.dispatchEvent(new window.Event(SESSIONS_CHANGED_EVENT));
      if (value.type === "turn.started") {
        setBusy(true);
        setProgress("");
        setError("");
      }
      if (value.type === "turn.retrying") {
        setBusy(true);
        setProgress(
          /high demand|overloaded/i.test(value.message || "")
            ? "模型服务繁忙，正在自动重试…"
            : "模型连接暂时中断，正在自动重试…",
        );
      }
      if (value.type === "assistant.delta") {
        setProgress("");
        setDraft((current) => current + (value.delta || ""));
      }
      if (value.type === "tool.started") setProgress("正在执行工具…");
      if (value.type === "tool.completed") setProgress("");
      if (value.type === "assistant.completed") {
        setDraft("");
        void reloadMessages();
      }
      if (value.type === "queue.changed") void reloadQueue();
      if (value.type === "message.created") void reloadMessages();
      if (value.type === "turn.completed") {
        setBusy(false);
        setDraft("");
        setProgress("");
        void reloadMessages();
      }
      if (value.type === "turn.failed") {
        setBusy(false);
        setDraft("");
        setError(friendlyError(value.message));
        void reloadMessages();
      }
      if (value.type === "turn.cancelled") {
        setBusy(false);
        setDraft("");
      }
    };
    stream.onerror = () => {
      setProgress("连接中断，正在重新连接…");
      void syncActivity();
    };
    return () => stream.close();
  }, [id, legacy]);

  const [questionReplies, setQuestionReplies] = React.useState({
    sessionId,
    rows: [],
  });
  const questionMessages = [
    ...visibleMessages,
    ...(questionReplies.sessionId === sessionId
      ? questionReplies.rows
      : []
    ).filter(
      (row) => !visibleMessages.some((message) => message.id === row.id),
    ),
  ];
  const answerQuestion = async (question, content) => {
    setSubmitting(true);
    try {
      const { message } = await request(
        `${apiRoot}/sessions/${id}/question-reply`,
        {
          method: "POST",
          body: JSON.stringify({ questionId: question.id, content }),
        },
      );
      setQuestionReplies((current) => ({
        sessionId,
        rows: [
          ...(current.sessionId === sessionId ? current.rows : []).filter(
            (row) => row.id !== message.id,
          ),
          message,
        ],
      }));
      // Acceptance is durable. A history refresh failure must not turn an
      // accepted reply into a failed submission or erase ongoing progress.
      if (native) void nativeState.reload().catch(() => {});
      else void reloadMessages();
    } finally {
      setSubmitting(false);
    }
  };
  const send = async (event, questionReply, retry) => {
    event.preventDefault();
    const accelerated = submitGesture.current;
    submitGesture.current = false;
    const content = retry?.text ?? questionReply ?? input.trim();
    if (!content || submitting || attachmentsBusy) return;
    if (!questionReply && !side && /^\/?btw(?:\s|$)/i.test(content)) {
      setSubmitting(true);
      try {
        await onSideChat(content.replace(/^\/?btw\s*/i, ""));
        setInput("");
      } catch (cause) {
        setError(friendlyError(cause.message));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    const behavior = accelerated
      ? busyEnter === "queue"
        ? "steer"
        : "queue"
      : busyEnter;
    const queued = busy && !questionReply && behavior === "queue";
    const steering = busy && !queued;
    const receipt =
      retry ??
      (retryDraft.current?.text === content ? retryDraft.current : null);
    const messageId = receipt?.id ?? `message-ui-${crypto.randomUUID()}`;
    const row = {
      id: messageId,
      sessionId,
      role: "user",
      text: content,
      createdAt: receipt?.createdAt ?? new Date().toISOString(),
      queued,
      status: "sending",
      error: "",
    };
    scrollReceipt.current = messageId;
    messageDelivery.update(sessionId, row);
    retryDraft.current = null;
    setSubmitting(true);
    activityRevision.current += 1;
    setBusy(true);
    setProgress("");
    if (!busy) setDraft("");
    setError("");
    if (!questionReply && (!retry || currentInput.current === content))
      setInput("");
    try {
      if (native)
        await nativeSessionAction(
          ctx,
          sessionId,
          "prompt",
          [{ type: "text", text: content }],
          steering ? "steer" : "queue",
          messageId,
        );
      else
        await request(
          `${apiRoot}/sessions/${id}/${queued ? "queue" : steering ? "steer" : "turns"}`,
          {
            method: "POST",
            body: JSON.stringify({
              content,
              messageId,
            }),
          },
        );
      messageDelivery.update(sessionId, {
        ...row,
        status: queued ? "queued" : "sent",
      });
      if (native) await nativeState.reload();
      else await Promise.all([reloadMessages(), reloadQueue()]);
    } catch (cause) {
      messageDelivery.update(sessionId, {
        ...row,
        status: "failed",
        error: friendlyError(cause.message),
      });
      if (!questionReply && !currentInput.current) {
        retryDraft.current = row;
        setInput(content);
      }
      if (!busy) setBusy(false);
      setError(""); // The failed receipt keeps the error beside its original text.
      void syncActivity();
      if (questionReply) throw cause;
    } finally {
      setSubmitting(false);
    }
  };
  const updateQueue = async (messageId, action) => {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      if (native && action !== "send")
        await nativeSessionAction(ctx, sessionId, "updateQueue", messageId, {
          kind: action,
        });
      else
        await request(`${apiRoot}/sessions/${id}/queue`, {
          method: "POST",
          body: JSON.stringify({ messageId, action }),
        });
      if (native) await nativeState.reload();
      else {
        void reloadMessages();
        void syncActivity();
      }
    } catch (cause) {
      setError(friendlyError(cause.message));
    } finally {
      void reloadQueue();
      setSubmitting(false);
    }
  };
  const fork = async (messageId, replacementContent, confirmed = false) => {
    if (!confirmed && window.matchMedia("(max-width: 760px)").matches) {
      setForkTarget({ messageId, replacementContent });
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const branch = await request(`${apiRoot}/sessions/${id}/fork`, {
        method: "POST",
        body: JSON.stringify({ messageId, replacementContent }),
      });
      navigation.navigate(
        `/?frontend=dsh&session=${encodeURIComponent(branch.id)}`,
      );
    } catch (cause) {
      setError(friendlyError(cause.message));
    } finally {
      setSubmitting(false);
    }
  };
  const cancel = async () => {
    try {
      if (native) await nativeSessionAction(ctx, sessionId, "cancel");
      else
        await request(`${apiRoot}/sessions/${id}/cancel`, {
          method: "POST",
        });
      activityRevision.current += 1;
      setProgress("正在停止…");
      void syncActivity();
    } catch (cause) {
      setError(friendlyError(cause.message));
    }
  };

  const staleSharedTask =
    !side &&
    routeParams.get("workagent") === "shared" &&
    routeParams.get("session") === sessionId &&
    !sessionState.loading &&
    Boolean(sessionState.error) &&
    !sessionState.rows.length;

  return h(
    "section",
    { className: `workagent-conversation${side ? " is-side-chat" : ""}` },
    forkTarget
      ? h(
          Dialog,
          {
            title: "从这里创建分支？",
            onClose: () => setForkTarget(null),
          },
          h(
            "div",
            { className: "workagent-fork-content" },
            h(Icon, { name: "branch", size: 28 }),
            h(
              "p",
              null,
              "将保留到这条消息为止的上下文，在新对话中继续探索。当前对话会保留。",
            ),
            h(
              "div",
              { className: "workagent-actions" },
              h(
                Button,
                { autoFocus: true, onClick: () => setForkTarget(null) },
                "继续当前对话",
              ),
              h(
                Button,
                {
                  className: "workagent-button is-primary",
                  onClick: () => {
                    const target = forkTarget;
                    setForkTarget(null);
                    void fork(
                      target.messageId,
                      target.replacementContent,
                      true,
                    );
                  },
                },
                "创建分支",
              ),
            ),
          ),
        )
      : null,
    side
      ? sideHeader
      : h(
          "header",
          { className: "workagent-conversation-title" },
          session ? h(SessionAvatar, { session }) : null,
          h(
            "div",
            null,
            h(
              "strong",
              null,
              session
                ? session.workspaceId?.startsWith("shared:")
                  ? h(PersonalTaskTitle, { session })
                  : displaySessionTitle(session.title)
                : "正在加载会话…",
            ),
            session
              ? h(
                  "span",
                  null,
                  `${displayPresetName(session.preset?.resolvedSnapshot?.name || session.preset?.presetId || session.engine)} · 当前会话`,
                )
              : null,
          ),
        ),
    staleSharedTask ? h(StalePersonalTask, { sessionId }) : null,
    h(
      "div",
      {
        className: "workagent-message-list",
        "aria-live": "polite",
        ref: messageList,
      },
      h(ConversationMessageTarget, { sessionId }),
      messageState.loading
        ? h("p", { className: "workagent-muted" }, "正在加载消息…")
        : visibleMessages.length === 0 && !visibleQueue.length && !draft
          ? h(
              "div",
              { className: "workagent-conversation-empty" },
              side
                ? h(
                    "div",
                    { className: "workagent-side-empty-icon" },
                    h(Icon, { name: "chatgpt", size: 24 }),
                  )
                : null,
              h("strong", null, side ? "顺便问一句" : "从这里继续对话"),
              h(
                "span",
                null,
                side
                  ? "另开一个话题，和主对话分开记录。"
                  : "消息和回复会保存在当前对话中。",
              ),
            )
          : null,
      ...questionMessages.map((message) =>
        message.role === "assistant" && message.kind === "question"
          ? h(
              workbench.Question,
              {
                key: message.id,
                id: message.id,
                sessionId,
                answered: questionMessages.some(
                  (row) =>
                    row.role === "user" && row.replyTo?.id === message.id,
                ),
                disabled: submitting || attachmentsBusy,
                onReply: (content) => answerQuestion(message, content),
              },
              h(Markdown, { workspaceId: session?.workspaceId }, message.text),
              h(MessageActions, { message, disabled: submitting }),
            )
          : h(
              "article",
              {
                key: message.id,
                className: `workagent-message is-${message.role}`,
                "data-message-id": message.id,
              },
              message.role === "assistant"
                ? h(SessionAvatar, { session })
                : null,
              message.replyTo
                ? h(
                    "button",
                    {
                      type: "button",
                      className: "workagent-reply-reference",
                      title: message.replyTo.text,
                      onClick: () => {
                        const target = document.getElementById(
                          `workagent-question-${message.replyTo.id}`,
                        );
                        if (!target) return;
                        const details = target.querySelector("details");
                        if (details) details.open = true;
                        target.scrollIntoView({
                          block: "nearest",
                          behavior: "smooth",
                        });
                      },
                    },
                    `↩ 回复补充问题 · ${message.replyTo.text}`,
                  )
                : null,
              h(Markdown, { workspaceId: session?.workspaceId }, message.text),
              message.status
                ? h(
                    "footer",
                    {
                      className: "workagent-message-delivery",
                      role: message.status === "failed" ? "alert" : undefined,
                      "data-delivery-status": message.status,
                    },
                    message.status === "sending"
                      ? "发送中…"
                      : message.status === "failed"
                        ? "发送失败"
                        : null,
                    message.status === "failed"
                      ? h(
                          React.Fragment,
                          null,
                          h("span", null, message.error),
                          h(
                            Button,
                            {
                              disabled: submitting,
                              onClick: (event) =>
                                send(event, undefined, message),
                            },
                            "重试发送",
                          ),
                        )
                      : null,
                  )
                : h(MessageActions, {
                    message,
                    disabled: submitting,
                    onEdit:
                      message.role === "user" && !side
                        ? () => {
                            setEditing(message.id);
                            setEditContent(message.text);
                          }
                        : undefined,
                    onFork:
                      message.role === "assistant" && !side
                        ? () => void fork(message.id)
                        : undefined,
                  }),
              editing === message.id
                ? h(
                    "form",
                    {
                      className: "workagent-message-editor",
                      onSubmit: (event) => {
                        event.preventDefault();
                        if (editContent.trim())
                          void fork(message.id, editContent.trim());
                      },
                    },
                    h(ComposerInput, {
                      "aria-label": "编辑消息",
                      workspaceId: session?.workspaceId,
                      autoFocus: true,
                      value: editContent,
                      onChange: (event) => setEditContent(event.target.value),
                      onKeyDown: submitComposerOnEnter,
                    }),
                    h(
                      "small",
                      null,
                      `${busy ? "运行中的原任务会先停止。" : ""}从这条消息前重新继续，原会话保留。此操作不会回滚已修改的文件。`,
                    ),
                    h(
                      "div",
                      { className: "workagent-actions" },
                      h(
                        Button,
                        {
                          type: "submit",
                          disabled: submitting || !editContent.trim(),
                        },
                        submitting ? "正在重发…" : "保存并重发",
                      ),
                      h(
                        Button,
                        {
                          disabled: submitting,
                          onClick: () => setEditing(null),
                        },
                        "取消编辑",
                      ),
                    ),
                  )
                : null,
            ),
      ),
      visibleQueue.length
        ? h(
            "div",
            {
              className: "workagent-message-queue",
              "aria-label": "待发送消息",
            },
            h("small", null, `排队消息（${visibleQueue.length}）`),
            ...visibleQueue.map((row) =>
              h(
                "article",
                {
                  key: row.messageId,
                  className:
                    "workagent-message is-user workagent-queued-message",
                  "data-message-id": row.messageId,
                },
                h(
                  "div",
                  null,
                  h(
                    Markdown,
                    { workspaceId: session?.workspaceId },
                    row.content,
                  ),
                  h(
                    "small",
                    { "data-delivery-status": row.status || "queued" },
                    row.status === "sending"
                      ? "发送中…"
                      : row.status === "failed"
                        ? "发送失败"
                        : "排队中",
                  ),
                  row.error
                    ? h(
                        "small",
                        { className: "workagent-error" },
                        friendlyError(row.error),
                      )
                    : null,
                ),
                row.status === "failed"
                  ? h(
                      Button,
                      {
                        disabled: submitting,
                        onClick: (event) => send(event, undefined, row),
                      },
                      "重试发送",
                    )
                  : null,
                h(
                  Button,
                  {
                    className: "workagent-queue-icon",
                    "aria-label": busy ? "立即追加" : "发送排队消息",
                    title: busy ? "立即追加到当前任务" : "发送这条消息",
                    disabled: submitting || !!row.status,
                    onClick: () =>
                      void updateQueue(row.messageId, busy ? "steer" : "send"),
                  },
                  h(Icon, { name: busy ? "steer" : "send" }),
                ),
                h(
                  Button,
                  {
                    className: "workagent-queue-icon",
                    "aria-label": "移除排队消息",
                    title: "移除排队消息",
                    disabled: submitting || !!row.status,
                    onClick: () => void updateQueue(row.messageId, "remove"),
                  },
                  h(Icon, { name: "close" }),
                ),
              ),
            ),
          )
        : null,
      h(workbench.Tools, {
        tools: nativeState.value?.tools,
        workspaceId: session?.workspaceId,
      }),
      h(workbench.Artifacts, {
        sessionId: id,
        workspaceId: session?.workspaceId,
        revision: messageState.rows.length,
      }),
      h(workbench.Process, { items: nativeState.value?.processes }),
      draft
        ? h(
            "article",
            { className: "workagent-message is-assistant is-streaming" },
            h(SessionAvatar, { session }),
            h(
              Markdown,
              { workspaceId: session?.workspaceId, streaming: true },
              draft,
            ),
          )
        : busy
          ? h(
              "div",
              {
                className: "workagent-thinking",
                role: "status",
                "aria-live": "polite",
              },
              h("span", null),
              h("span", null),
              h("span", null),
              progress ||
                (pending.some((row) => row.status === "sending" && !row.queued)
                  ? "正在发送…"
                  : "正在思考"),
            )
          : null,
    ),
    h(
      ComposerForm,
      { className: "workagent-conversation-composer", onSubmit: send },
      h(workbench.ComposerTools, {
        onBusyChange: setAttachmentsBusy,
        key: sessionId,
        session,
        input,
        setInput,
        onError: setError,
        disabled: submitting,
      }),
      h(ComposerInput, {
        "aria-label": side ? "侧聊消息" : "继续对话",
        workspaceId: session?.workspaceId,
        disabled: sessionState.rows[0]?.id !== sessionId,
        value: input,
        onChange: (event) => setInput(event.target.value),
        onKeyDown: (event) => {
          const cursor = historyCursor.current;
          const history = messageState.rows
            .filter((row) => row.role === "user")
            .map((row) => row.text)
            .reverse();
          if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            if (cursor.index === -1) cursor.saved = input;
            cursor.index = Math.max(
              -1,
              Math.min(
                history.length - 1,
                cursor.index + (event.key === "ArrowUp" ? 1 : -1),
              ),
            );
            setInput(
              cursor.index === -1 ? cursor.saved : history[cursor.index],
            );
            return;
          }
          submitComposerOnEnter(event, () => {
            submitGesture.current = event.ctrlKey || event.metaKey;
          });
        },
        title: "Alt + ↑/↓ 浏览历史输入；Shift + Enter 换行",
        placeholder: busy
          ? busyEnter === "queue"
            ? "输入消息…"
            : "输入补充指令，调整当前任务…"
          : side
            ? "顺便问一句…"
            : "继续聊聊…",
      }),
      h(
        "div",
        { className: "workagent-conversation-composer-bar" },
        h(workbench.Controls, { ctx, session, busy, cancel }),
        error
          ? h("span", { role: "alert", className: "workagent-error" }, error)
          : busy
            ? h(
                "span",
                { className: "workagent-muted" },
                busyEnter === "queue"
                  ? "消息将排队，当前任务完成后发送"
                  : session?.engine === "kimi"
                    ? "补充指令会停止当前生成，再继续执行"
                    : "补充指令会送入当前任务",
              )
            : null,
        busy
          ? h(
              "button",
              {
                type: "button",
                className: "workagent-composer-icon",
                "aria-label": "停止",
                title: "停止当前任务",
                onClick: () => void cancel(),
              },
              h(Icon, { name: "stop", size: 20 }),
            )
          : null,
        h(
          "button",
          {
            type: "submit",
            className: "workagent-composer-icon",
            "aria-label": "发送",
            title: submitting
              ? "提交中…"
              : busy
                ? busyEnter === "queue"
                  ? "排队发送"
                  : "立即追加"
                : "发送",
            disabled: !input.trim() || submitting || attachmentsBusy,
          },
          h(Icon, { name: "send", size: 20 }),
        ),
      ),
    ),
  );
}

// The project row owns the personal task's displayed name, including renames.
function PersonalTaskTitle({ session }) {
  const state = SharedPage.useShared();
  const row = state.conversations.find(
    (item) =>
      item.kind === "personal_task" && item.runtime_session_id === session.id,
  );
  return displaySessionTitle(row?.name || session.title);
}

// A personal task's portal row can outlive its runtime session; offer to
// remove the stale record instead of leaving a conversation that never loads.
function StalePersonalTask({ sessionId }) {
  const state = SharedPage.useShared();
  const [busy, setBusy] = React.useState(false);
  const row = state.conversations.find(
    (item) =>
      item.kind === "personal_task" && item.runtime_session_id === sessionId,
  );
  const remove = async () => {
    if (!row || busy) return;
    setBusy(true);
    try {
      await request("/api/portal/shared-conversations", {
        method: "DELETE",
        body: JSON.stringify({ conversation_id: row.id }),
      });
      await SharedPage.refresh();
      navigation.navigate(SharedPage.route(row.project_id));
    } catch {
      setBusy(false);
    }
  };
  return h(
    "p",
    { role: "alert", className: "workagent-error" },
    "这个个人任务的会话已删除或不可用。",
    row
      ? h(
          Button,
          { disabled: busy, onClick: remove },
          busy ? "正在移除…" : "移除该记录",
        )
      : null,
  );
}

export { RuntimeConversation };
