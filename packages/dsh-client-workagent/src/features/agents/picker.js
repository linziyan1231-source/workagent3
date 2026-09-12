import { usePresets } from "./api.js";
import { apiRoot } from "../../platform/api.js";
import { useResource } from "../../platform/resources.js";
import { AssistantAvatar } from "./avatar-components.js";
import { Icon } from "../../ui/icons.js";
import { displayPresetName } from "../../ui/labels.js";
import { AGENT_PICK_KEY, HERO_AGENT_EVENT } from "./state.js";
import React from "react";
import { createElement as h } from "react";

function useAgentOrder(presets) {
  const key = "workagent.agent-order.v1";
  const eventName = "workagent:agent-order-changed";
  const read = () => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(value)
        ? value.filter((id) => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  };
  const [order, setOrder] = React.useState(read);
  React.useEffect(() => {
    const update = () => setOrder(read());
    window.addEventListener(eventName, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(eventName, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  const rows = [...presets].sort((a, b) => {
    const left = order.indexOf(a.id),
      right = order.indexOf(b.id);
    return (
      (left < 0 ? order.length : left) - (right < 0 ? order.length : right)
    );
  });
  const save = (ids) => {
    localStorage.setItem(key, JSON.stringify(ids));
    setOrder(ids);
    window.dispatchEvent(new Event(eventName));
  };
  return { rows, save };
}

function AgentDisplaySettings({ presets }) {
  const { rows, save } = useAgentOrder(presets.filter((row) => row.enabled));
  const [notice, setNotice] = React.useState("");
  const [error, setError] = React.useState("");
  const move = (index, delta) => {
    const ids = rows.map((row) => row.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    try {
      save(ids);
      setError("");
      setNotice("显示顺序已保存");
    } catch {
      setError("浏览器未能保存显示顺序，请检查存储空间后重试。");
    }
  };
  return h(
    "section",
    { className: "workagent-agent-order", "aria-label": "Agent 显示顺序" },
    h("h3", null, "主页 Agent 顺序"),
    h(
      "p",
      { className: "workagent-muted" },
      "前 3 个优先显示，其余收进「更多」。调整后立即生效，保存在当前浏览器。",
    ),
    h(
      "ol",
      null,
      ...rows.map((preset, index) =>
        h(
          "li",
          { key: preset.id },
          h(
            "span",
            {
              className: "workagent-agent-order-index",
              "aria-hidden": true,
            },
            index + 1,
          ),
          h(AssistantAvatar, { preset }),
          h(
            "span",
            { className: "workagent-agent-order-name" },
            displayPresetName(preset.name),
          ),
          h(
            "button",
            {
              type: "button",
              disabled: index === 0,
              "aria-label": `上移 ${displayPresetName(preset.name)}`,
              onClick: () => move(index, -1),
            },
            "↑",
          ),
          h(
            "button",
            {
              type: "button",
              disabled: index === rows.length - 1,
              "aria-label": `下移 ${displayPresetName(preset.name)}`,
              onClick: () => move(index, 1),
            },
            "↓",
          ),
        ),
      ),
    ),
    error
      ? h("p", { role: "alert" }, error)
      : notice
        ? h("p", { role: "status" }, notice)
        : null,
  );
}

function AgentPicker() {
  const [state] = usePresets((value) =>
    (Array.isArray(value) ? value : []).filter((preset) => preset.enabled),
  );
  const { rows } = useAgentOrder(state.rows);
  const [selected, setSelected] = React.useState(
    () => localStorage.getItem(AGENT_PICK_KEY) || "builtin-general",
  );
  const [open, setOpen] = React.useState(false);
  const root = React.useRef(null),
    more = React.useRef(null);
  React.useEffect(() => {
    const update = (event) => setSelected(event.detail);
    window.addEventListener(HERO_AGENT_EVENT, update);
    return () => window.removeEventListener(HERO_AGENT_EVENT, update);
  }, []);
  React.useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        more.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    root.current?.addEventListener("keydown", escape);
    const node = root.current;
    return () => {
      document.removeEventListener("pointerdown", outside);
      node?.removeEventListener("keydown", escape);
    };
  }, [open]);
  React.useEffect(() => {
    if (state.loading || rows.length === 0) return;
    if (rows.some((preset) => preset.id === selected)) return;
    const fallback =
      rows.find((preset) => preset.id === "builtin-general") || rows[0];
    setSelected(fallback.id);
    localStorage.setItem(AGENT_PICK_KEY, fallback.id);
  }, [selected, state.loading, state.rows]);
  const choose = (preset) => {
    setSelected(preset.id);
    setOpen(false);
    localStorage.setItem(AGENT_PICK_KEY, preset.id);
    window.dispatchEvent(
      new window.CustomEvent(HERO_AGENT_EVENT, { detail: preset.id }),
    );
  };
  if (state.loading || rows.length === 0) return null;
  const visible = rows.slice(0, 3);
  const active = rows.find((row) => row.id === selected);
  if (active && !visible.includes(active)) visible[visible.length - 1] = active;
  const hidden = rows.filter((row) => !visible.includes(row));
  const option = (preset, inMenu = false) =>
    h(
      "button",
      {
        key: preset.id,
        type: "button",
        role: "radio",
        "aria-checked": selected === preset.id,
        "data-agent-id": preset.id,
        tabIndex: inMenu || selected === preset.id ? 0 : -1,
        className: `workagent-agent${selected === preset.id ? " is-active" : ""}`,
        title: `切换到${displayPresetName(preset.name)}`,
        onClick: () => {
          choose(preset);
          requestAnimationFrame(() =>
            [...(root.current?.querySelectorAll("[data-agent-id]") || [])]
              .find((node) => node.dataset.agentId === preset.id)
              ?.focus(),
          );
        },
        onKeyDown: (event) => {
          if (
            ![
              "ArrowLeft",
              "ArrowRight",
              "ArrowUp",
              "ArrowDown",
              "Home",
              "End",
            ].includes(event.key)
          )
            return;
          event.preventDefault();
          const index = rows.indexOf(preset);
          const direction = ["ArrowRight", "ArrowDown"].includes(event.key)
            ? 1
            : -1;
          const next =
            rows[
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? rows.length - 1
                  : (index + direction + rows.length) % rows.length
            ];
          choose(next);
          requestAnimationFrame(() =>
            [...(root.current?.querySelectorAll("[data-agent-id]") || [])]
              .find((node) => node.dataset.agentId === next.id)
              ?.focus(),
          );
        },
      },
      h(AssistantAvatar, { preset }),
      h(
        "span",
        { className: "workagent-agent-name" },
        displayPresetName(preset.name),
      ),
    );
  return h(
    "div",
    {
      className: "workagent-agents",
      role: "radiogroup",
      "aria-label": "选择 Agent",
      ref: root,
    },
    h(
      "div",
      { className: "workagent-agent-strip" },
      ...visible.map((preset) => option(preset)),
      hidden.length
        ? h(
            "button",
            {
              ref: more,
              type: "button",
              className: "workagent-agent-more",
              "aria-label": `更多 Agent，${hidden.length} 个`,
              "aria-expanded": open,
              onClick: () => setOpen((value) => !value),
            },
            "更多",
            h(Icon, { name: "chevronDown", size: 14 }),
          )
        : null,
    ),
    open && hidden.length
      ? h(
          "div",
          {
            className: "workagent-agent-overflow",
            role: "group",
            "aria-label": "更多 Agent",
          },
          ...hidden.map((preset) => option(preset, true)),
        )
      : null,
  );
}

export { AgentDisplaySettings, AgentPicker };
