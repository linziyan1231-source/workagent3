import { usePresets } from "../agents/api.js";
import { createMarketplace } from "./marketplace.js";
import { apiRoot, request } from "../../platform/api.js";
import { useResource } from "../../platform/resources.js";
import {
  Button,
  Card,
  Field,
  Input,
  Section,
  Select,
  Status,
} from "../../ui/elements.js";
import { friendlyError } from "../../ui/labels.js";
import React from "react";
import { createElement as h } from "react";

const marketKinds = { skill: "技能", mcp: "MCP", assistant: "助手" };

const market = createMarketplace({
  React,
  h,
  request,
  Section,
  Button,
  Card,
  Field,
  Input,
  useResource,
  Status,
  friendlyError,
  PublishForm: MarketPublishForm,
});

function MarketplaceSection() {
  return h(market.MarketplaceSection);
}

function MarketPublishForm({ onPublished, entry }) {
  const [kind, setKind] = React.useState(entry?.kind || "skill");
  const [sourceId, setSourceId] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [skills] = useResource(`${apiRoot}/skills`);
  const [mcp] = useResource(`${apiRoot}/mcp-servers`);
  const [assistants] = usePresets();
  const state = { skill: skills, mcp, assistant: assistants }[kind];
  const options = state.rows.filter(
    (row) =>
      (row.source === "user" ||
        (kind === "skill" && row.source === "market")) &&
      `${row.name} ${row.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  const selected = state.rows.find((row) => row.id === sourceId);
  return h(
    "form",
    {
      className: "workagent-market-publish",
      onSubmit: async (event) => {
        event.preventDefault();
        setError("");
        setBusy(true);
        const values = new FormData(event.currentTarget);
        try {
          await request("/api/portal/marketplace", {
            method: "POST",
            body: JSON.stringify({
              kind,
              sourceId,
              name: String(values.get("name")),
              description: String(values.get("description")),
              version: String(values.get("version")),
              seriesId: entry?.seriesId || "",
              releaseNotes: String(values.get("releaseNotes") || ""),
            }),
          });
          await onPublished();
        } catch (cause) {
          setError(friendlyError(cause.message));
        } finally {
          setBusy(false);
        }
      },
    },
    h("h3", null, "发布到共享市场"),
    h(
      "p",
      null,
      "所选内容和助手绑定的技能、MCP 配置会随版本共享给其他成员。连接密钥由获取者自行填写。",
    ),
    h(
      Field,
      { label: "发布类型" },
      h(Select, {
        value: kind,
        disabled: !!entry || busy,
        onChange: (e) => {
          setKind(e.target.value);
          setSourceId("");
          setQuery("");
        },
        options: Object.entries(marketKinds),
      }),
    ),
    h(
      Field,
      { label: "搜索已安装内容" },
      h(Input, {
        type: "search",
        value: query,
        onChange: (e) => setQuery(e.target.value),
      }),
    ),
    h(
      Field,
      { label: "发布内容" },
      h(Select, {
        value: sourceId,
        required: true,
        onChange: (e) => setSourceId(e.target.value),
        options: [["", "请选择"], ...options.map((row) => [row.id, row.name])],
      }),
    ),
    selected
      ? h(
          "div",
          { key: selected.id, className: "workagent-market-fields" },
          h(
            Field,
            { label: "市场名称" },
            h(Input, {
              name: "name",
              required: true,
              maxLength: 240,
              defaultValue: entry?.name || selected.name,
            }),
          ),
          h(
            Field,
            { label: "版本" },
            h(Input, {
              name: "version",
              required: true,
              pattern: "[0-9]+\\.[0-9]+\\.[0-9]+",
              defaultValue: entry?.version
                ? entry.version
                    .split(".")
                    .map((part, index) =>
                      index === 2 ? Number(part) + 1 : part,
                    )
                    .join(".")
                : "1.0.0",
            }),
          ),
          h(
            Field,
            { label: "说明" },
            h("textarea", {
              name: "description",
              required: true,
              maxLength: 4096,
              defaultValue: selected.description || "",
            }),
          ),
          h(
            Field,
            { label: "本版本更新说明" },
            h("textarea", {
              name: "releaseNotes",
              maxLength: 12000,
              required: true,
              placeholder: "说明新增能力、修复内容、兼容性及升级注意事项",
            }),
          ),
          kind === "assistant"
            ? h(
                "p",
                null,
                `将一并打包 ${selected.skillIds?.length || 0} 个技能及其依赖、${selected.mcpServerIds?.length || 0} 个直接绑定的 MCP。`,
              )
            : null,
        )
      : null,
    error
      ? h("p", { role: "alert", className: "workagent-error" }, error)
      : null,
    h(
      Button,
      { type: "submit", disabled: busy || !selected },
      busy ? "正在发布…" : "发布",
    ),
  );
}

export { MarketplaceSection };
