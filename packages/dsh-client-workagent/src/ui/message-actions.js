import { Button } from "./elements.js";
import { Icon } from "./icons.js";
import React from "react";
import { createElement as h } from "react";

async function copyMessageText(text) {
  if (navigator.clipboard && window.isSecureContext)
    return navigator.clipboard.writeText(text);
  const field = document.createElement("textarea");
  field.value = text;
  field.style.cssText = "position:fixed;left:-9999px;top:0";
  const focused = document.activeElement;
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  focused?.focus();
  if (!copied) throw new Error("复制失败，请重试");
}

function MessageActions({ message, disabled, onEdit, onFork }) {
  const [copyState, setCopyState] = React.useState("");
  React.useEffect(() => {
    if (!copyState) return;
    const timer = setTimeout(() => setCopyState(""), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);
  const action = (name, icon, onClick, unavailable = false) =>
    h(
      Button,
      {
        className: "workagent-button workagent-message-action",
        disabled: unavailable,
        "aria-label": name,
        "data-tooltip": name,
        onClick,
      },
      h(Icon, { name: icon, size: 16 }),
    );
  return h(
    "footer",
    { className: "workagent-message-actions" },
    onEdit ? action("编辑", "edit", onEdit, disabled) : null,
    onFork ? action("分支", "branch", onFork, disabled) : null,
    action(
      copyState || "复制",
      copyState === "已复制" ? "check" : "copy",
      async () => {
        try {
          await copyMessageText(message.text);
          setCopyState("已复制");
        } catch {
          setCopyState("复制失败，请重试");
        }
      },
    ),
    h("span", { className: "workagent-sr-only", role: "status" }, copyState),
  );
}

export { MessageActions };
