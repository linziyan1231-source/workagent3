import { useConfirm } from "../../ui/dialog.js";

export function createAutomations({
  React,
  request,
  apiRoot,
  useResource,
  usePresets,
  Section,
  Field,
  Input,
  Select,
  Button,
  Card,
  Status,
  friendlyError,
}) {
  const h = React.createElement;
  const endpoint = `${apiRoot}/automations`;
  const runLabels = {
    pending: "等待",
    running: "运行中",
    succeeded: "成功",
    failed: "失败",
    cancelled: "已取消",
  };
  function SkillSuggestion({ row, run, saved }) {
    const [text, setText] = React.useState(null);
    const [name, setName] = React.useState(`${row.name}执行流程`);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [ignored, setIgnored] = React.useState(false);
    const [installedId, setInstalledId] = React.useState(null);
    if (ignored || row.skillId) return null;
    return h(
      "section",
      {
        className: "workagent-skill-suggestion",
        "aria-label": "可复用技能建议",
      },
      h("strong", null, "本次执行生成了技能建议"),
      h(
        Button,
        {
          disabled: busy,
          onClick: async () => {
            setBusy(true);
            setError("");
            try {
              setText(
                await request(
                  `${apiRoot}/workspaces/${encodeURIComponent(run.definitionSnapshot.workspaceId)}/content?path=${encodeURIComponent(run.skillSuggestionPath)}`,
                ),
              );
            } catch (reason) {
              setError(friendlyError(reason.message));
            } finally {
              setBusy(false);
            }
          },
        },
        "预览技能建议",
      ),
      h(
        Button,
        { disabled: busy, onClick: () => setIgnored(true) },
        "忽略建议",
      ),
      text !== null
        ? h(
            "form",
            {
              className: "workagent-form",
              onSubmit: async (event) => {
                event.preventDefault();
                setBusy(true);
                setError("");
                try {
                  let skillId = installedId;
                  if (!skillId) {
                    const data = new FormData();
                    data.set("name", name);
                    data.set(
                      "description",
                      `来自定时任务 ${row.name} 的执行流程`,
                    );
                    data.set("format", "directory");
                    data.set("paths", JSON.stringify(["SKILL.md"]));
                    data.append(
                      "files",
                      new File([text], "SKILL.md", { type: "text/markdown" }),
                    );
                    const response = await fetch(`${apiRoot}/imports/skill`, {
                      method: "POST",
                      credentials: "same-origin",
                      body: data,
                    });
                    const result = await response.json();
                    if (!response.ok || result.error || !result.resourceId)
                      throw new Error(result.error || "技能导入失败");
                    skillId = result.resourceId;
                    setInstalledId(skillId);
                  }
                  await request(`${endpoint}/${encodeURIComponent(row.id)}`, {
                    method: "PATCH",
                    body: JSON.stringify({ version: row.version, skillId }),
                  });
                  saved();
                } catch (reason) {
                  setError(friendlyError(reason.message));
                } finally {
                  setBusy(false);
                }
              },
            },
            h(
              "label",
              null,
              "建议技能名称",
              h(Input, {
                "aria-label": "建议技能名称",
                value: name,
                onChange: (event) => setName(event.target.value),
                required: true,
                maxLength: 120,
              }),
            ),
            h(
              "label",
              null,
              "建议技能内容",
              h("textarea", {
                "aria-label": "建议技能内容",
                value: text,
                onChange: (event) => setText(event.target.value),
                rows: 16,
                maxLength: 128 * 1024,
              }),
            ),
            h(
              "p",
              null,
              installedId
                ? "技能已保存；若任务版本冲突，请刷新任务后重新绑定。"
                : "请检查适用范围和执行步骤。保存后，下次运行会使用此技能。",
            ),
            h(Button, { type: "submit", disabled: busy }, "保存技能并绑定任务"),
          )
        : null,
      error ? h("p", { role: "alert" }, error) : null,
    );
  }
  function Editor({
    row,
    presets,
    skills,
    workspaces,
    sessions,
    notifications,
    saved,
    cancel,
  }) {
    const [kind, setKind] = React.useState(row?.schedule.kind || "interval");
    const [mode, setMode] = React.useState(
      row?.executionMode || "new_conversation",
    );
    const [presetId, setPresetId] = React.useState(row?.presetId || "");
    const [workspaceId, setWorkspaceId] = React.useState(
      row?.workspaceId || "",
    );
    const [messageNotificationEnabled, setMessageNotificationEnabled] =
      React.useState(row?.messageNotificationEnabled === true);
    const [error, setError] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const engine = presets.find((p) => p.id === presetId)?.engine;
    async function submit(event) {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const [hour, minute] = String(form.get("time") || "09:00")
        .split(":")
        .map(Number);
      const timezone = String(form.get("timezone") || "UTC");
      const schedule =
        kind === "interval"
          ? { kind, everyMinutes: Number(form.get("minutes")) }
          : kind === "weekly"
            ? {
                kind,
                daysOfWeek: form.getAll("days").map(Number),
                hour,
                minute,
                timezone,
              }
            : {
                kind,
                expression: String(form.get("expression")).trim(),
                timezone,
              };
      if (kind === "weekly" && !schedule.daysOfWeek.length)
        return setError("请选择至少一个执行日");
      const messageNotificationTargetId = String(
        form.get("messageNotificationTargetId") || "",
      );
      if (messageNotificationEnabled && !messageNotificationTargetId)
        return setError("请选择消息提醒的接收聊天");
      setBusy(true);
      setError("");
      try {
        await request(
          row ? `${endpoint}/${encodeURIComponent(row.id)}` : endpoint,
          {
            method: row ? "PATCH" : "POST",
            body: JSON.stringify({
              ...(row ? { version: row.version } : {}),
              name: String(form.get("name")).trim(),
              enabled: form.get("enabled") === "on",
              schedule,
              presetId,
              engine,
              workspaceId,
              input: String(form.get("input")),
              notificationPolicy: String(form.get("notificationPolicy")),
              messageNotificationEnabled,
              messageNotificationTargetId: messageNotificationEnabled
                ? messageNotificationTargetId
                : null,
              skillId: String(form.get("skillId") || "") || null,
              executionMode: mode,
              conversationId:
                mode === "existing" ? String(form.get("conversationId")) : null,
            }),
          },
        );
        saved();
      } catch (reason) {
        setError(friendlyError(reason.message));
      } finally {
        setBusy(false);
      }
    }
    const field = (label, child) => h(Field, { label }, child);
    return h(
      "form",
      {
        className: "workagent-form workagent-automation-form",
        onSubmit: submit,
      },
      h(
        "h3",
        { className: "workagent-automation-wide" },
        row ? "编辑定时任务" : "新建定时任务",
      ),
      field(
        "任务名称",
        h(Input, {
          name: "name",
          required: true,
          maxLength: 200,
          defaultValue: row?.name || "",
        }),
      ),
      field(
        "执行助手",
        h(Select, {
          name: "presetId",
          required: true,
          value: presetId,
          onChange: (e) => setPresetId(e.target.value),
          options: [
            ["", "选择一个助手"],
            ...presets
              .filter((p) => p.enabled || p.id === presetId)
              .map((p) => [p.id, p.name]),
          ],
        }),
      ),
      field(
        "所属项目",
        h(Select, {
          name: "workspaceId",
          required: true,
          value: workspaceId,
          onChange: (e) => setWorkspaceId(e.target.value),
          options: [
            ["", "选择一个项目"],
            ...workspaces.map((w) => [w.id, w.name]),
          ],
        }),
      ),
      field(
        "绑定技能",
        h(Select, {
          name: "skillId",
          defaultValue: row?.skillId || "",
          options: [
            ["", "不绑定，执行后可生成建议"],
            ...skills
              .filter((skill) => skill.enabled || skill.id === row?.skillId)
              .map((skill) => [skill.id, skill.name]),
          ],
        }),
      ),
      field(
        "任务内容",
        h("textarea", {
          name: "input",
          required: true,
          rows: 4,
          maxLength: 64000,
          defaultValue: row?.input || "",
        }),
      ),
      field(
        "执行频率",
        h(Select, {
          value: kind,
          onChange: (e) => setKind(e.target.value),
          options: [
            ["interval", "固定间隔"],
            ["weekly", "每周"],
            ["cron", "Cron 表达式"],
          ],
        }),
      ),
      kind === "interval"
        ? field(
            "执行间隔（分钟）",
            h(Input, {
              name: "minutes",
              type: "number",
              min: 1,
              max: 525600,
              required: true,
              defaultValue: row?.schedule.everyMinutes || 60,
            }),
          )
        : h(
            React.Fragment,
            null,
            field(
              "时区",
              h(Input, {
                name: "timezone",
                required: true,
                defaultValue:
                  row?.schedule.timezone ||
                  Intl.DateTimeFormat().resolvedOptions().timeZone ||
                  "UTC",
              }),
            ),
            kind === "cron"
              ? field(
                  "Cron 表达式",
                  h(Input, {
                    name: "expression",
                    required: true,
                    placeholder: "0 9 * * 1-5",
                    defaultValue: row?.schedule.expression || "",
                  }),
                )
              : h(
                  React.Fragment,
                  null,
                  h(
                    "fieldset",
                    null,
                    h("legend", null, "执行日"),
                    ...["日", "一", "二", "三", "四", "五", "六"].map(
                      (day, index) =>
                        h(
                          "label",
                          { key: day },
                          h("input", {
                            type: "checkbox",
                            name: "days",
                            value: index,
                            defaultChecked: (
                              row?.schedule.daysOfWeek || [1]
                            ).includes(index),
                          }),
                          `周${day}`,
                        ),
                    ),
                  ),
                  field(
                    "执行时间",
                    h(Input, {
                      type: "time",
                      name: "time",
                      required: true,
                      defaultValue: `${String(row?.schedule.hour ?? 9).padStart(2, "0")}:${String(row?.schedule.minute ?? 0).padStart(2, "0")}`,
                    }),
                  ),
                ),
          ),
      field(
        "执行方式",
        h(Select, {
          value: mode,
          onChange: (e) => setMode(e.target.value),
          options: [
            ["new_conversation", "每次新建对话"],
            ["existing", "继续已有对话"],
          ],
        }),
      ),
      mode === "existing"
        ? field(
            "继续的对话",
            h(Select, {
              name: "conversationId",
              required: true,
              defaultValue: row?.conversationId || "",
              options: [
                ["", "选择同项目、同引擎的对话"],
                ...sessions
                  .filter(
                    (s) =>
                      s.workspaceId === workspaceId &&
                      s.engine === engine &&
                      !s.parentSessionId,
                  )
                  .map((s) => [s.id, s.title || s.id]),
              ],
            }),
          )
        : null,
      field(
        "结果通知",
        h(Select, {
          name: "notificationPolicy",
          defaultValue: row?.notificationPolicy || "always",
          options: [
            ["always", "每次通知"],
            ["on_failure", "仅失败时通知"],
            ["none", "不通知"],
          ],
        }),
      ),
      h(
        "label",
        { className: "workagent-inline" },
        h("input", {
          name: "messageNotificationEnabled",
          type: "checkbox",
          checked: messageNotificationEnabled,
          onChange: (event) =>
            setMessageNotificationEnabled(event.target.checked),
        }),
        "开启消息提醒",
      ),
      messageNotificationEnabled
        ? field(
            "消息提醒到",
            h(Select, {
              name: "messageNotificationTargetId",
              required: true,
              defaultValue:
                row?.messageNotificationTargetId ||
                notifications?.targetId ||
                "",
              options: [
                ["", "选择接收聊天"],
                ...(notifications?.targets || [])
                  .filter((target) => target.connected)
                  .map((target) => [target.id, target.label]),
              ],
            }),
          )
        : null,
      messageNotificationEnabled && !(notifications?.targets || []).length
        ? h(
            "p",
            { className: "workagent-muted workagent-automation-wide" },
            "暂无可选聊天。请先到“消息渠道”连接账号，并在目标聊天中给机器人发送一条消息。",
          )
        : null,
      h(
        "label",
        null,
        h("input", {
          name: "enabled",
          type: "checkbox",
          defaultChecked: row?.enabled ?? true,
        }),
        "启用任务",
      ),
      error
        ? h("p", { role: "alert", className: "workagent-error" }, error)
        : null,
      h(
        "footer",
        { className: "workagent-automation-form-footer" },
        h(Button, { type: "button", onClick: cancel, disabled: busy }, "取消"),
        h(
          Button,
          {
            type: "submit",
            disabled: busy,
            className: "workagent-button workagent-automation-create",
          },
          busy ? "保存中…" : row ? "保存任务" : "创建任务",
        ),
      ),
    );
  }
  function Page() {
    const { confirm, confirmation } = useConfirm();
    const [state, refresh] = useResource(endpoint);
    const [presets] = usePresets();
    const [skills] = useResource(`${apiRoot}/skills`);
    const [workspaces] = useResource(`${apiRoot}/workspaces`);
    const [sessions] = useResource(`${apiRoot}/sessions`);
    const [notifications] = useResource(`${apiRoot}/completion-notifications`);
    const [editing, setEditing] = React.useState(undefined);
    const [editorRevision, setEditorRevision] = React.useState(0);
    const [history, setHistory] = React.useState({});
    const [error, setError] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    async function action(path, method, body) {
      setBusy(true);
      setError("");
      try {
        await request(path, {
          method,
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        refresh();
      } catch (reason) {
        setError(friendlyError(reason.message));
      } finally {
        setBusy(false);
      }
    }
    async function loadHistory(id) {
      try {
        const rows = await request(
          `${endpoint}/${encodeURIComponent(id)}/runs`,
        );
        setHistory((current) => ({ ...current, [id]: rows }));
      } catch (reason) {
        setError(friendlyError(reason.message));
      }
    }
    return h(
      Section,
      { title: "定时任务" },
      confirmation,
      h(
        "header",
        { className: "workagent-automation-intro" },
        h(
          "div",
          null,
          h("h3", null, "让日常工作，自动进行"),
          h("p", null, "按间隔、每周或 Cron 执行，可持续使用同一对话。"),
        ),
      ),
      editing !== null
        ? h(Editor, {
            key: editing?.id || `new-${editorRevision}`,
            row: editing,
            presets: presets.rows,
            skills: skills.rows,
            workspaces: workspaces.rows,
            sessions: sessions.rows,
            notifications: notifications.rows[0],
            saved: () => {
              refresh();
              setEditing(editing ? null : undefined);
              setEditorRevision((value) => value + 1);
            },
            cancel: () => setEditing(null),
          })
        : h(
            Button,
            {
              className:
                "workagent-button workagent-automation-create workagent-automation-new",
              onClick: () => setEditing(undefined),
            },
            "新建定时任务",
          ),
      h(Status, { state }),
      error
        ? h("p", { role: "alert", className: "workagent-error" }, error)
        : null,
      ...state.rows.map((row) =>
        h(
          Card,
          {
            key: row.id,
            className: "workagent-automation-card",
            "data-enabled": row.enabled,
            title: row.name,
            detail: h(
              React.Fragment,
              null,
              h(
                "span",
                { className: "workagent-automation-state" },
                row.enabled ? "已启用" : "已暂停",
              ),
              h(
                "span",
                null,
                row.nextRunAt
                  ? `下次运行 ${new Date(row.nextRunAt).toLocaleString()}`
                  : "暂无下次运行时间",
              ),
            ),
          },
          h(
            Button,
            { disabled: busy, onClick: () => setEditing(row) },
            "编辑任务",
          ),
          h(
            Button,
            {
              disabled: busy,
              className: "workagent-button workagent-automation-toggle",
              onClick: () =>
                action(`${endpoint}/${encodeURIComponent(row.id)}`, "PATCH", {
                  version: row.version,
                  enabled: !row.enabled,
                }),
            },
            row.enabled ? "暂停" : "启用",
          ),
          h(
            Button,
            {
              disabled: busy,
              className: "workagent-button workagent-automation-run",
              onClick: async () => {
                await action(
                  `${endpoint}/${encodeURIComponent(row.id)}/run`,
                  "POST",
                );
                await loadHistory(row.id);
              },
            },
            "立即运行",
          ),
          h(
            Button,
            {
              className: "workagent-button workagent-automation-history",
              onClick: () => loadHistory(row.id),
            },
            "运行记录",
          ),
          h(
            Button,
            {
              disabled: busy,
              className: "workagent-button workagent-automation-delete",
              onClick: async () => {
                if (
                  await confirm({
                    description: `删除定时任务“${row.name}”？`,
                    danger: true,
                    confirmLabel: "删除任务",
                  })
                )
                  action(`${endpoint}/${encodeURIComponent(row.id)}`, "DELETE");
              },
            },
            "删除",
          ),
          history[row.id]
            ? h(
                "div",
                { className: "workagent-run-history" },
                history[row.id].length
                  ? history[row.id].map((run) =>
                      h(
                        "article",
                        { key: run.id },
                        h("strong", null, runLabels[run.status] || run.status),
                        " · ",
                        new Date(run.createdAt).toLocaleString(),
                        run.sessionId
                          ? h(
                              "a",
                              {
                                href: `/?frontend=dsh&session=${encodeURIComponent(run.sessionId)}`,
                              },
                              "打开执行对话",
                            )
                          : null,
                        run.error
                          ? h(
                              "p",
                              { className: "workagent-error" },
                              friendlyError(run.error),
                            )
                          : null,
                        run.result
                          ? h(
                              "details",
                              null,
                              h("summary", null, "执行结果"),
                              h("pre", null, run.result),
                            )
                          : null,
                        run.skillSuggestionPath
                          ? h(SkillSuggestion, { row, run, saved: refresh })
                          : null,
                        ["pending", "running"].includes(run.status)
                          ? h(
                              Button,
                              {
                                disabled: busy,
                                onClick: async () => {
                                  await action(
                                    `${endpoint}/${encodeURIComponent(row.id)}/runs/${encodeURIComponent(run.id)}/cancel`,
                                    "POST",
                                  );
                                  await loadHistory(row.id);
                                },
                              },
                              "取消执行",
                            )
                          : null,
                      ),
                    )
                  : h("p", null, "暂无运行记录"),
              )
            : null,
        ),
      ),
    );
  }
  return Page;
}
