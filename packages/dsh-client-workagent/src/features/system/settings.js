import { apiRoot, mutate, request } from "../../platform/api.js";
import { useResource } from "../../platform/resources.js";
import { Button, Field, Input, Section } from "../../ui/elements.js";
import { Icon } from "../../ui/icons.js";
import { friendlyError } from "../../ui/labels.js";
import React from "react";
import { useConfirm } from "../../ui/dialog.js";
import { createElement as h } from "react";

const CHAT_PAGE_KEY = "workagent.chat-page-url";

function ChatPageSettings() {
  const [address, setAddress] = React.useState(
    () => localStorage.getItem(CHAT_PAGE_KEY) || "",
  );
  const [notice, setNotice] = React.useState("");
  const [error, setError] = React.useState("");
  const save = (event) => {
    event.preventDefault();
    setNotice("");
    setError("");
    try {
      const value = address.trim();
      if (value) {
        if (!value.startsWith("/") && !/^https?:\/\//i.test(value))
          throw new Error("请填写以 HTTP、HTTPS 或 / 开头的聊天网页地址。");
        const url = new URL(value, location.origin);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password)
          throw new Error(
            "请填写 HTTP 或 HTTPS 网页地址，不要在地址中包含账号密码。",
          );
        localStorage.setItem(CHAT_PAGE_KEY, url.href);
      } else localStorage.removeItem(CHAT_PAGE_KEY);
      setNotice("已保存，点击侧栏的聊天模式即可打开。");
    } catch (reason) {
      setError(
        reason instanceof TypeError
          ? "请输入有效的聊天网页地址。"
          : reason.message,
      );
    }
  };
  return h(
    React.Fragment,
    null,
    h("h3", null, "聊天模式"),
    h(
      "p",
      null,
      "填写独立聊天网页的完整地址，例如旧版 WorkAgent 的 /chatgpt/ 地址。留空使用本站入口。此设置仅保存在当前浏览器。",
    ),
    h(
      "form",
      { className: "workagent-form", onSubmit: save },
      h(
        Field,
        { label: "聊天网页地址" },
        h(Input, {
          "aria-label": "聊天网页地址",
          value: address,
          placeholder: "/chatgpt/",
          onChange: (event) => {
            setAddress(event.target.value);
            setNotice("");
            setError("");
          },
        }),
      ),
      h(
        Button,
        { type: "submit", style: { alignSelf: "end" } },
        "保存聊天地址",
      ),
    ),
    error ? h("p", { role: "alert" }, error) : null,
    notice ? h("p", { role: "status" }, notice) : null,
  );
}

function SystemSettings() {
  const { confirm, confirmation } = useConfirm();
  const [storage, refreshStorage] = useResource(
    "/api/system/storage",
    (value) => [value],
  );
  const [status, refreshStatus] = useResource("/api/system/status", (value) => [
    value,
  ]);
  const [preferences, refreshPreferences] = useResource(
    `${apiRoot}/runtime-settings`,
    (value) => [value],
  );
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return h(
    Section,
    { title: "系统与帮助" },
    confirmation,
    h(ChatPageSettings),
    h(
      "div",
      { className: "workagent-settings-heading" },
      h("h3", null, "存储空间"),
      h(
        Button,
        {
          onClick: refreshStorage,
          "aria-label": "刷新磁盘用量",
          title: "刷新磁盘用量",
        },
        h(Icon, { name: "refresh", size: 16 }),
      ),
    ),
    storage.error
      ? h("p", { role: "alert" }, "暂时无法读取磁盘配额，请刷新或联系管理员。")
      : null,
    h(
      "div",
      { className: "workagent-storage-grid" },
      ...["personal", "shared"].map((kind) => {
        const quota = storage.rows[0]?.[kind];
        return h(
          "article",
          { key: kind, className: "workagent-storage-card" },
          h(Icon, {
            name: kind === "personal" ? "workspace" : "shared",
            size: 20,
          }),
          h("span", null, kind === "personal" ? "个人空间" : "共享空间"),
          h(
            "strong",
            null,
            quota ? (quota.usedBytes / 1024 ** 3).toFixed(2) + " GiB" : "—",
          ),
          h(
            "small",
            null,
            quota?.enabled
              ? "共 " + (quota.limitBytes / 1024 ** 3).toFixed(2) + " GiB"
              : "尚未配置配额",
          ),
          quota?.enabled
            ? h("progress", {
                max: quota.limitBytes || 1,
                value: quota.usedBytes,
                "aria-label":
                  kind === "personal" ? "个人空间用量" : "共享空间用量",
              })
            : null,
        );
      }),
    ),
    h(
      "div",
      { className: "workagent-settings-heading" },
      h("h3", null, "运行状态"),
      h(
        Button,
        {
          onClick: refreshStatus,
          "aria-label": "刷新运行状态",
          title: "刷新运行状态",
        },
        h(Icon, { name: "refresh", size: 16 }),
      ),
    ),
    h(
      "div",
      { className: "workagent-system-status" },
      ...(status.rows[0]?.components || []).map((row) =>
        h(
          "div",
          { key: row.id },
          h(
            "span",
            null,
            {
              portal: "平台",
              notifications: "消息提醒",
              audit: "活动记录",
              userhost: "员工服务",
              harness: "任务运行环境",
            }[row.id] || row.id,
          ),
          h(
            "span",
            {
              className: "workagent-status-label",
              "data-status": row.status,
            },
            h("i", { "aria-hidden": true }),
            {
              healthy: "正常",
              unavailable: "暂不可用",
              unhealthy: "异常",
              disabled: "未启用",
              unknown: "待确认",
            }[row.status] || row.status,
          ),
        ),
      ),
    ),
    h("a", { href: "/api/system/diagnostics", download: true }, "下载诊断报告"),
    h(
      Button,
      {
        disabled: busy,
        onClick: async () => {
          if (
            !(await confirm(
              "重启当前员工的任务运行环境？正在执行的工作会中断。",
            ))
          )
            return;
          setBusy(true);
          setError("");
          try {
            await request("/api/system/runtime/restart", {
              method: "POST",
            });
            setNotice("已提交重启，请稍后刷新运行状态。");
          } catch (reason) {
            setError(friendlyError(reason.message));
          } finally {
            setBusy(false);
          }
        },
      },
      "重启运行环境",
    ),
    preferences.rows[0]
      ? h(
          "form",
          {
            className: "workagent-form",
            key: preferences.rows[0].turnTimeoutSeconds,
            onSubmit: async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              setBusy(true);
              setError("");
              const ok = await mutate(
                refreshPreferences,
                setError,
                `${apiRoot}/runtime-settings`,
                "PUT",
                { turnTimeoutSeconds: Number(form.get("timeout")) },
              );
              setBusy(false);
              if (ok) setNotice("已保存，从下一轮任务开始生效。");
            },
          },
          h(
            Field,
            { label: "任务时限（秒）" },
            h(Input, {
              name: "timeout",
              type: "number",
              min: 0,
              max: 86400,
              required: true,
              defaultValue: preferences.rows[0].turnTimeoutSeconds,
            }),
          ),
          h(
            "p",
            null,
            "0 表示不限制。时限包含等待确认的时间；达到时限后停止当前轮任务，适用于网页、团队、定时和消息渠道任务。",
          ),
          h(Button, { type: "submit", disabled: busy }, "保存运行设置"),
        )
      : null,
    error || status.error || preferences.error
      ? h(
          "p",
          { role: "alert" },
          friendlyError(error || status.error || preferences.error),
        )
      : null,
    notice ? h("p", { role: "status" }, notice) : null,
    h("h3", null, "使用帮助"),
    h(
      "p",
      null,
      "在项目中创建对话，使用附件或 @ 文件引用资料。Shift + Enter 换行，Alt + ↑/↓ 找回历史输入，/ 打开命令与技能菜单。",
    ),
    h(
      "p",
      null,
      "文件上传中断后，在文件栏的未完成上传中重新选择原文件继续。编辑冲突时保留你的草稿，重新打开文件核对后再保存。",
    ),
    h(
      "p",
      null,
      "任务需要确认时可允许本次、拒绝或停止。开启桌面提醒后，后台完成和待确认时会提醒；浏览器需要授予通知权限。",
    ),
  );
}

export { CHAT_PAGE_KEY, SystemSettings };
