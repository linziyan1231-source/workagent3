import { usePresets } from "../agents/api.js";
import { Markdown } from "../content/index.js";
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
import { useConfirm } from "../../ui/dialog.js";
import { createElement as h } from "react";

function TeamsPage() {
  const { confirm, confirmation } = useConfirm();
  const endpoint = `${apiRoot}/teams`;
  const [state, refresh] = useResource(endpoint);
  const [presets] = usePresets();
  const [workspaces] = useResource(`${apiRoot}/workspaces`);
  const [sessions] = useResource(`${apiRoot}/sessions`);
  const [details, setDetails] = React.useState({});
  const [selectedTeam, setSelectedTeam] = React.useState(null);
  const [teamAction, setTeamAction] = React.useState(null);
  const [teamActionValue, setTeamActionValue] = React.useState("");
  const [operationId, setOperationId] = React.useState("");
  const [memberEngine, setMemberEngine] = React.useState("codex");
  const [memberPresetId, setMemberPresetId] = React.useState("");
  const [targetMemberId, setTargetMemberId] = React.useState("");
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    if (!selectedTeam || typeof EventSource === "undefined") return;
    const source = new EventSource(
      `${endpoint}/${encodeURIComponent(selectedTeam.id)}/events`,
      { withCredentials: true },
    );
    const receive = (event) => {
      refresh();
      void loadDetails(selectedTeam);
      try {
        const next = JSON.parse(event.data);
        setDetails((value) => {
          const current = value[selectedTeam.id];
          if (!current || current.events.some((item) => item.id === next.id))
            return value;
          return {
            ...value,
            [selectedTeam.id]: {
              ...current,
              events: [...current.events, next],
            },
          };
        });
      } catch {
        // The next valid event or a manual refresh repairs the view.
      }
    };
    for (const type of [
      "team.updated",
      "member.added",
      "member.renamed",
      "member.removed",
      "task.queued",
      "task.started",
      "task.completed",
      "task.failed",
      "task.cancelled",
      "run.updated",
      "dispatch.updated",
      "task.updated",
      "mail.received",
    ])
      source.addEventListener(type, receive);
    return () => source.close();
  }, [selectedTeam]);
  const submit = async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await mutate(refresh, setError, endpoint, "POST", {
      name: String(values.get("name")),
      workspaceId: String(values.get("workspaceId")),
      lead: {
        name: String(values.get("lead")),
        engine: presets.rows.find((row) => row.id === values.get("presetId"))
          ?.engine,
        presetId: String(values.get("presetId")),
        ...(presets.rows.find((row) => row.id === values.get("presetId"))
          ?.engine === "acp"
          ? {
              acpCatalogId: presets.rows.find(
                (row) => row.id === values.get("presetId"),
              )?.acpCatalogId,
            }
          : {}),
      },
    });
  };
  const loadDetails = async (team) => {
    setSelectedTeam(team);
    try {
      const [tasks, messages, events, runs] = await Promise.all(
        ["tasks", "messages", "events", "runs"].map((name) =>
          request(`${endpoint}/${encodeURIComponent(team.id)}/${name}`),
        ),
      );
      setDetails((value) => ({
        ...value,
        [team.id]: { tasks, messages, events, runs },
      }));
    } catch (reason) {
      setError(reason.message);
    }
  };
  const beginTeamAction = (kind, team) => {
    setTeamAction({ kind, team });
    setTeamActionValue("");
    setOperationId(
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join(""),
    );
    setMemberEngine("codex");
    setMemberPresetId(team.members[0].presetId);
    setTargetMemberId(team.members[0].id);
  };
  const submitTeamAction = async (event) => {
    event.preventDefault();
    const value = teamActionValue.trim();
    if (!value || !teamAction) return;
    const { kind, team } = teamAction;
    const action = {
      run: {
        suffix: "runs",
        refresh: () => loadDetails(team),
        body: { input: value, operationId },
      },
      member: {
        suffix: "members",
        refresh,
        body: {
          name: value,
          engine: memberEngine,
          presetId: memberPresetId,
          ...(memberEngine === "acp"
            ? {
                acpCatalogId: presets.rows?.find(
                  (preset) => preset.id === memberPresetId,
                )?.acpCatalogId,
              }
            : {}),
        },
      },
      task: {
        suffix: "tasks",
        refresh: () => loadDetails(team),
        body: {
          memberId: targetMemberId,
          title: value,
          input: value,
        },
      },
      mail: {
        suffix: "messages",
        refresh: () => loadDetails(team),
        body: { fromMemberId: null, toMemberId: null, body: value },
      },
    }[kind];
    const saved = await mutate(
      action.refresh,
      setError,
      `${endpoint}/${encodeURIComponent(team.id)}/${action.suffix}`,
      "POST",
      action.body,
    );
    if (saved) setTeamAction(null);
  };
  const cancelTask = (team, taskEntry) =>
    mutate(
      () => loadDetails(team),
      setError,
      `${endpoint}/${encodeURIComponent(team.id)}/tasks/${encodeURIComponent(taskEntry.id)}/cancel`,
      "POST",
    );
  return h(
    Section,
    { title: "团队" },
    confirmation,
    h(
      "form",
      { className: "workagent-form", onSubmit: submit },
      ...[
        ["name", "团队名称"],
        ["lead", "负责人名称"],
      ].map(([name, label]) =>
        h(Field, { label, key: name }, h(Input, { name, required: true })),
      ),
      h(
        Field,
        { label: "团队项目" },
        h(Select, {
          name: "workspaceId",
          required: true,
          defaultValue: "",
          options: [
            ["", "选择项目"],
            ...workspaces.rows.map((row) => [row.id, row.name]),
          ],
        }),
      ),
      h(
        Field,
        { label: "负责人助手" },
        h(Select, {
          name: "presetId",
          required: true,
          defaultValue: "",
          options: [
            ["", "选择助手"],
            ...presets.rows
              .filter((row) => row.enabled)
              .map((row) => [row.id, row.name]),
          ],
        }),
      ),
      h(
        "button",
        { type: "submit", className: "workagent-button" },
        "创建团队",
      ),
    ),
    error
      ? h("p", { role: "alert", className: "workagent-error" }, error)
      : null,
    h(Status, { state }),
    ...state.rows.map((team, teamIndex) =>
      h(
        Card,
        {
          key: `${team.id}-${teamIndex}`,
          title: team.name,
          detail: `${team.members.length} 位成员 · ${displayValue(team.sessionMode, "独立会话")}`,
        },
        h(
          "div",
          { className: "workagent-team-members" },
          ...team.members.map((member, memberIndex) => {
            const session = sessions.rows.find(
              (row) => row.id === member.sessionId,
            );
            return h(
              "article",
              { key: member.id },
              h("strong", null, member.name),
              " · ",
              member.role === "lead" ? "负责人" : "成员",
              " · ",
              displayValue(session?.activity?.state || member.status),
              member.sessionId
                ? h(
                    "a",
                    {
                      href: `/?frontend=dsh&session=${encodeURIComponent(member.sessionId)}`,
                    },
                    "打开成员对话",
                  )
                : null,
              h(
                "form",
                {
                  key: member.name,
                  className: "workagent-form",
                  onSubmit: (event) => {
                    event.preventDefault();
                    const name = String(
                      new FormData(event.currentTarget).get("name") || "",
                    ).trim();
                    if (name)
                      mutate(
                        refresh,
                        setError,
                        `${endpoint}/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.id)}`,
                        "PATCH",
                        { name: name.trim() },
                      );
                  },
                },
                h(
                  Field,
                  { label: "成员名称" },
                  h(Input, {
                    name: "name",
                    defaultValue: member.name,
                    required: true,
                    maxLength: 120,
                  }),
                ),
                h(Button, { type: "submit" }, "重命名成员"),
              ),
              member.role !== "lead"
                ? h(
                    Button,
                    {
                      disabled: member.status === "running",
                      onClick: async () => {
                        if (
                          await confirm({
                            description: `移除成员“${member.name}”？`,
                            danger: true,
                            confirmLabel: "移除成员",
                          })
                        )
                          mutate(
                            refresh,
                            setError,
                            `${endpoint}/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.id)}`,
                            "DELETE",
                          );
                      },
                    },
                    "移除成员",
                  )
                : null,
              memberIndex > 1
                ? h(
                    Button,
                    {
                      onClick: () => {
                        const memberIds = team.members.map((row) => row.id);
                        [memberIds[memberIndex - 1], memberIds[memberIndex]] = [
                          memberIds[memberIndex],
                          memberIds[memberIndex - 1],
                        ];
                        mutate(
                          refresh,
                          setError,
                          `${endpoint}/${encodeURIComponent(team.id)}`,
                          "PATCH",
                          { version: team.version, memberIds },
                        );
                      },
                    },
                    "上移成员",
                  )
                : null,
            );
          }),
        ),
        h(
          Button,
          { onClick: () => beginTeamAction("member", team) },
          "添加成员",
        ),
        h(
          Button,
          { onClick: () => beginTeamAction("run", team) },
          "交给团队自主完成",
        ),
        h(Button, { onClick: () => beginTeamAction("task", team) }, "分派任务"),
        h(Button, { onClick: () => loadDetails(team) }, "消息与动态"),
        h(
          Button,
          { onClick: () => beginTeamAction("mail", team) },
          "发送团队消息",
        ),
        details[team.id]
          ? h(
              "div",
              { className: "workagent-stack" },
              ...(details[team.id].runs || []).map((run) =>
                h(
                  "article",
                  { key: run.id },
                  h(
                    "strong",
                    null,
                    {
                      running: "团队协作中",
                      paused: "已暂停",
                      paused_limit: "本段协作已达上限",
                      completed: "已完成",
                      cancelled: "已取消",
                      interrupted: "已中断，等待恢复",
                    }[run.status],
                  ),
                  h("p", null, run.input),
                  h(
                    "p",
                    null,
                    `第 ${run.segment} 段 · 已执行 ${run.dispatchCount}/64 个成员回合`,
                  ),
                  run.status === "paused_limit"
                    ? h(
                        "p",
                        null,
                        "继续将开启新的运行预算段，保留成员、消息和待办。",
                      )
                    : null,
                  run.reason === "dependency_failed"
                    ? h(
                        "p",
                        null,
                        "前置任务未成功，后续任务已暂停。继续后由组长检查原因并调整分工。",
                      )
                    : null,
                  run.result ? h(Markdown, null, run.result) : null,
                  ...(["completed", "cancelled"].includes(run.status)
                    ? []
                    : [
                        h(
                          Button,
                          {
                            key: "toggle",
                            onClick: () =>
                              mutate(
                                () => loadDetails(team),
                                setError,
                                `${endpoint}/${encodeURIComponent(team.id)}/runs/${encodeURIComponent(run.id)}/${run.status === "running" ? "pause" : "resume"}`,
                                "POST",
                                {},
                              ),
                          },
                          run.status === "running"
                            ? "暂停后续协作"
                            : "继续协作",
                        ),
                        h(
                          Button,
                          {
                            key: "cancel",
                            onClick: () =>
                              mutate(
                                () => loadDetails(team),
                                setError,
                                `${endpoint}/${encodeURIComponent(team.id)}/runs/${encodeURIComponent(run.id)}/cancel`,
                                "POST",
                                {},
                              ),
                          },
                          "取消本次协作",
                        ),
                        h(
                          "small",
                          { key: "note" },
                          "暂停停止后续分派；取消会中止运行中的回合，已发生的文件和网络操作不会自动撤销。",
                        ),
                      ]),
                ),
              ),
              h(
                "span",
                null,
                `${details[team.id].tasks.length} 个任务 · ${details[team.id].messages.length} 条消息 · ${details[team.id].events.length} 条动态`,
              ),
              ...details[team.id].tasks.map((taskEntry) =>
                h(
                  "article",
                  { key: taskEntry.id },
                  h(
                    "strong",
                    null,
                    `${taskEntry.title} · ${displayValue(taskEntry.status)}`,
                  ),
                  h(
                    "p",
                    null,
                    `执行成员：${team.members.find((member) => member.id === taskEntry.memberId)?.name || "已移除成员"}`,
                  ),
                  taskEntry.result ? h(Markdown, null, taskEntry.result) : null,
                  taskEntry.dependsOnIds?.length
                    ? h(
                        "p",
                        null,
                        `前置任务：${taskEntry.dependsOnIds.map((id) => details[team.id].tasks.find((task) => task.id === id)?.title || id).join("、")}`,
                      )
                    : null,
                  taskEntry.error
                    ? h("p", { role: "alert" }, friendlyError(taskEntry.error))
                    : null,
                  taskEntry.sessionId
                    ? h(
                        "a",
                        {
                          href: `/?frontend=dsh&session=${encodeURIComponent(taskEntry.sessionId)}`,
                        },
                        "查看执行对话",
                      )
                    : null,
                  h(
                    Button,
                    {
                      key: `task-${taskEntry.id}`,
                      disabled: !["queued", "running"].includes(
                        taskEntry.status,
                      ),
                      onClick: () => cancelTask(team, taskEntry),
                    },
                    "取消任务",
                  ),
                ),
              ),
              ...details[team.id].messages.map((message) =>
                h("span", { key: `mail-${message.id}` }, message.body),
              ),
              ...details[team.id].events.map((event) =>
                h(
                  "span",
                  {
                    key: `event-${event.id}`,
                    className: "workagent-muted",
                  },
                  displayValue(event.type),
                ),
              ),
            )
          : null,
      ),
    ),
    teamAction
      ? h(
          "form",
          { className: "workagent-form", onSubmit: submitTeamAction },
          h(
            Field,
            {
              label: {
                member: "成员名称",
                task: "任务标题",
                mail: "发送给团队的消息",
                run: "希望团队完成的目标",
              }[teamAction.kind],
            },
            h(Input, {
              "aria-label": "团队操作内容",
              value: teamActionValue,
              onChange: (event) => setTeamActionValue(event.target.value),
              required: true,
            }),
          ),
          h(Button, { type: "submit" }, "确认"),
          h(Button, { onClick: () => setTeamAction(null) }, "取消"),
          teamAction.kind === "task"
            ? h(
                Field,
                { label: "执行成员" },
                h(Select, {
                  value: targetMemberId,
                  onChange: (event) => setTargetMemberId(event.target.value),
                  options: teamAction.team.members.map((member) => [
                    member.id,
                    member.name,
                  ]),
                }),
              )
            : null,
          teamAction.kind === "member"
            ? h(
                React.Fragment,
                null,
                h(
                  Field,
                  { label: "成员引擎" },
                  h(Select, {
                    "aria-label": "成员引擎",
                    value: memberEngine,
                    onChange: (event) => {
                      setMemberEngine(event.target.value);
                      setMemberPresetId("");
                    },
                    options: [
                      ["harness", "通用引擎"],
                      ["codex", "Codex"],
                      ["kimi", "Kimi"],
                      ["acp", "管理员提供的 ACP 引擎"],
                    ],
                  }),
                ),
                h(
                  Field,
                  { label: "成员助手" },
                  h(Select, {
                    "aria-label": "成员助手",
                    value: memberPresetId,
                    onChange: (event) => setMemberPresetId(event.target.value),
                    required: true,
                    options: [
                      ["", "选择助手"],
                      ...presets.rows
                        .filter(
                          (row) => row.enabled && row.engine === memberEngine,
                        )
                        .map((row) => [row.id, row.name]),
                    ],
                  }),
                ),
              )
            : null,
        )
      : null,
  );
}

export { TeamsPage };
