import { workbench } from "../content/index.js";
import { navigation } from "../../host/navigation.js";
import { apiRoot, request } from "../../platform/api.js";
import { useResource } from "../../platform/resources.js";
import {
  Button,
  Card,
  Field,
  Section,
  Status,
  Switch,
} from "../../ui/elements.js";
import { Icon } from "../../ui/icons.js";
import React from "react";
import { createElement as h } from "react";

function CompletionNotificationSettings() {
  const routeSearch = navigation.useSearch();
  const endpoint = `${apiRoot}/completion-notifications`;
  const [state, refresh] = useResource(endpoint);
  const saved = state.rows[0];
  const [draft, setDraft] = React.useState(null);
  const [error, setError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState("");
  React.useEffect(() => {
    if (saved)
      setDraft({
        enabled: saved.enabled,
        targetId: saved.targetId,
        attachFiles: saved.attachFiles === true,
      });
  }, [saved]);
  const update = (values) => {
    setNotice("");
    setDraft((current) => ({ ...current, ...values }));
  };
  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await request(endpoint, {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      await refresh();
      setNotice("提醒设置已保存");
    } catch (error) {
      setError(error.message);
    } finally {
      setSaving(false);
    }
  };
  const retry = async (id) => {
    setSaving(true);
    setError("");
    try {
      await request(`${endpoint}/retry`, {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      await refresh();
    } catch (error) {
      setError(error.message);
    } finally {
      setSaving(false);
    }
  };
  return h(
    Section,
    { title: "消息提醒" },
    h(workbench.Notifications),
    new URLSearchParams(routeSearch).get("session")
      ? h(workbench.SessionReminder, {
          sessionId: new URLSearchParams(routeSearch).get("session"),
        })
      : null,
    h(
      "p",
      { className: "workagent-muted" },
      "开启后，网页对话和定时任务完成时，会把最终回复和产物下载链接推送到选定的 IM 聊天。渠道内的对话仍在原聊天回复，不重复提醒。",
    ),
    h(Status, { state }),
    draft &&
      h(
        "form",
        {
          className: "workagent-form workagent-completion-form",
          onSubmit: save,
        },
        h(
          "label",
          { className: "workagent-inline" },
          h(Switch, {
            "aria-label": "任务完成提醒",
            checked: draft.enabled,
            onChange: (enabled) => update({ enabled }),
          }),
          "任务完成提醒",
        ),
        h(
          "label",
          null,
          h("input", {
            type: "checkbox",
            checked: draft.attachFiles,
            onChange: (event) => update({ attachFiles: event.target.checked }),
          }),
          "同时发送产物文件（支持文件的渠道，单个不超过 50 MiB）",
        ),
        h(
          Field,
          { label: "接收聊天" },
          h(
            "select",
            {
              "aria-label": "接收聊天",
              value: draft.targetId,
              onChange: (event) => update({ targetId: event.target.value }),
            },
            h("option", { value: "" }, "请选择接收聊天"),
            ...(saved?.targets || []).map((target) =>
              h(
                "option",
                {
                  key: target.id,
                  value: target.id,
                  disabled: !target.connected,
                },
                `${target.label}${target.connected ? "" : "（未连接）"}`,
              ),
            ),
            draft.targetId &&
              !(saved?.targets || []).some(
                (target) => target.id === draft.targetId,
              )
              ? h(
                  "option",
                  { value: draft.targetId },
                  "原接收聊天已不可用，请重新选择",
                )
              : null,
          ),
        ),
        !(saved?.targets || []).length &&
          h(
            "p",
            { className: "workagent-muted" },
            "请先在“消息渠道”连接账号，并在接收聊天中给机器人发送一条消息，再刷新聊天列表。",
          ),
        h(Button, { type: "button", onClick: refresh }, "刷新聊天列表"),
        h(
          "p",
          { className: "workagent-muted" },
          "产物链接需要登录当前 WorkAgent 账号后下载。",
        ),
        h(
          Button,
          { type: "submit", disabled: saving },
          saving ? "保存中…" : "保存提醒设置",
        ),
        error && h("p", { role: "alert", className: "workagent-error" }, error),
        notice && h("p", { role: "status" }, notice),
      ),
    h("h3", null, "最近推送"),
    h(Button, { type: "button", onClick: refresh }, "刷新推送记录"),
    !(saved?.deliveries || []).length &&
      h("p", { className: "workagent-muted" }, "暂无推送记录"),
    ...(saved?.deliveries || []).map((delivery) =>
      h(
        "div",
        { key: delivery.id, className: "workagent-card" },
        h("strong", null, delivery.title),
        h(
          "p",
          null,
          `${delivery.targetLabel} · ${{ pending: "等待发送", sending: "发送中", sent: "已发送", failed: "发送失败", cancelled: "已取消" }[delivery.status]}`,
        ),
        delivery.error &&
          h("p", { className: "workagent-error" }, delivery.error),
        delivery.status === "failed" &&
          h(
            Button,
            {
              disabled: saving || !draft?.enabled,
              onClick: () => retry(delivery.id),
            },
            "重试推送",
          ),
      ),
    ),
  );
}

function NotificationsPage() {
  const endpoint = "/api/portal/me/notifications";
  const [state, refresh] = useResource(
    endpoint,
    (value) => value.notifications || [],
  );
  const [error, setError] = React.useState("");
  const unread = state.rows.filter((row) => !row.read_at).length;
  const open = async (row) => {
    try {
      if (!row.read_at)
        await request(`${endpoint}/${encodeURIComponent(row.id)}/read`, {
          method: "POST",
        });
      await request(`${endpoint}/${encodeURIComponent(row.id)}/acknowledge`, {
        method: "POST",
      });
      await refresh();
      if (row.deep_link) navigation.navigate(row.deep_link);
    } catch (reason) {
      setError(reason.message);
    }
  };
  return h(
    Section,
    { title: "通知" },
    h("p", { className: "workagent-muted" }, `未读 ${unread} 条`),
    error
      ? h("p", { role: "alert", className: "workagent-error" }, error)
      : null,
    h(Status, { state }),
    ...state.rows.map((row) =>
      h(
        Card,
        { key: row.id, title: row.title || row.kind, detail: row.message },
        h(
          Button,
          { onClick: () => open(row) },
          row.deep_link ? "打开并标记已读" : "标记已读",
        ),
      ),
    ),
  );
}

function TopNotificationButton() {
  const [state] = useResource(
    "/api/portal/me/notifications",
    (value) => value.notifications || [],
  );
  const unread = state.rows.filter((row) => !row.read_at).length;
  return h(
    "button",
    {
      type: "button",
      className: "workagent-top-notifications",
      title: "通知",
      "aria-label": unread ? `通知，${unread} 条未读` : "通知",
      onClick: () => navigation.toggleNotifications(),
    },
    h(Icon, { name: "notifications", size: 19 }),
    unread ? h("span", { className: "workagent-badge" }, unread) : null,
  );
}

function NotificationFooter({ wide }) {
  const [state] = useResource(
    "/api/portal/me/notifications",
    (value) => value.notifications || [],
  );
  const unread = state.rows.filter((row) => !row.read_at).length;
  return h(
    "button",
    {
      type: "button",
      className: "workagent-footer",
      "data-kind": "notifications",
      title: "通知",
      "aria-label": "通知",
      onClick: () => navigation.toggleNotifications(),
    },
    h(Icon, { name: "notifications" }),
    wide ? h("span", null, "通知") : null,
    unread > 0 ? h("span", { className: "workagent-badge" }, unread) : null,
  );
}

export {
  CompletionNotificationSettings,
  NotificationsPage,
  TopNotificationButton,
  NotificationFooter,
};
