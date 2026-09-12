import React, { createElement as h } from "react";
import { apiRoot, request } from "../../platform/api.js";
import { useResource } from "../../platform/resources.js";
import { Button, Field, Input, Status } from "../../ui/elements.js";

export const useAcpCatalog = () =>
  useResource(`${apiRoot}/acp-catalog`, (value) => {
    if (
      !value ||
      !Array.isArray(value.entries) ||
      value.entries.some(
        (entry) =>
          !entry ||
          typeof entry.id !== "string" ||
          typeof entry.label !== "string" ||
          !Array.isArray(entry.credentialFields),
      )
    )
      throw new Error("引擎目录格式不正确，请刷新后重试。");
    return value.entries;
  });

function AcpCredentialsRow({ entry, refresh }) {
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const save = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(
      [...new FormData(form)].filter(([, value]) => value !== ""),
    );
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await request(
        `${apiRoot}/acp-catalog/${encodeURIComponent(entry.id)}/credentials`,
        { method: "PUT", body: JSON.stringify({ values }) },
      );
      form.reset();
      await refresh();
      setNotice(
        "连接信息已保存，将在引擎下次启动时使用。已有连接可在系统设置中重启运行环境。",
      );
    } catch (reason) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  };
  return h(
    "article",
    { className: "workagent-card" },
    h("strong", null, entry.label),
    h(
      "p",
      null,
      `${entry.enabled ? (entry.ready ? "可连接" : "需要填写连接信息") : "管理员已停用"} · 版本 ${entry.revision}`,
    ),
    h(
      "form",
      { className: "workagent-form", onSubmit: save },
      ...entry.credentialFields.map((field) =>
        h(
          Field,
          {
            key: field.id,
            label: `${field.label}${field.required ? "（必填）" : ""}`,
          },
          h(Input, {
            name: field.id,
            type: "password",
            autoComplete: "new-password",
            placeholder: field.configured ? "已保存，留空保持" : "尚未填写",
            required: field.required && !field.configured,
            disabled: !entry.enabled,
          }),
          field.configured
            ? h(
                Button,
                {
                  disabled: busy || !entry.enabled,
                  onClick: async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await request(
                        `${apiRoot}/acp-catalog/${encodeURIComponent(entry.id)}/credentials`,
                        {
                          method: "PUT",
                          body: JSON.stringify({ values: { [field.id]: "" } }),
                        },
                      );
                      await refresh();
                    } catch (reason) {
                      setError(reason.message);
                    } finally {
                      setBusy(false);
                    }
                  },
                },
                "清除",
              )
            : null,
        ),
      ),
      entry.credentialFields.length
        ? h(
            "button",
            {
              type: "submit",
              className: "workagent-button",
              disabled: busy || !entry.enabled,
            },
            "保存连接信息",
          )
        : null,
    ),
    error
      ? h("p", { role: "alert" }, error)
      : notice
        ? h("p", { role: "status" }, notice)
        : null,
  );
}

export function AcpCredentials() {
  const [state, refresh] = useAcpCatalog();
  return h(
    "details",
    null,
    h("summary", null, "管理员提供的 ACP 引擎"),
    h(
      "p",
      null,
      "选择管理员提供的引擎，并填写自己的连接信息。连接信息仅保存在个人凭据库。",
    ),
    h(Status, { state }),
    ...state.rows.map((entry) =>
      h(AcpCredentialsRow, { key: entry.id, entry, refresh }),
    ),
    !state.loading && !state.error && !state.rows.length
      ? h("p", null, "管理员尚未提供 ACP 引擎。")
      : null,
  );
}
