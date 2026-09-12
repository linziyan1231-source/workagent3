import { usePresets, mutatePreset as mutate } from "./api.js";
import { AcpCredentials, useAcpCatalog } from "./acp.js";
import { navigation } from "../../host/navigation.js";
import { apiRoot, request } from "../../platform/api.js";
import { useResource } from "../../platform/resources.js";
import {
  AssistantAvatar,
  AvatarField,
  AvatarPicker,
} from "./avatar-components.js";
import {
  Button,
  Field,
  Input,
  Section,
  Select,
  Status,
  Switch,
} from "../../ui/elements.js";
import { useConfirm } from "../../ui/dialog.js";
import { displayPresetName, displayValue } from "../../ui/labels.js";
import { AgentDisplaySettings } from "./picker.js";
import React from "react";
import { createElement as h } from "react";

const defaultPreset = {
  enabled: true,
  description: "",
  avatar: null,
  modelId: null,
  systemPrompt: "",
  workspacePolicy: "optional",
  skillIds: [],
  mcpServerIds: [],
  toolAllowlist: [],
  approvalPolicy: "on_risk",
};

function CapabilityPicker({ name, label, state, selected = [], markDisabled }) {
  const [ids, setIds] = React.useState(selected);
  const [query, setQuery] = React.useState("");
  const visible = state.rows.filter((row) =>
    `${row.name} ${row.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  return h(
    "fieldset",
    { className: "workagent-capability-picker" },
    h("legend", null, label),
    h("input", { type: "hidden", name, value: ids.join(",") }),
    h(
      "details",
      null,
      h(
        "summary",
        null,
        ids.length ? `已选择 ${ids.length} 项` : `选择${label}`,
      ),
      h("input", {
        type: "search",
        "aria-label": `搜索${label}`,
        placeholder: "按名称搜索",
        value: query,
        onChange: (e) => setQuery(e.target.value),
      }),
      state.loading
        ? h("p", null, "正在加载…")
        : state.error
          ? h("p", { role: "alert" }, state.error)
          : h(
              "div",
              { className: "workagent-capability-options" },
              ...visible.map((row) =>
                h(
                  "label",
                  { key: row.id },
                  h("input", {
                    type: "checkbox",
                    checked: ids.includes(row.id),
                    onChange: (e) =>
                      setIds(
                        e.target.checked
                          ? [...ids, row.id]
                          : ids.filter((id) => id !== row.id),
                      ),
                  }),
                  h(
                    "span",
                    null,
                    markDisabled && row.enabled === false
                      ? `${row.name}（已停用）`
                      : row.name,
                  ),
                ),
              ),
              !visible.length
                ? h("p", null, "没有匹配项，可先从市场获取。")
                : null,
            ),
    ),
    ids.length
      ? h(
          "div",
          { className: "workagent-capability-selected" },
          ...ids.map((id) =>
            h(
              "button",
              {
                type: "button",
                key: id,
                "aria-label": `移除${state.rows.find((row) => row.id === id)?.name || id}`,
                onClick: () => setIds(ids.filter((value) => value !== id)),
              },
              `${state.rows.find((row) => row.id === id)?.name || id} ×`,
            ),
          ),
        )
      : null,
  );
}

function PresetsSection() {
  const { confirm, confirmation } = useConfirm();
  const endpoint = `${apiRoot}/presets`;
  const [state, refresh] = usePresets();
  const [skills] = useResource(`${apiRoot}/skills`);
  const [servers] = useResource(`${apiRoot}/mcp-servers`);
  const [acp] = useAcpCatalog();
  const [editing, setEditing] = React.useState(null);
  const [formVersion, setFormVersion] = React.useState(0);
  const [avatarEditing, setAvatarEditing] = React.useState(null);
  const [avatarBusy, setAvatarBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [pendingId, setPendingId] = React.useState(null);
  const toggle = async (row, enabled) => {
    setPendingId(row.id);
    await mutate(
      refresh,
      setError,
      `${endpoint}/${encodeURIComponent(row.id)}`,
      "PATCH",
      { enabled },
    );
    setPendingId(null);
  };
  const submit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const csv = (name) =>
      String(values.get(name) || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    const body = {
      ...defaultPreset,
      ...(editing
        ? {
            description: editing.description,
            enabled: editing.enabled,
            workspacePolicy: editing.workspacePolicy,
            toolAllowlist: editing.toolAllowlist,
            approvalPolicy: editing.approvalPolicy,
          }
        : {}),
      name: String(values.get("name")),
      avatar: String(values.get("avatar") || "") || null,
      engine: String(values.get("engine")).startsWith("acp:")
        ? "acp"
        : String(values.get("engine")),
      ...(String(values.get("engine")).startsWith("acp:")
        ? { acpCatalogId: String(values.get("engine")).slice(4) }
        : {}),
      modelId:
        editing?.engine === values.get("engine") ||
        (editing?.engine === "acp" &&
          `acp:${editing.acpCatalogId}` === values.get("engine"))
          ? editing.modelId
          : null,
      systemPrompt: String(values.get("systemPrompt") || ""),
      skillIds: csv("skillIds"),
      mcpServerIds: csv("mcpServerIds"),
    };
    const saved = await mutate(
      refresh,
      setError,
      editing ? `${endpoint}/${encodeURIComponent(editing.id)}` : endpoint,
      editing ? "PATCH" : "POST",
      body,
    );
    if (!saved) return;
    setEditing(null);
    setFormVersion((version) => version + 1);
  };
  return h(
    Section,
    { title: "助手" },
    h(AcpCredentials),
    h(AgentDisplaySettings, { presets: state.rows }),
    h(
      Button,
      { onClick: () => navigation.navigate("/?workagent=teams") },
      "AI 团队",
    ),
    h(
      "p",
      { className: "workagent-muted" },
      "在这里配置助手的引擎与能力；默认模型、思考强度和权限在「设置 → 模型」中调整。关闭助手后，已有对话仍可继续。",
    ),
    h(
      "form",
      {
        className: "workagent-form",
        onSubmit: submit,
        key: `preset-form-${editing?.id || "new"}-${formVersion}`,
      },
      h(
        Field,
        { label: "名称" },
        h(Input, {
          name: "name",
          required: true,
          defaultValue: editing?.name || "",
        }),
      ),
      h(AvatarField, { preset: editing, onBusyChange: setAvatarBusy }),
      h(
        Field,
        { label: "引擎" },
        h(Select, {
          name: "engine",
          defaultValue:
            editing?.engine === "acp"
              ? `acp:${editing.acpCatalogId}`
              : editing?.engine || "harness",
          options: [
            ["harness", "通用引擎"],
            ["codex", "Codex"],
            ["kimi", "Kimi"],
            ...acp.rows
              .filter((row) => row.enabled || row.id === editing?.acpCatalogId)
              .map((row) => [
                `acp:${row.id}`,
                `${row.label}${row.enabled ? "" : "（已停用）"}`,
              ]),
          ],
        }),
      ),
      h(CapabilityPicker, {
        name: "skillIds",
        label: "技能",
        state: skills,
        selected: editing?.skillIds,
        markDisabled: true,
      }),
      h(CapabilityPicker, {
        name: "mcpServerIds",
        label: "MCP 服务",
        state: servers,
        selected: editing?.mcpServerIds,
      }),
      h(
        Field,
        { label: "系统提示词" },
        h("textarea", {
          name: "systemPrompt",
          defaultValue: editing?.systemPrompt || "",
        }),
      ),
      h(
        "button",
        {
          className: "workagent-button",
          type: "submit",
          disabled: avatarBusy,
        },
        editing ? "保存助手" : "创建助手",
      ),
      editing
        ? h(Button, { onClick: () => setEditing(null) }, "取消编辑")
        : null,
    ),
    error
      ? h("p", { role: "alert", className: "workagent-error" }, error)
      : null,
    h(Status, { state }),
    ...state.rows.map((row) =>
      h(
        "article",
        {
          key: row.id,
          className: "workagent-card workagent-assistant-card",
        },
        h(
          "div",
          { className: "workagent-assistant-info" },
          h(AssistantAvatar, { preset: row, size: 36 }),
          h("strong", null, displayPresetName(row.name)),
          h("div", { className: "workagent-muted" }, displayValue(row.engine)),
        ),
        h(Switch, {
          "aria-label": `${displayPresetName(row.name)} 开关`,
          checked: row.enabled,
          disabled: pendingId !== null,
          title: row.enabled ? "关闭助手" : "开启助手",
          onChange: (enabled) => toggle(row, enabled),
        }),
        h(
          Button,
          {
            onClick: () =>
              setAvatarEditing(avatarEditing === row.id ? null : row.id),
            "aria-label": `更换${displayPresetName(row.name)}头像`,
          },
          "更换头像",
        ),
        avatarEditing === row.id
          ? h(
              "div",
              { style: { gridColumn: "1 / -1", width: "100%" } },
              h(AvatarPicker, {
                preset: row,
                value: row.avatar,
                onChange: async (avatar) => {
                  await request(`${endpoint}/${encodeURIComponent(row.id)}`, {
                    method: "PATCH",
                    body: JSON.stringify({ avatar }),
                  });
                  await refresh();
                  window.dispatchEvent(
                    new window.CustomEvent("workagent:presets-changed"),
                  );
                },
              }),
            )
          : null,
        row.source === "user"
          ? h(
              "div",
              {
                className: "workagent-actions workagent-assistant-actions",
              },
              h(Button, { onClick: () => setEditing(row) }, "编辑"),
              h(
                Button,
                {
                  disabled: pendingId !== null,
                  onClick: async () => {
                    if (
                      !(await confirm({
                        title: "删除助手",
                        description: `确定删除助手“${displayPresetName(row.name)}”？此操作无法撤销。`,
                        danger: true,
                        confirmLabel: "删除助手",
                      }))
                    )
                      return;
                    setPendingId(row.id);
                    const deleted = await mutate(
                      refresh,
                      setError,
                      `${endpoint}/${encodeURIComponent(row.id)}`,
                      "DELETE",
                    );
                    setPendingId(null);
                    if (deleted && editing?.id === row.id) setEditing(null);
                  },
                },
                "删除",
              ),
            )
          : null,
      ),
    ),
    confirmation,
  );
}

export { PresetsSection };
