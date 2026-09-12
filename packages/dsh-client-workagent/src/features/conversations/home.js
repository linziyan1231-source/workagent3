import { messageDelivery } from "./state.js";
import {
  createPersonalTask,
  personalTaskRoute,
  sharedTaskProject,
} from "../collaboration/personal-tasks.js";
import { usePresets } from "../agents/api.js";
import { workbench } from "../content/index.js";
import { navigation } from "../../host/navigation.js";
import { apiRoot, request } from "../../platform/api.js";
import { useResource } from "../../platform/resources.js";
import { Button, Input, Select } from "../../ui/elements.js";
import { Icon } from "../../ui/icons.js";
import {
  displayWorkspaceName,
  friendlyError,
  plainSessionTitle,
  reasoningLabel,
} from "../../ui/labels.js";
import {
  defaultEffort,
  permissionOptions,
  resolveModelDefaults,
  useModelDefaults,
} from "../agents/model-defaults.js";
import { AGENT_PICK_KEY, HERO_AGENT_EVENT } from "../agents/state.js";
import { FILE_PROJECT_EVENT } from "../files/api.js";
import {
  HERO_WORKSPACE_EVENT,
  PROJECTS_CHANGED_EVENT,
  WORKSPACE_PICK_KEY,
  announceProjectsChanged,
} from "../projects/state.js";
import {
  ComposerForm,
  ComposerInput,
  submitComposerOnEnter,
} from "./composer.js";
import { fileReferenceLabel } from "@workagent/contracts/file-reference";
import React from "react";
import { createElement as h } from "react";

// Draft choices live only in this composer. New conversations start from settings.
function useDraftOption(key, options, defaultId, revision) {
  const [selection, setSelection] = React.useState({
    revision,
    values: {},
  });
  const saved =
    selection.revision === revision ? selection.values[key] : undefined;
  const value =
    (
      options.find((option) => option.id === saved) ||
      options.find((option) => option.id === defaultId) ||
      options[0]
    )?.id || "";
  return [
    value,
    (value) =>
      setSelection((previous) => ({
        revision,
        values: {
          ...(previous.revision === revision ? previous.values : {}),
          [key]: value,
        },
      })),
  ];
}

function HeroWorkspaceComposer() {
  const search = navigation.useSearch();
  const projectId = sharedTaskProject(new URLSearchParams(search));
  return projectId
    ? h(SharedTaskComposer, { key: projectId, projectId })
    : h(WorkspaceComposer);
}

function SharedTaskComposer({ projectId }) {
  const [state] = useResource(
    "/api/portal/shared-projects?include_hidden=true",
    (value) => value.projects || [],
  );
  const project = state.rows.find((row) => row.id === projectId);
  if (state.loading) return h("p", { role: "status" }, "正在加载共享项目…");
  if (state.error || !project)
    return h(
      "p",
      { role: "alert", className: "workagent-error" },
      state.error
        ? friendlyError(state.error)
        : "项目不存在，或你已不再是项目成员。",
    );
  return h(WorkspaceComposer, { sharedProject: project });
}

function WorkspaceComposer({ sharedProject } = {}) {
  const routeSearch = navigation.useSearch();
  const [workspaceState, reloadWorkspaces] = useResource(
    `${apiRoot}/workspaces`,
  );
  const [presetState] = usePresets((value) =>
    (Array.isArray(value) ? value : []).filter((preset) => preset.enabled),
  );
  const [modelState] = useResource(`${apiRoot}/model-options`);
  const [personalProjectChoice, setProjectChoice] = React.useState(
    () =>
      new URLSearchParams(routeSearch).get("project") ||
      localStorage.getItem(WORKSPACE_PICK_KEY) ||
      "none",
  );
  React.useEffect(() => {
    setProjectChoice(
      new URLSearchParams(routeSearch).get("project") ||
        localStorage.getItem(WORKSPACE_PICK_KEY) ||
        "none",
    );
  }, [routeSearch]);
  const projectChoice = sharedProject
    ? `shared:${sharedProject.id}`
    : personalProjectChoice;
  const [presetId, setPresetId] = React.useState(
    () => localStorage.getItem(AGENT_PICK_KEY) || "builtin-general",
  );
  const [projectName, setProjectName] = React.useState("");
  const [preferences, , defaultsRevision] = useModelDefaults();
  const [message, setMessage] = workbench.useDraft(`home:${projectChoice}`);
  const [attachmentsBusy, setAttachmentsBusy] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    window.dispatchEvent(
      new window.CustomEvent(FILE_PROJECT_EVENT, {
        detail: ["none", "new"].includes(projectChoice) ? "" : projectChoice,
      }),
    );
  }, [projectChoice]);

  React.useEffect(() => {
    const update = (event) => setPresetId(event.detail);
    window.addEventListener(HERO_AGENT_EVENT, update);
    return () => window.removeEventListener(HERO_AGENT_EVENT, update);
  }, []);
  React.useEffect(() => {
    if (sharedProject) return;
    const update = (event) => setProjectChoice(event.detail);
    window.addEventListener(HERO_WORKSPACE_EVENT, update);
    return () => window.removeEventListener(HERO_WORKSPACE_EVENT, update);
  }, []);
  React.useEffect(() => {
    const update = () => void reloadWorkspaces();
    window.addEventListener(PROJECTS_CHANGED_EVENT, update);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, update);
  }, [reloadWorkspaces]);

  const selectedPreset =
    presetState.rows.find((preset) => preset.id === presetId) ||
    presetState.rows.find((preset) => preset.id === "builtin-general") ||
    presetState.rows[0];
  const availableProjects = workspaceState.rows;
  const modelGroup = modelState.rows.find(
    (group) => group.engine === selectedPreset?.engine,
  );
  const availableModels = modelGroup?.models || [];
  const defaults = resolveModelDefaults(
    modelGroup,
    preferences,
    selectedPreset,
  );
  const draftKey = `${selectedPreset?.id}:${selectedPreset?.engine}`;
  const [modelId, setModelId] = useDraftOption(
    draftKey,
    availableModels,
    defaults.modelId,
    defaultsRevision,
  );
  const selectedModel = availableModels.find((model) => model.id === modelId);
  const reasoningOptions = selectedModel?.reasoning || [];
  const [thinkingEffort, setThinkingEffort] = useDraftOption(
    `${draftKey}.${modelId}`,
    reasoningOptions,
    modelId === defaults.modelId
      ? defaults.thinkingEffort
      : defaultEffort(selectedPreset?.engine, selectedModel),
    defaultsRevision,
  );
  const [permissionMode, setPermissionMode] = useDraftOption(
    draftKey,
    permissionOptions.map(([id]) => ({ id })),
    defaults.permissionMode,
    defaultsRevision,
  );
  React.useEffect(() => {
    if (sharedProject || workspaceState.loading) return;
    const valid = availableProjects.some(
      (project) => project.id === projectChoice,
    );
    if (!valid && projectChoice !== "new" && projectChoice !== "none")
      setProjectChoice("none");
  }, [workspaceState.loading, workspaceState.rows]);
  const selectProject = (event) => {
    const value = event.target.value;
    setProjectChoice(value);
    if (value !== "new" && value !== "none") {
      localStorage.setItem(WORKSPACE_PICK_KEY, value);
      window.dispatchEvent(
        new window.CustomEvent(HERO_WORKSPACE_EVENT, { detail: value }),
      );
    }
    setError("");
  };
  const submit = async (event) => {
    event.preventDefault();
    const content = message.trim();
    if (!content || busy || attachmentsBusy) return;
    if (!selectedPreset) {
      setError("请先选择一个助手。");
      return;
    }
    if (modelState.loading || !selectedModel) {
      setError("请先获取可用模型。");
      return;
    }
    if (projectChoice === "new" && !projectName.trim()) {
      setError("请输入新项目名称。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let project = availableProjects.find((item) => item.id === projectChoice);
      if (projectChoice === "new") {
        project = await request(`${apiRoot}/workspaces`, {
          method: "POST",
          body: JSON.stringify({
            name: projectName.trim(),
            scope: "personal",
          }),
        });
        await reloadWorkspaces();
        announceProjectsChanged();
      }
      const common = {
        ...(modelId ? { modelId } : {}),
        ...(thinkingEffort ? { thinkingEffort } : {}),
        permissionMode,
      };
      const options = {
        engine: selectedPreset.engine,
        title: plainSessionTitle(fileReferenceLabel(content).slice(0, 28)),
        presetId: selectedPreset.id,
        ...common,
      };
      const session = sharedProject
        ? await createPersonalTask(sharedProject, options)
        : await request(`${apiRoot}/sessions`, {
            method: "POST",
            body: JSON.stringify({
              ...options,
              workspace: project?.id || "default",
            }),
          });
      const receipt = {
        id: `message-ui-${crypto.randomUUID()}`,
        sessionId: session.id,
        role: "user",
        text: content,
        createdAt: new Date().toISOString(),
        queued: false,
        status: "sending",
        error: "",
      };
      if (sharedProject) messageDelivery.update(session.id, receipt);
      try {
        await request(
          `${apiRoot}/sessions/${encodeURIComponent(session.id)}/turns`,
          {
            method: "POST",
            body: JSON.stringify({ content, messageId: receipt.id }),
          },
        );
        if (sharedProject)
          messageDelivery.update(session.id, { ...receipt, status: "sent" });
      } catch (cause) {
        if (!sharedProject) throw cause;
        // The normal conversation owns durable receipts and exact-ID retry.
        messageDelivery.update(session.id, {
          ...receipt,
          status: "failed",
          error: friendlyError(cause.message),
        });
      }
      setMessage("");
      navigation.navigate(
        sharedProject
          ? personalTaskRoute(sharedProject.id, session.id)
          : `/?session=${encodeURIComponent(session.id)}`,
      );
    } catch (cause) {
      setError(friendlyError(cause.message));
    } finally {
      setBusy(false);
    }
  };

  return h(
    "div",
    { className: "workagent-hero-controls" },
    h(
      ComposerForm,
      { className: "workagent-hero-composer", onSubmit: submit },
      h(workbench.ComposerTools, {
        key: projectChoice,
        session: {
          id: "home",
          workspaceId:
            projectChoice === "none"
              ? "default"
              : projectChoice === "new"
                ? undefined
                : projectChoice,
          preset: { resolvedSnapshot: selectedPreset || {} },
        },
        input: message,
        setInput: setMessage,
        disabled: busy,
        onError: setError,
        onBusyChange: setAttachmentsBusy,
      }),
      h(ComposerInput, {
        "aria-label": "输入消息",
        workspaceId: projectChoice === "none" ? "default" : projectChoice,
        value: message,
        onChange: (event) => setMessage(event.target.value),
        onKeyDown: submitComposerOnEnter,
        placeholder: "描述你想完成的任务…",
      }),
      h(
        "div",
        { className: "workagent-hero-composer-bar" },
        h(
          "div",
          { className: "workagent-composer-options" },
          h(
            "label",
            {
              className: "workagent-model-choice",
              title: selectedModel?.name || "模型",
            },
            h(
              "span",
              {
                className: "workagent-model-choice-label",
                "aria-hidden": true,
              },
              selectedModel?.name || "模型",
            ),
            h(Select, {
              "aria-label": "模型",
              value: modelId,
              disabled: modelState.loading || !availableModels.length,
              onChange: (event) => setModelId(event.target.value),
              options: [
                ...(!availableModels.length
                  ? [
                      [
                        "",
                        modelState.loading ? "正在获取模型…" : "暂无可用模型",
                      ],
                    ]
                  : []),
                ...availableModels.map((model) => [model.id, model.name]),
              ],
            }),
          ),
          h(
            "label",
            { title: "思考级别" },
            h(Select, {
              "aria-label": "思考级别",
              heading: "思考强度",
              value: thinkingEffort,
              disabled: modelState.loading || !reasoningOptions.length,
              onChange: (event) => setThinkingEffort(event.target.value),
              options: reasoningOptions.length
                ? reasoningOptions.map((option) => [
                    option.id,
                    reasoningLabel(option),
                  ])
                : [["", "未提供思考选项"]],
            }),
          ),
          h(
            "label",
            { title: "权限" },
            h(Select, {
              "aria-label": "权限",
              heading: "权限",
              value: permissionMode,
              onChange: (event) => setPermissionMode(event.target.value),
              options: permissionOptions,
            }),
          ),
        ),
        h(
          "button",
          {
            type: "submit",
            className: "workagent-composer-send",
            "aria-label": "发送消息",
            disabled:
              busy ||
              !message.trim() ||
              !selectedPreset ||
              (projectChoice === "new" && !projectName.trim()),
          },
          h(Icon, { name: "send", size: 18 }),
        ),
      ),
    ),
    h(
      "div",
      { className: "workagent-project-row" },
      h(
        "label",
        { className: "workagent-project-select" },
        h(Icon, { name: "workspace", size: 16 }),
        sharedProject
          ? h(
              "span",
              {
                className: "workagent-shared-project-name",
                title: sharedProject.name,
              },
              sharedProject.name,
            )
          : h(Select, {
              "aria-label": "个人项目",
              value: projectChoice,
              onChange: selectProject,
              options: [
                ["none", "不使用项目"],
                ...availableProjects.map((project) => [
                  project.id,
                  displayWorkspaceName(project.name),
                ]),
                ["new", "新建个人项目…"],
              ],
            }),
      ),
      projectChoice === "new"
        ? h(
            "div",
            { className: "workagent-project-draft" },
            h(Input, {
              className: "workagent-project-name",
              "aria-label": "新项目名称",
              value: projectName,
              onChange: (event) => setProjectName(event.target.value),
              placeholder: "个人项目名称",
            }),
            h(
              Button,
              {
                disabled: busy || !projectName.trim(),
                onClick: async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const project = await request(`${apiRoot}/workspaces`, {
                      method: "POST",
                      body: JSON.stringify({
                        name: projectName.trim(),
                        scope: "personal",
                      }),
                    });
                    await reloadWorkspaces();
                    setProjectChoice(project.id);
                    announceProjectsChanged();
                  } catch (reason) {
                    setError(friendlyError(reason.message));
                  } finally {
                    setBusy(false);
                  }
                },
              },
              "创建项目",
            ),
          )
        : null,
      error
        ? h("span", { role: "alert", className: "workagent-error" }, error)
        : h(
            "span",
            { className: "workagent-composer-hint" },
            busy
              ? "正在创建会话…"
              : sharedProject
                ? "个人任务 · 仅自己可见"
                : "Enter 发送",
          ),
    ),
  );
}

export { HeroWorkspaceComposer };
