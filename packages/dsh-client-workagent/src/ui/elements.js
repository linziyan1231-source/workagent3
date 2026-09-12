import { friendlyError } from "./labels.js";
import { createElement as h } from "react";

function Field({ label, children, className, ...props }) {
  return h(
    "label",
    {
      ...props,
      className: ["workagent-field", className].filter(Boolean).join(" "),
    },
    label,
    children,
  );
}

function Input({ className, ...props }) {
  return h("input", {
    ...props,
    "data-dialog-autofocus": props.autoFocus ? "" : undefined,
    className: ["workagent-control", className].filter(Boolean).join(" "),
  });
}

function Select({ options, heading, className, ...props }) {
  const choices = options.map(([value, label]) =>
    h("option", { value, key: value }, label),
  );
  return h(
    "select",
    {
      ...props,
      className: ["workagent-control", className].filter(Boolean).join(" "),
    },
    ...(heading ? [h("optgroup", { label: heading }, choices)] : choices),
  );
}

function Button({ children, className, variant, ...props }) {
  return h(
    "button",
    {
      type: "button",
      ...props,
      "data-dialog-autofocus": props.autoFocus ? "" : undefined,
      className: ["workagent-button", variant && `is-${variant}`, className]
        .filter(Boolean)
        .join(" "),
    },
    children,
  );
}

function Switch({ checked, onChange, className, ...props }) {
  return h("button", {
    type: "button",
    ...props,
    role: "switch",
    "aria-checked": checked,
    className: ["workagent-switch", className].filter(Boolean).join(" "),
    onClick: () => onChange(!checked),
  });
}

function Status({ state }) {
  if (state.loading) return h("p", { className: "workagent-muted" }, "加载中…");
  if (state.error)
    return h(
      "p",
      { role: "alert", className: "workagent-error" },
      friendlyError(state.error),
    );
  if (state.rows.length === 0)
    return h("p", { className: "workagent-muted" }, "暂无数据");
  return null;
}

function Card({ title, detail, children, ...props }) {
  return h(
    "article",
    {
      ...props,
      className: ["workagent-card", props.className].filter(Boolean).join(" "),
    },
    h("strong", null, title),
    detail ? h("div", { className: "workagent-muted" }, detail) : null,
    children ? h("div", { className: "workagent-actions" }, children) : null,
  );
}

function Section({ title, children }) {
  return h(
    "section",
    { className: "workagent-section", "data-workagent-section": title },
    h("h2", null, title),
    children,
  );
}

export { Field, Input, Select, Button, Switch, Status, Card, Section };
