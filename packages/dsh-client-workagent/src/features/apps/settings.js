import { mutate } from "../../platform/api.js";
import { useResource } from "../../platform/resources.js";
import { Button, Card, Section, Status } from "../../ui/elements.js";
import { useConfirm } from "../../ui/dialog.js";
import React from "react";
import { createElement as h } from "react";

const endpoint = "/api/portal/apps";

const accessLabels = {
  owner: "仅自己",
  members: "指定成员",
  authenticated: "WorkAgent 登录用户",
  token: "持有链接的人",
  password: "持有访问密码的人",
  public: "公开免登录",
};

function expiryLabel(row) {
  const at = row.expiresAt && !row.expiresAt.startsWith("0001-") ? new Date(row.expiresAt) : null;
  if (!at) return "长期有效";
  if (at.getTime() <= Date.now()) return `已于 ${at.toLocaleString("zh-CN")} 过期`;
  return `有效期至 ${at.toLocaleString("zh-CN")}`;
}

function stateLabel(row) {
  if (!row.enabled) return "已停用";
  if (expiryLabel(row).startsWith("已于")) return "已过期";
  return "运行中";
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the legacy path when the async clipboard is blocked.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function PublishedAppsSection() {
  const [state, refresh] = useResource(endpoint, (value) => value.items || []);
  const [error, setError] = React.useState("");
  const [copied, setCopied] = React.useState("");
  const { confirm, confirmation } = useConfirm();
  const copy = async (text, key) => {
    await copyText(text);
    setCopied(key);
    setTimeout(() => setCopied((current) => (current === key ? "" : current)), 2000);
  };
  return h(
    Section,
    { title: "网页发布" },
    h(
      "p",
      { className: "workagent-muted" },
      "在对话中让助手发布网页，无需填写技术参数；这里查看、启停或删除已发布的网页。过期的网页会自动停止访问，启用时会顺延 5 天有效期。",
    ),
    error ? h("p", { role: "alert", className: "workagent-error" }, error) : null,
    h(Status, { state }),
    ...state.rows.map((row) =>
      h(
        Card,
        {
          key: row.id,
          title: row.name,
          detail: `${stateLabel(row)} · ${accessLabels[row.access] || row.access} · ${expiryLabel(row)}`,
        },
        h(
          Button,
          { onClick: () => copy(row.shareUrl || row.url, row.id) },
          copied === row.id ? "已复制" : "复制链接",
        ),
        row.access === "password" && row.accessCode
          ? h(
              Button,
              { onClick: () => copy(row.accessCode, row.id + "-code") },
              copied === row.id + "-code" ? "已复制" : "复制访问密码",
            )
          : null,
        h(
          Button,
          {
            onClick: () =>
              mutate(
                refresh,
                setError,
                `${endpoint}/${encodeURIComponent(row.id)}/${row.enabled ? "unpublish" : "enable"}`,
                "POST",
              ),
          },
          row.enabled ? "停用" : "启用",
        ),
        h(
          Button,
          {
            variant: "danger",
            onClick: async () => {
              const ok = await confirm({
                title: "删除网页",
                description: `删除后「${row.name}」的链接将立即失效，且无法恢复。`,
                danger: true,
                confirmLabel: "删除",
              });
              if (ok)
                await mutate(
                  refresh,
                  setError,
                  `${endpoint}/${encodeURIComponent(row.id)}/delete`,
                  "POST",
                );
            },
          },
          "删除",
        ),
      ),
    ),
    confirmation,
  );
}

export { PublishedAppsSection };
