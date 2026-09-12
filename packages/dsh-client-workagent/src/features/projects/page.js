import { apiRoot, request } from "../../platform/api.js";
import { useResource } from "../../platform/resources.js";
import {
  Button,
  Card,
  Field,
  Input,
  Section,
  Status,
} from "../../ui/elements.js";
import { Icon } from "../../ui/icons.js";
import { displayWorkspaceName, friendlyError } from "../../ui/labels.js";
import { WorkspaceFileManager } from "../files/manager.js";
import { FileIconButton } from "../files/preview.js";
import {
  PROJECTS_CHANGED_EVENT,
  announceProjectsChanged,
  startProjectConversation,
} from "./state.js";
import React from "react";
import { createElement as h } from "react";

function WorkspacesPage() {
  const endpoint = `${apiRoot}/workspaces`;
  const [state, refresh] = useResource(endpoint);
  const [selectedId, setSelectedId] = React.useState(null);
  const [error, setError] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [showCreate, setShowCreate] = React.useState(false);
  const visibleProjects = state.rows.filter((workspace) =>
    displayWorkspaceName(workspace.name)
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  React.useEffect(() => {
    const update = () => void refresh();
    window.addEventListener(PROJECTS_CHANGED_EVENT, update);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, update);
  }, [refresh]);
  const createProject = async (event) => {
    event.preventDefault();
    if (creating) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const name = String(values.get("name") || "").trim();
    if (!name) {
      setError("请输入项目名称。");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const project = await request(endpoint, {
        method: "POST",
        body: JSON.stringify({ name, scope: "personal" }),
      });
      await refresh();
      announceProjectsChanged();
      form.reset();
      setShowCreate(false);
      setQuery("");
      setSelectedId(project.id);
    } catch (reason) {
      setError(friendlyError(reason.message));
    } finally {
      setCreating(false);
    }
  };
  return h(
    Section,
    { title: "项目" },
    h(
      "div",
      { className: "workagent-project-intro" },
      h(
        "div",
        null,
        h("h2", null, "所有项目"),
        h("p", null, "文件与对话，在这里井然有序。"),
      ),
      h(
        "span",
        { className: "workagent-project-count" },
        `${state.rows.length} 个项目`,
      ),
    ),
    h(
      "div",
      { className: "workagent-project-toolbar" },
      h(
        "div",
        { className: "workagent-project-search" },
        h(Icon, { name: "search", size: 18 }),
        h(Input, {
          "aria-label": "搜索项目",
          placeholder: "搜索项目名称…",
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }),
        query
          ? h(
              Button,
              { "aria-label": "清除项目搜索", onClick: () => setQuery("") },
              h(Icon, { name: "close", size: 16 }),
            )
          : null,
      ),
      h(
        Button,
        {
          className: "workagent-button workagent-project-new",
          variant: "primary",
          onClick: () => {
            setError("");
            setShowCreate(true);
          },
        },
        h(Icon, { name: "plus", size: 16 }),
        "新建项目",
      ),
    ),
    showCreate
      ? h(
          "form",
          {
            className: "workagent-form workagent-project-create",
            onSubmit: createProject,
          },
          h(
            Field,
            { label: "新项目名称" },
            h(Input, {
              name: "name",
              autoFocus: true,
              required: true,
              maxLength: 120,
              placeholder: "给项目起个名字",
              onKeyDown: (event) => {
                if (event.key === "Escape" && !creating) {
                  event.stopPropagation();
                  setShowCreate(false);
                }
              },
            }),
          ),
          h(
            Button,
            { disabled: creating, onClick: () => setShowCreate(false) },
            "取消",
          ),
          h(
            Button,
            {
              className: "workagent-button workagent-project-new",
              variant: "primary",
              type: "submit",
              disabled: creating,
            },
            creating ? "正在创建…" : "创建项目",
          ),
        )
      : null,
    error
      ? h("p", { role: "alert", className: "workagent-error" }, error)
      : null,
    state.loading || state.error
      ? h(Status, { state })
      : state.rows.length === 0
        ? h(
            "div",
            { className: "workagent-project-empty" },
            h(Icon, { name: "workspace", size: 36 }),
            h("strong", null, "创建你的第一个项目"),
            h("p", null, "给项目起个名字，将相关文件与对话放在一起。"),
          )
        : null,
    !state.loading && state.rows.length > 0 && visibleProjects.length === 0
      ? h(
          "div",
          { className: "workagent-project-empty" },
          h(Icon, { name: "search", size: 28 }),
          h("strong", null, "没有找到匹配的项目"),
          h("p", null, "试试其他名称，或清除搜索查看所有项目。"),
        )
      : null,
    h(
      "div",
      { className: "workagent-grid workagent-workspace-grid" },
      ...visibleProjects.map((workspace) =>
        h(
          React.Fragment,
          { key: workspace.id },
          h(
            Card,
            {
              key: workspace.id,
              className: `workagent-workspace-card${selectedId === workspace.id ? " is-selected" : ""}`,
              title: h(
                "span",
                null,
                h(Icon, { name: "workspace", size: 18 }),
                displayWorkspaceName(workspace.name),
              ),
              detail: workspace.scope === "team" ? "团队共享项目" : "个人项目",
            },
            h(
              Button,
              {
                onClick: () => setSelectedId(workspace.id),
                "aria-expanded": selectedId === workspace.id,
              },
              "管理文件",
              h(Icon, { name: "chevronRight", size: 14 }),
            ),
            h(
              Button,
              { onClick: () => startProjectConversation(workspace) },
              h(Icon, { name: "plus", size: 14 }),
              "新建会话",
            ),
          ),
          selectedId === workspace.id
            ? h(
                "section",
                {
                  className: "workagent-project-files",
                  "aria-label": "项目文件",
                },
                h(
                  "header",
                  { className: "workagent-files-panel-header" },
                  h("strong", null, displayWorkspaceName(workspace.name)),
                  h(FileIconButton, {
                    name: "close",
                    label: "收起项目文件",
                    onClick: () => setSelectedId(null),
                  }),
                ),
                h(WorkspaceFileManager, {
                  key: workspace.id,
                  workspace,
                  onDismiss: () => setSelectedId(null),
                  dismissLabel: "收起项目文件",
                }),
              )
            : null,
        ),
      ),
    ),
  );
}

export { WorkspacesPage };
