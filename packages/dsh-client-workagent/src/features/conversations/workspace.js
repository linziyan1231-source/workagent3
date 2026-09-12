import { apiRoot, request } from "../../platform/api.js";
import { useResource } from "../../platform/resources.js";
import { Button, Select } from "../../ui/elements.js";
import { Dialog } from "../../ui/dialog.js";
import { Icon } from "../../ui/icons.js";
import { displaySessionTitle, friendlyError } from "../../ui/labels.js";
import { ResizeHandle } from "../../ui/resize.js";
import { RuntimeConversation } from "./page.js";
import {
  RuntimeServices,
  hasStandardSessions,
  nativeSessionAction,
} from "./runtime.js";
import React from "react";
import { createElement as h } from "react";

function ConversationWorkspace({ sessionId }) {
  const ctx = React.useContext(RuntimeServices);
  const workspaceRef = React.useRef(null);
  const [workspaceWidth, setWorkspaceWidth] = React.useState(0);
  const [sideWidth, setSideWidth] = React.useState(
    () => Number(localStorage.getItem("workagent.side-chat.width")) || null,
  );
  React.useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    const measure = () =>
      setWorkspaceWidth(workspace.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);
  // Reserve 360px for the main chat and 24px for the drag handle.
  const sideMaxWidth = Math.max(320, workspaceWidth - 384);
  const visibleSideWidth = Math.max(
    320,
    Math.min(sideMaxWidth, sideWidth ?? Math.min(520, workspaceWidth * 0.38)),
  );
  const resizeSideWidth = (value) => {
    const next = Math.max(320, Math.min(sideMaxWidth, Math.round(value)));
    setSideWidth(next);
    localStorage.setItem("workagent.side-chat.width", String(next));
  };
  const [sideId, setSideId] = React.useState(() =>
    localStorage.getItem(`workagent.side-chat.${sessionId}`),
  );
  const [opening, setOpening] = React.useState(false);
  const [sideError, setSideError] = React.useState("");
  const [deleteTarget, setDeleteTarget] = React.useState(null);
  const [deleting, setDeleting] = React.useState(false);
  const deletingRef = React.useRef(false);
  const openingRef = React.useRef(false);
  const [sideState, reloadSides] = useResource(`${apiRoot}/sessions`, (rows) =>
    (Array.isArray(rows) ? rows : []).filter(
      (row) =>
        row.parentSessionId === sessionId && row.branchKind === "side_chat",
    ),
  );
  React.useEffect(() => {
    if (!sideId || sideState.loading || sideState.error || opening || deleting)
      return;
    if (!sideState.rows.some((row) => row.id === sideId)) {
      setSideId(null);
      localStorage.removeItem(`workagent.side-chat.${sessionId}`);
    }
  }, [sideId, sideState, opening, deleting, sessionId]);
  const deleteSideChat = async (event) => {
    event.preventDefault();
    if (!deleteTarget || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setSideError("");
    try {
      await request(`${apiRoot}/sessions/${encodeURIComponent(deleteTarget)}`, {
        method: "DELETE",
      });
      setSideId(null);
      localStorage.removeItem(`workagent.side-chat.${sessionId}`);
      setDeleteTarget(null);
      await reloadSides();
    } catch (error) {
      setSideError(friendlyError(error.message));
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };
  const openSideChat = async (content = "", fresh = false) => {
    if (openingRef.current) throw new Error("正在打开侧聊，请稍候");
    if (deletingRef.current || deleteTarget)
      throw new Error("请先完成侧聊删除操作");
    openingRef.current = true;
    setOpening(true);
    try {
      let target = fresh ? undefined : sideId;
      if (!target) {
        const result = await request(
          `${apiRoot}/sessions/${encodeURIComponent(sessionId)}/side-chat`,
          {
            method: "POST",
            body: "{}",
          },
        );
        target = result.id;
        await reloadSides();
      }
      setSideId(target);
      localStorage.setItem(`workagent.side-chat.${sessionId}`, target);
      if (content) {
        const current = await request(
          `${apiRoot}/sessions/${encodeURIComponent(target)}`,
        );
        if (
          hasStandardSessions(ctx) &&
          ["codex", "kimi", "acp"].includes(current.engine)
        )
          await nativeSessionAction(
            ctx,
            target,
            "prompt",
            [{ type: "text", text: content }],
            current.activity?.state === "running" ||
              current.activity?.state === "retrying"
              ? "steer"
              : "queue",
          );
        else
          await request(
            `${apiRoot}/sessions/${encodeURIComponent(target)}/${current.activity?.state === "running" || current.activity?.state === "retrying" ? "steer" : "turns"}`,
            {
              method: "POST",
              body: JSON.stringify({ content }),
            },
          );
      }
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  };
  return h(
    "div",
    {
      className: `workagent-conversation-workspace${sideId ? " has-side-chat" : ""}`,
      ref: workspaceRef,
      style: { "--workagent-side-chat-width": `${visibleSideWidth}px` },
    },
    h(RuntimeConversation, {
      key: sessionId,
      sessionId,
      onSideChat: openSideChat,
    }),
    opening
      ? h(
          "span",
          { role: "status", className: "workagent-side-opening" },
          "正在打开侧聊…",
        )
      : null,
    sideId
      ? h(ResizeHandle, {
          orientation: "vertical",
          label: "调整侧聊宽度",
          className: "workagent-side-resizer",
          value: visibleSideWidth,
          min: 320,
          max: Math.floor(sideMaxWidth),
          onChange: resizeSideWidth,
          measure: (event) => {
            const initial = event.clientX;
            const actualWidth =
              event.currentTarget.nextElementSibling.getBoundingClientRect()
                .width;
            return (move) => actualWidth + initial - move.clientX;
          },
        })
      : null,
    sideId
      ? h(
          "aside",
          { className: "workagent-side-chat", "aria-label": "侧聊 BTW" },
          h(RuntimeConversation, {
            key: sideId,
            sessionId: sideId,
            side: true,
            sideHeader: h(
              "header",
              {
                className: "workagent-conversation-title workagent-side-header",
              },
              h(
                "div",
                { className: "workagent-side-toolbar" },
                h(
                  "div",
                  { className: "workagent-side-heading" },
                  h("strong", null, "侧聊"),
                  h("span", { className: "workagent-side-badge" }, "BTW"),
                ),
                h(
                  "nav",
                  {
                    className: "workagent-side-actions",
                    "aria-label": "侧聊操作",
                  },
                  h(
                    Button,
                    {
                      className: "workagent-side-action",
                      "aria-label": "新侧聊",
                      title: "新建侧聊",
                      disabled: opening || deleting,
                      onClick: () => {
                        setSideError("");
                        void openSideChat("", true).catch((error) =>
                          setSideError(friendlyError(error.message)),
                        );
                      },
                    },
                    h(Icon, { name: "plus", size: 17 }),
                  ),
                  h(
                    Button,
                    {
                      className: "workagent-side-action is-delete",
                      "aria-label": "删除侧聊",
                      title: "删除侧聊",
                      disabled: opening || deleting,
                      onClick: () => {
                        setSideError("");
                        setDeleteTarget(sideId);
                      },
                    },
                    h(Icon, { name: "trash", size: 17 }),
                  ),
                ),
              ),
              sideState.rows.length > 1
                ? h(
                    "div",
                    { className: "workagent-side-picker" },
                    h(Select, {
                      "aria-label": "选择侧聊",
                      disabled: opening || deleting,
                      value: sideId,
                      onChange: (event) => {
                        setSideId(event.target.value);
                        localStorage.setItem(
                          `workagent.side-chat.${sessionId}`,
                          event.target.value,
                        );
                      },
                      options: sideState.rows.map((row, index) => [
                        row.id,
                        `${index + 1}. ${displaySessionTitle(row.title)}`,
                      ]),
                    }),
                    h(Icon, { name: "chevronDown", size: 14 }),
                  )
                : h(
                    "span",
                    { className: "workagent-side-caption" },
                    "和主对话分开记录",
                  ),
              sideError && !deleteTarget
                ? h(
                    "span",
                    { role: "alert", className: "workagent-error" },
                    sideError,
                  )
                : null,
            ),
          }),
        )
      : null,
    deleteTarget
      ? h(
          Dialog,
          {
            as: "form",
            role: "alertdialog",
            title: "删除这个侧聊？",
            "aria-label": "确认删除侧聊",
            closeDisabled: deleting,
            onSubmit: deleteSideChat,
            onClose: () => {
              setDeleteTarget(null);
              setSideError("");
            },
          },
          h(
            "p",
            null,
            "侧聊及其消息将被删除，主对话不受影响。再次打开会创建新的侧聊。",
          ),
          sideError
            ? h("p", { role: "alert", className: "workagent-error" }, sideError)
            : null,
          h(
            "div",
            { className: "workagent-actions" },
            h(
              Button,
              {
                autoFocus: true,
                disabled: deleting,
                onClick: () => {
                  setDeleteTarget(null);
                  setSideError("");
                },
              },
              "取消",
            ),
            h(
              Button,
              {
                type: "submit",
                className: "workagent-button is-danger",
                disabled: deleting,
              },
              deleting ? "正在删除…" : "确认删除",
            ),
          ),
        )
      : null,
  );
}

export { ConversationWorkspace };
