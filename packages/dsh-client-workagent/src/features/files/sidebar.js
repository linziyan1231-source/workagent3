import { useSessionResource } from "../conversations/resources.js";
import { navigation } from "../../host/navigation.js";
import { apiRoot, request } from "../../platform/api.js";
import { useResource } from "../../platform/resources.js";
import { Icon } from "../../ui/icons.js";
import { displayWorkspaceName, friendlyError } from "../../ui/labels.js";
import { ResizeHandle } from "../../ui/resize.js";
import { TopNotificationButton } from "../notifications/page.js";
import {
  HERO_WORKSPACE_EVENT,
  PROJECTS_CHANGED_EVENT,
  WORKSPACE_PICK_KEY,
} from "../projects/state.js";
import { FILE_PROJECT_EVENT, uploads, workspaceFileRoot } from "./api.js";
import { WorkspaceFileManager } from "./manager.js";
import { FileIconButton } from "./preview.js";
import React from "react";
import { createElement as h } from "react";

function FileSidebarPanel({
  workspaceId,
  onProjectChange,
  sessionLoading,
  sessionError,
}) {
  const sharedProjectId = workspaceId?.startsWith("shared:")
    ? workspaceId.slice("shared:".length)
    : "";
  const [state, refresh] = useResource(
    sessionLoading
      ? null
      : sharedProjectId
        ? "/api/portal/shared-projects?include_hidden=true"
        : `${apiRoot}/workspaces`,
    (value) => (sharedProjectId ? value?.projects || [] : value),
  );
  const [open, setOpen] = React.useState(
    () =>
      localStorage.getItem("workagent.files.open") === "true" ||
      (localStorage.getItem("workagent.files.open") === null &&
        window.innerWidth >= 1100),
  );
  const [width, setWidth] = React.useState(
    () => Number(localStorage.getItem("workagent.files.width")) || 440,
  );
  React.useEffect(() => {
    const openFile = (event) => {
      if (event.detail?.workspaceId === workspaceId) {
        setOpen(true);
        localStorage.setItem("workagent.files.open", "true");
      }
    };
    window.addEventListener("workagent:file-open", openFile);
    return () => window.removeEventListener("workagent:file-open", openFile);
  }, [workspaceId]);
  const resizeWidth = (value) => {
    const next = Math.max(320, Math.min(window.innerWidth - 640, value));
    setWidth(next);
    localStorage.setItem("workagent.files.width", String(next));
  };
  React.useEffect(() => {
    const update = () =>
      document.body.style.setProperty(
        "--workagent-files-width",
        `${Math.max(320, Math.min(window.innerWidth - 640, width))}px`,
      );
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      document.body.style.removeProperty("--workagent-files-width");
    };
  }, [width]);
  const toggle = (value) => {
    setOpen(value);
    localStorage.setItem("workagent.files.open", String(value));
  };
  const selectedProject = state.rows.find(
    (row) => row.id === (sharedProjectId || workspaceId),
  );
  const workspace =
    workspaceId === "default"
      ? {
          id: "default",
          name: "当前会话文件",
          directory: ".workagent-unassigned",
        }
      : selectedProject && { ...selectedProject, id: workspaceId };
  const sharedFiles = sharedProjectId
    ? {
        root: workspaceFileRoot(workspaceId),
        trashRoot: `${workspaceFileRoot(workspaceId)}/trash`,
        editable: false,
        resolveOfficePreview: async (_workspace, entry, signal) => {
          const result = await request("/api/portal/shared-office-preview", {
            method: "POST",
            body: JSON.stringify({
              project_id: sharedProjectId,
              path: entry.path,
            }),
            signal,
          });
          return result.url;
        },
        createEmptyFile: async ({ directory, name }) => {
          await uploads.uploadFile(
            workspaceId,
            [directory, name].filter(Boolean).join("/"),
            new File([], name, { type: "text/plain" }),
          );
        },
      }
    : {};
  React.useEffect(() => {
    const update = () => void refresh();
    window.addEventListener(PROJECTS_CHANGED_EVENT, update);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, update);
  }, [refresh]);
  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "workagent-top-actions" },
      h(TopNotificationButton),
      h(
        "button",
        {
          type: "button",
          className: "workagent-files-toggle",
          "aria-label": open ? "收起文件侧栏" : "打开文件侧栏",
          "aria-expanded": open,
          "aria-controls": "workagent-files-panel",
          title: "项目文件",
          onClick: () => toggle(!open),
        },
        h(Icon, { name: "workspace", size: 19 }),
      ),
    ),
    open
      ? h("button", {
          type: "button",
          className: "workagent-files-backdrop",
          "aria-label": "关闭文件侧栏遮罩",
          onClick: () => toggle(false),
        })
      : null,
    h(
      "aside",
      {
        id: "workagent-files-panel",
        hidden: !open,
        className: "workagent-files-panel",
        "aria-label": "项目文件侧栏",
        onKeyDown: (event) => {
          if (
            event.key === "Escape" &&
            !["INPUT", "TEXTAREA"].includes(event.target.tagName)
          )
            toggle(false);
        },
      },
      h(ResizeHandle, {
        orientation: "vertical",
        value: width,
        onChange: resizeWidth,
        measure: (event) => {
          const initial = event.clientX;
          const actualWidth =
            event.currentTarget.parentElement.getBoundingClientRect().width;
          return (move) => actualWidth + initial - move.clientX;
        },
      }),
      h(
        "header",
        { className: "workagent-files-panel-header" },
        h("strong", null, "项目文件"),
        h(FileIconButton, {
          name: "expand",
          label: width > 500 ? "缩小文件侧栏" : "放大文件侧栏",
          onClick: () =>
            resizeWidth(width > 500 ? 440 : window.innerWidth * 0.55),
        }),
        h(FileIconButton, {
          name: "close",
          label: "关闭文件侧栏",
          onClick: () => toggle(false),
        }),
      ),
      onProjectChange && !sharedProjectId
        ? h(
            "select",
            {
              className: "workagent-files-project",
              "aria-label": "文件侧栏项目",
              value: workspace?.id || "",
              onChange: (event) => onProjectChange(event.target.value),
            },
            h("option", { value: "" }, "选择项目"),
            ...state.rows
              .filter((row) => row.scope !== "team")
              .map((row) =>
                h(
                  "option",
                  { key: row.id, value: row.id },
                  displayWorkspaceName(row.name),
                ),
              ),
          )
        : h(
            "div",
            {
              className: "workagent-files-project",
              title: workspace?.name || undefined,
            },
            workspace
              ? displayWorkspaceName(workspace.name)
              : sharedProjectId
                ? "共享项目文件夹"
                : "当前会话项目",
          ),
      state.error || sessionError
        ? h(
            "p",
            { role: "alert", className: "workagent-file-notice" },
            friendlyError(state.error || sessionError),
          )
        : state.loading || sessionLoading
          ? h("p", { role: "status" }, "正在加载项目…")
          : workspace
            ? h(WorkspaceFileManager, {
                key: workspace.id,
                workspace,
                ...sharedFiles,
                onDismiss: () => toggle(false),
              })
            : h(
                "div",
                { className: "workagent-file-panel-empty" },
                h(Icon, { name: "workspace", size: 32 }),
                h(
                  "strong",
                  null,
                  sharedProjectId ? "共享项目文件夹" : "选择项目后查看文件",
                ),
                h(
                  "p",
                  null,
                  sharedProjectId
                    ? "项目不存在，或你已不再是项目成员。"
                    : "文件随项目保存。已有会话会自动显示所属项目。",
                ),
              ),
    ),
  );
}

function HomeFileSidebar() {
  const routeSearch = navigation.useSearch();
  const [workspaceId, setWorkspaceId] = React.useState(
    () =>
      new URLSearchParams(routeSearch).get("project") ||
      localStorage.getItem(WORKSPACE_PICK_KEY) ||
      "",
  );
  React.useEffect(() => {
    setWorkspaceId(
      new URLSearchParams(routeSearch).get("project") ||
        localStorage.getItem(WORKSPACE_PICK_KEY) ||
        "",
    );
  }, [routeSearch]);
  React.useEffect(() => {
    const update = (event) => setWorkspaceId(event.detail || "");
    window.addEventListener(FILE_PROJECT_EVENT, update);
    return () => window.removeEventListener(FILE_PROJECT_EVENT, update);
  }, []);
  return h(FileSidebarPanel, {
    workspaceId,
    onProjectChange: (id) => {
      setWorkspaceId(id);
      localStorage.setItem(WORKSPACE_PICK_KEY, id || "none");
      window.dispatchEvent(
        new window.CustomEvent(HERO_WORKSPACE_EVENT, {
          detail: id || "none",
        }),
      );
    },
  });
}

function SessionFileSidebar({ sessionId }) {
  const [state] = useSessionResource(
    `${apiRoot}/sessions/${encodeURIComponent(sessionId)}`,
  );
  return h(FileSidebarPanel, {
    workspaceId: state.rows[0]?.workspaceId,
    sessionLoading: state.loading,
    sessionError: state.error,
  });
}

function FileSidebar() {
  const routeSearch = navigation.useSearch();
  const params = new URLSearchParams(routeSearch);
  const sessionId = params.get("session");
  const sharedStarter =
    params.get("workagent") === "shared" &&
    params.get("personal") === "new" &&
    params.get("project");
  if (sharedStarter && !sessionId)
    return h(FileSidebarPanel, {
      key: `shared:${sharedStarter}`,
      workspaceId: `shared:${sharedStarter}`,
    });
  // A session route (including shared-project personal tasks) keeps the
  // conversation file sidebar; other workagent pages only need the bell.
  if (params.get("workagent") && !sessionId)
    return h(
      "div",
      { className: "workagent-top-actions" },
      h(TopNotificationButton),
    );
  return sessionId
    ? h(SessionFileSidebar, { key: sessionId, sessionId })
    : h(HomeFileSidebar);
}

export { FileSidebar };
