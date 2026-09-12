import { createImports } from "./imports.js";
import { apiRoot, mutate, request } from "../../platform/api.js";
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
import { displayValue, friendlyError } from "../../ui/labels.js";
import React from "react";
import { createElement as h } from "react";

function CapabilitySync({ kind, onSynced }) {
  const [state, refresh] = useResource(
    `${apiRoot}/capability-sync/status`,
    (value) => [
      ...(value.items || []),
      ...(value.error
        ? [
            {
              key: "sync-error",
              kind,
              status: "unavailable",
              name: "全局同步",
              reason: value.error,
            },
          ]
        : []),
    ],
  );
  React.useEffect(() => {
    const timer = setInterval(() => {
      refresh();
      onSynced();
    }, 5000);
    return () => clearInterval(timer);
  }, [refresh, onSynced]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const sync = async () => {
    setBusy(true);
    setError("");
    try {
      await request(`${apiRoot}/capability-sync/run`, { method: "POST" });
      refresh();
      onSynced();
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  };
  const problems = state.rows.filter(
    (row) =>
      row.kind === kind && ["unavailable", "conflict"].includes(row.status),
  );
  return h(
    "div",
    { className: "workagent-capability-sync" },
    h(
      "p",
      { className: "workagent-muted" },
      "自动发现本账号的全局安装，供兼容助手使用；项目安装仍留在项目。启停和同步对新会话生效。",
    ),
    h(
      Button,
      { onClick: sync, disabled: busy },
      busy ? "正在同步…" : "检查新安装",
    ),
    error ? h("p", { role: "alert" }, error) : null,
    ...problems.map((row) =>
      h(
        "p",
        { key: row.key, role: "status" },
        `${row.name}：${row.status === "conflict" ? "存在冲突，请检查原安装与设置" : "暂不可共享"}（${row.reason}）`,
      ),
    ),
  );
}

function MCPSection() {
  const endpoint = `${apiRoot}/mcp-servers`;
  const [state, refresh] = useResource(endpoint);
  const [error, setError] = React.useState("");
  const [transport, setTransport] = React.useState("http");
  const submit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const target = String(values.get("target") || "").trim();
    const body = {
      name: String(values.get("name") || "").trim(),
      source: "user",
      enabled: true,
      transport:
        transport === "stdio"
          ? {
              kind: "stdio",
              command: target,
              args: [],
              environmentCredentialIds: {},
            }
          : { kind: transport, url: target, headerCredentialIds: {} },
      toolPolicy: "all",
      allowedTools: [],
      oauthState: "none",
    };
    await mutate(refresh, setError, endpoint, "POST", body);
    form.reset();
  };
  const oauth = async (row) => {
    try {
      const value = await request(
        `${endpoint}/${encodeURIComponent(row.id)}/oauth/start`,
        {
          method: "POST",
          body: JSON.stringify({
            redirectUri: `${location.origin}/oauth/mcp/callback`,
          }),
        },
      );
      sessionStorage.setItem(
        "workagent.mcp.oauth",
        JSON.stringify({ id: row.id, ...value }),
      );
      location.assign(value.authorizationUrl);
    } catch (reason) {
      setError(reason.message);
    }
  };
  return h(
    Section,
    { title: "MCP 服务" },
    h(CapabilitySync, { kind: "mcp", onSynced: refresh }),
    h(imports.MCPImport, { onImported: refresh }),
    h(
      "form",
      { className: "workagent-form", onSubmit: submit },
      h(Field, { label: "名称" }, h(Input, { name: "name", required: true })),
      h(
        Field,
        { label: "连接方式" },
        h(Select, {
          value: transport,
          onChange: (e) => setTransport(e.target.value),
          options: [
            ["http", "HTTP"],
            ["sse", "SSE"],
            ["stdio", "命令行"],
          ],
        }),
      ),
      h(
        Field,
        { label: transport === "stdio" ? "命令" : "服务地址" },
        h(Input, {
          name: "target",
          required: true,
          type: transport === "stdio" ? "text" : "url",
        }),
      ),
      h(
        "button",
        { className: "workagent-button", type: "submit" },
        "添加服务",
      ),
    ),
    error
      ? h("p", { role: "alert", className: "workagent-error" }, error)
      : null,
    h(Status, { state }),
    ...state.rows.map((row) =>
      h(
        Card,
        {
          key: row.id,
          title: row.name,
          detail: `${row.transport?.globalSource ? "Codex 全局安装 · " : ""}${displayValue(row.health, "未知状态")} · ${displayValue(row.oauthState, "无需授权")}`,
        },
        row.source === "user"
          ? h(
              Button,
              {
                onClick: () =>
                  mutate(
                    refresh,
                    setError,
                    `${endpoint}/${encodeURIComponent(row.id)}`,
                    "PATCH",
                    { enabled: !row.enabled },
                  ),
              },
              row.enabled ? "停用" : "启用",
            )
          : null,
        row.oauthState === "needs_auth"
          ? h(Button, { onClick: () => oauth(row) }, "授权")
          : null,
        h(
          Button,
          {
            onClick: () =>
              mutate(
                refresh,
                setError,
                `${endpoint}/${encodeURIComponent(row.id)}/test`,
                "POST",
              ),
          },
          "测试连接",
        ),
        row.source === "user"
          ? h(
              Button,
              {
                onClick: () =>
                  mutate(
                    refresh,
                    setError,
                    `${endpoint}/${encodeURIComponent(row.id)}`,
                    "DELETE",
                  ),
              },
              "删除",
            )
          : null,
      ),
    ),
  );
}

function SkillsSection() {
  const endpoint = apiRoot + "/skills";
  const [state, refresh] = useResource(endpoint);
  const [error, setError] = React.useState("");
  return h(
    Section,
    { title: "技能" },
    h(CapabilitySync, { kind: "skill", onSynced: refresh }),
    h(imports.SkillImport, { onImported: refresh }),
    h(
      "p",
      { className: "workagent-muted" },
      "管理已安装的技能；更多能力可在市场中获取。",
    ),
    error ? h("p", { role: "alert" }, error) : null,
    h(Status, { state }),
    ...state.rows.map((row) =>
      h(
        Card,
        {
          key: row.id,
          title: row.name,
          detail:
            (row.referenceDirectory
              ? `全局目录共享（${(row.compatibleEngines || ["codex", "kimi", "harness"]).map((engine) => ({ codex: "Codex", kimi: "Kimi", harness: "DSH" })[engine]).join("、")}）`
              : displayValue(row.source)) +
            " · " +
            displayValue(row.enabled ? row.health || "ready" : "disabled"),
        },
        ["user", "market"].includes(row.source)
          ? h(
              Button,
              {
                onClick: () =>
                  mutate(
                    refresh,
                    setError,
                    endpoint + "/" + encodeURIComponent(row.id),
                    "PATCH",
                    { enabled: !row.enabled },
                  ),
              },
              row.enabled ? "停用" : "启用",
            )
          : null,
      ),
    ),
  );
}

const imports = createImports({
  React,
  request,
  apiRoot,
  Field,
  Input,
  Button,
  friendlyError,
  useResource,
});

export { MCPSection, SkillsSection };
