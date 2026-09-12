import { createElement as h } from "react";
import { Dialog, ActionList } from "./dialog.js";
import { Button, Input } from "./elements.js";
import { Icon } from "./icons.js";

export function ConversationMenu({
  title,
  projectName,
  pinned,
  onPin,
  onReminder,
  onManage,
  onClose,
  busy = false,
  error,
}) {
  return h(
    Dialog,
    { title, "aria-label": "对话操作", onClose, closeDisabled: busy },
    projectName ? h("small", null, `项目：${projectName}`) : null,
    h(
      ActionList,
      null,
      onPin
        ? h(
            Button,
            { onClick: onPin, disabled: busy },
            h(Icon, { name: "pin" }),
            pinned ? "取消置顶" : "置顶对话",
          )
        : null,
      onReminder
        ? h(
            Button,
            { onClick: onReminder, disabled: busy },
            h(Icon, { name: "notifications" }),
            "消息提醒",
          )
        : null,
      h(
        Button,
        { onClick: onManage, disabled: busy },
        h(Icon, { name: "edit" }),
        "管理对话",
      ),
    ),
    error
      ? h("p", { role: "alert", className: "workagent-error" }, error)
      : null,
  );
}

// The owning feature controls the draft, confirmation state and persistence.
export function ConversationManagementDialog({
  title,
  name,
  onNameChange,
  onSave,
  onDelete,
  onRequestDelete,
  onClose,
  busy = false,
  error,
  deleting = false,
  deleteDescription = "删除后，这个对话将不再显示。",
}) {
  return h(
    Dialog,
    {
      title: title || (deleting ? "确认删除" : "管理对话"),
      as: "form",
      onClose,
      closeDisabled: busy,
      onSubmit: (event) => {
        event.preventDefault();
        if (busy || (!deleting && !name.trim())) return;
        if (deleting) onDelete(event);
        else onSave(event);
      },
    },
    deleting
      ? h("p", null, deleteDescription)
      : h(Input, {
          "aria-label": "对话名称",
          autoFocus: true,
          value: name,
          onChange: (event) => onNameChange(event.target.value),
          disabled: busy,
          required: true,
          maxLength: 120,
        }),
    error
      ? h("p", { role: "alert", className: "workagent-error" }, error)
      : null,
    h(
      "div",
      { className: "workagent-dialog-actions" },
      h(
        Button,
        {
          type: "submit",
          variant: deleting ? "danger" : "primary",
          disabled: busy || (!deleting && !name.trim()),
        },
        deleting ? (busy ? "删除中…" : "删除") : busy ? "保存中…" : "保存",
      ),
      !deleting
        ? h(
            Button,
            { variant: "danger", onClick: onRequestDelete, disabled: busy },
            "删除",
          )
        : null,
      h(Button, { onClick: onClose, disabled: busy }, "取消"),
    ),
  );
}
