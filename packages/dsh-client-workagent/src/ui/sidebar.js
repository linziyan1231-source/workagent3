import { createElement as h } from "react";
import { Icon } from "./icons.js";

function SidebarPin({ pinned = true }) {
  return h(Icon, {
    name: "pin",
    size: 14,
    className: `workagent-sidebar-pin${pinned ? " is-pinned" : ""}`,
  });
}

function SidebarAction({ label, icon = "more", children, ...props }) {
  return h(
    "button",
    {
      type: "button",
      className: "workagent-row-action",
      "aria-label": label,
      title: label,
      ...props,
    },
    children ||
      (icon === "pin"
        ? h(SidebarPin, { pinned: props["aria-pressed"] === true })
        : h(Icon, { name: icon, size: 14 })),
  );
}

function SidebarStatus({ running, unread, label }) {
  if (!running && !unread) return null;
  return h("span", {
    className: `workagent-session-status ${running ? "is-running" : "is-unread"}`,
    role: "img",
    "aria-label": label || (running ? "正在运行" : "未读"),
    title: label || (running ? "正在运行" : "未读"),
  });
}

function SidebarRow({
  title,
  subtitle,
  icon = h(Icon, { name: "chat", size: 16 }),
  status,
  meta,
  pinned = false,
  selected = false,
  onOpen,
  actions,
  leading,
  rowProps = {},
  buttonProps = {},
  kind = "session",
  children,
}) {
  return h(
    "div",
    {
      ...rowProps,
      className: [
        kind === "project"
          ? "workagent-sidebar-project-row"
          : "workagent-sidebar-session",
        rowProps.className,
      ]
        .filter(Boolean)
        .join(" "),
    },
    leading,
    h(
      "button",
      {
        type: "button",
        onClick: onOpen,
        "aria-current": selected ? "page" : undefined,
        ...buttonProps,
        className: ["is-main", selected && "is-active", buttonProps.className]
          .filter(Boolean)
          .join(" "),
      },
      icon,
      h(
        "span",
        { className: "workagent-sidebar-label" },
        h("span", { className: "workagent-session-title" }, title),
        subtitle
          ? h("span", { className: "workagent-sidebar-subtitle" }, subtitle)
          : null,
      ),
      status,
      meta || pinned
        ? h(
            "span",
            { className: "workagent-sidebar-meta" },
            meta,
            pinned ? h(SidebarPin) : null,
          )
        : null,
    ),
    actions,
    children,
  );
}

function SidebarGroup({
  title,
  icon,
  expanded,
  onToggle,
  actions,
  badge,
  pinned = false,
  children,
  ...props
}) {
  return h(
    "section",
    {
      ...props,
      className: ["workagent-sidebar-project", props.className]
        .filter(Boolean)
        .join(" "),
    },
    h(SidebarRow, {
      kind: "project",
      title,
      icon: h(
        "span",
        { className: "workagent-sidebar-group-icons" },
        h(Icon, { name: expanded ? "chevronDown" : "chevronRight", size: 13 }),
        icon,
      ),
      meta: badge,
      pinned,
      onOpen: onToggle,
      buttonProps: { "aria-expanded": expanded },
      actions,
    }),
    expanded
      ? h("div", { className: "workagent-sidebar-project-sessions" }, children)
      : null,
  );
}

function SidebarHeader({
  title,
  heading,
  expanded,
  onToggle,
  actions,
  children,
}) {
  return h(
    "div",
    { className: "workagent-sidebar-heading" },
    heading ||
      (onToggle
        ? h(
            "button",
            {
              type: "button",
              className: "workagent-sidebar-section-toggle",
              "aria-expanded": expanded,
              "aria-label": `${expanded ? "收起" : "展开"}${title}`,
              onClick: onToggle,
            },
            h(Icon, {
              name: expanded ? "chevronDown" : "chevronRight",
              size: 13,
            }),
            h("span", null, title),
          )
        : h("span", { className: "workagent-sidebar-section-label" }, title)),
    h(
      "div",
      { className: "workagent-sidebar-heading-actions" },
      actions,
      children,
    ),
  );
}

function SidebarSearch(props) {
  return h("input", {
    type: "text",
    ...props,
    className: "workagent-sidebar-search",
  });
}

export {
  SidebarAction,
  SidebarStatus,
  SidebarRow,
  SidebarGroup,
  SidebarHeader,
  SidebarSearch,
};
