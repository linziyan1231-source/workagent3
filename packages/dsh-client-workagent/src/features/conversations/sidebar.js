import { workbench } from "../content/index.js";
import { closeMobileSidebar, navigation } from "../../host/navigation.js";
import { apiRoot, request } from "../../platform/api.js";
import { useResource } from "../../platform/resources.js";
import { sortProjectsByChat } from "../collaboration/shared.js";
import { SessionAvatar } from "../agents/avatar-components.js";
import { Button, Input } from "../../ui/elements.js";
import { Icon } from "../../ui/icons.js";
import { Dialog, ActionList, useConfirm } from "../../ui/dialog.js";
import {
  ConversationMenu,
  ConversationManagementDialog,
} from "../../ui/conversation-management.js";
import {
  SidebarAction,
  SidebarGroup,
  SidebarHeader,
  SidebarRow,
  SidebarSearch,
  SidebarStatus,
} from "../../ui/sidebar.js";
import {
  displaySessionTitle,
  displayWorkspaceName,
  friendlyError,
} from "../../ui/labels.js";
import {
  HERO_WORKSPACE_EVENT,
  PROJECTS_CHANGED_EVENT,
  WORKSPACE_PICK_KEY,
  announceProjectsChanged,
  startProjectConversation,
} from "../projects/state.js";
import { SESSIONS_CHANGED_EVENT, SESSION_SEEN_PREFIX } from "./state.js";
import React from "react";
import { createElement as h } from "react";

function SidebarSessions() {
  const { confirm, confirmation } = useConfirm();
  const routeSearch = navigation.useSearch();
  const [workspaceState, reloadWorkspaces] = useResource(
    `${apiRoot}/workspaces`,
  );
  const [sessionState, reloadSessions] = useResource(
    `${apiRoot}/sessions`,
    (value) =>
      (Array.isArray(value) ? value : [])
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  );
  const [teamState, reloadTeams] = useResource(`${apiRoot}/teams`);
  const pins = workbench.usePins();
  const projectPins = workbench.usePins("workagent.project-pins.v1");
  const [batchMode, setBatchMode] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState([]);
  const [batchBusy, setBatchBusy] = React.useState(false);
  const [batchError, setBatchError] = React.useState("");
  async function deleteSelected() {
    if (
      !selectedIds.length ||
      !(await confirm(`删除选中的 ${selectedIds.length} 个对话及消息？`))
    )
      return;
    setBatchBusy(true);
    const failed = [];
    for (const id of selectedIds) {
      try {
        await request(`${apiRoot}/sessions/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
      } catch (reason) {
        failed.push({ id, error: friendlyError(reason.message) });
      }
    }
    setSelectedIds(failed.map((item) => item.id));
    setBatchError(
      failed.length
        ? failed
            .map(
              (item) =>
                `${sessionState.rows.find((row) => row.id === item.id)?.title || item.id}：${item.error}`,
            )
            .join("；")
        : "",
    );
    setBatchBusy(false);
    reloadSessions();
    if (
      selectedIds.includes(activeSession) &&
      !failed.some((item) => item.id === activeSession)
    )
      navigation.navigate("/?frontend=dsh");
  }
  const [query, setQuery] = React.useState("");
  const [searching, setSearching] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState({});
  const [sectionsCollapsed, setSectionsCollapsed] = React.useState(() => ({
    projects:
      localStorage.getItem("workagent.sidebar.projects-collapsed") === "true",
    sessions:
      localStorage.getItem("workagent.sidebar.sessions-collapsed") === "true",
  }));
  const sectionToggle = (section, label) =>
    h(
      "button",
      {
        type: "button",
        className: "workagent-sidebar-section-toggle",
        "aria-label": `${sectionsCollapsed[section] ? "展开" : "收起"}${label}`,
        "aria-expanded": !sectionsCollapsed[section],
        onClick: () => {
          const next = !sectionsCollapsed[section];
          localStorage.setItem(
            `workagent.sidebar.${section}-collapsed`,
            String(next),
          );
          setSectionsCollapsed((value) => ({ ...value, [section]: next }));
          if (section === "projects" && next) {
            setSearching(false);
            setQuery("");
          }
        },
      },
      h(Icon, {
        name: sectionsCollapsed[section] ? "chevronRight" : "chevronDown",
        size: 13,
      }),
      h("span", null, label),
    );
  const [action, setAction] = React.useState(null);
  const [actionBusy, setActionBusy] = React.useState(false);
  const [sessionMenu, setSessionMenu] = React.useState(null);
  const [projectMenu, setProjectMenu] = React.useState(null);
  const [reminderSession, setReminderSession] = React.useState(null);
  const [actionValue, setActionValue] = React.useState("");
  const [error, setError] = React.useState("");
  const activeSession = new URLSearchParams(routeSearch).get("session");
  React.useEffect(() => {
    const closeOnEscape = (event) => {
      if (
        event.key === "Escape" &&
        window.innerWidth <= 760 &&
        !document.querySelector('[role="dialog"]')
      )
        closeMobileSidebar();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);
  const [, setSeenRevision] = React.useState(0);
  const openedSession = React.useRef(null);
  const markSeen = (session) => {
    if (session.lastTurn)
      localStorage.setItem(
        SESSION_SEEN_PREFIX + session.id,
        session.lastTurn.id,
      );
    setSeenRevision((value) => value + 1);
  };
  React.useEffect(() => {
    const session = sessionState.rows.find((item) => item.id === activeSession);
    if (!session || openedSession.current === activeSession) return;
    openedSession.current = activeSession;
    markSeen(session);
  }, [sessionState.rows, activeSession]);
  React.useEffect(() => {
    let disposed = false;
    let timer;
    let pending = false;
    let rerun = false;
    const update = async () => {
      clearTimeout(timer);
      if (disposed) return;
      if (pending) {
        rerun = true;
        return;
      }
      pending = true;
      try {
        await reloadSessions();
      } finally {
        pending = false;
        if (!disposed) {
          timer = setTimeout(update, rerun ? 0 : 2500);
          rerun = false;
        }
      }
    };
    const syncSeen = (event) => {
      if (event.key === null || event.key?.startsWith(SESSION_SEEN_PREFIX))
        setSeenRevision((value) => value + 1);
    };
    timer = setTimeout(update, 2500);
    window.addEventListener(SESSIONS_CHANGED_EVENT, update);
    window.addEventListener("focus", update);
    window.addEventListener("storage", syncSeen);
    document.addEventListener("visibilitychange", update);
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener(SESSIONS_CHANGED_EVENT, update);
      window.removeEventListener("focus", update);
      window.removeEventListener("storage", syncSeen);
      document.removeEventListener("visibilitychange", update);
    };
  }, [reloadSessions]);
  React.useEffect(() => {
    const update = () => void reloadWorkspaces();
    window.addEventListener(PROJECTS_CHANGED_EVENT, update);
    return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, update);
  }, [reloadWorkspaces]);
  const sessions = sessionState.rows
    .filter(
      (session) =>
        session.branchKind !== "side_chat" &&
        !session.workspaceId?.startsWith("shared:"),
    )
    .slice()
    .sort((a, b) => {
      const left = pins.pins.indexOf(a.id),
        right = pins.pins.indexOf(b.id);
      return (left < 0 ? Infinity : left) - (right < 0 ? Infinity : right);
    })
    .filter(
      (session) =>
        !/^Reply exactly with legacy-message-\d+$/i.test(session.title),
    )
    .filter((session) =>
      displaySessionTitle(session.title)
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    );
  const selectProject = (project) => {
    localStorage.setItem(WORKSPACE_PICK_KEY, project.id);
    window.dispatchEvent(
      new window.CustomEvent(HERO_WORKSPACE_EVENT, {
        detail: project.id,
      }),
    );
  };
  const toggleSearch = () => {
    if (searching) setQuery("");
    setSearching(!searching);
  };
  const beginAction = (kind, target) => {
    setAction({ kind, target });
    setActionValue(
      kind === "rename-project"
        ? displayWorkspaceName(target.name)
        : kind === "rename-session"
          ? displaySessionTitle(target.title)
          : "",
    );
    setError("");
  };
  const submitAction = async (event) => {
    event.preventDefault();
    if (!action || actionBusy) return;
    setActionBusy(true);
    try {
      if (action.kind === "rename-project") {
        await request(
          `${apiRoot}/workspaces/${encodeURIComponent(action.target.id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ name: actionValue.trim() }),
          },
        );
        await reloadWorkspaces();
        announceProjectsChanged();
      } else if (action.kind === "rename-session") {
        await request(
          `${apiRoot}/sessions/${encodeURIComponent(action.target.id)}`,
          {
            method: "PATCH",
            body: JSON.stringify({ title: actionValue.trim() }),
          },
        );
        await reloadSessions();
      } else if (action.kind === "delete-session") {
        await request(
          `${apiRoot}/sessions/${encodeURIComponent(action.target.id)}`,
          { method: "DELETE" },
        );
        await reloadSessions();
        if (activeSession === action.target.id)
          navigation.navigate("/?frontend=dsh");
      } else if (action.kind === "delete-project") {
        const relatedSessions = sessionState.rows.filter(
          (session) => session.workspaceId === action.target.id,
        );
        const relatedTeams = teamState.rows.filter(
          (team) => team.workspaceId === action.target.id,
        );
        await Promise.all(
          relatedSessions.map((session) =>
            request(`${apiRoot}/sessions/${encodeURIComponent(session.id)}`, {
              method: "DELETE",
            }),
          ),
        );
        await Promise.all(
          relatedTeams.map((team) =>
            request(`${apiRoot}/teams/${encodeURIComponent(team.id)}`, {
              method: "DELETE",
            }),
          ),
        );
        await request(
          `${apiRoot}/workspaces/${encodeURIComponent(action.target.id)}`,
          { method: "DELETE" },
        );
        await Promise.all([
          reloadWorkspaces(),
          reloadSessions(),
          reloadTeams(),
        ]);
        announceProjectsChanged();
        if (relatedSessions.some((session) => session.id === activeSession))
          navigation.navigate("/?frontend=dsh");
      }
      setAction(null);
    } catch (cause) {
      setError(friendlyError(cause.message));
    } finally {
      setActionBusy(false);
    }
  };
  const projectRows = sortProjectsByChat(
    workspaceState.rows,
    sessionState.rows,
    projectPins.pins,
  );
  const projectIds = new Set(projectRows.map((project) => project.id));
  const unassignedSessions = sessions.filter(
    (session) => !projectIds.has(session.workspaceId),
  );
  const renderSession = (session) => {
    const running = ["running", "retrying"].includes(session.activity?.state);
    const unread =
      session.lastTurn &&
      localStorage.getItem(SESSION_SEEN_PREFIX + session.id) !==
        session.lastTurn.id;
    const status = running
      ? "正在运行"
      : unread
        ? session.lastTurn.status === "failed"
          ? "运行失败，未读"
          : session.lastTurn.status === "cancelled"
            ? "已停止，未读"
            : "已完成，未读"
        : "";
    return h(SidebarRow, {
      key: session.id,
      title: displaySessionTitle(session.title),
      icon: h(SessionAvatar, { session }),
      selected: session.id === activeSession,
      status: h(SidebarStatus, { running, unread, label: status }),
      onOpen: () => {
        markSeen(session);
        navigation.navigate(`/?session=${encodeURIComponent(session.id)}`);
      },
      rowProps: {
        draggable: pins.pins.includes(session.id),
        onDragStart: (event) =>
          event.dataTransfer.setData("text/workagent-session", session.id),
        onDragOver: (event) => {
          if (pins.pins.includes(session.id)) event.preventDefault();
        },
        onDrop: (event) => {
          event.preventDefault();
          pins.move(
            event.dataTransfer.getData("text/workagent-session"),
            session.id,
          );
        },
      },
      leading: batchMode
        ? h("input", {
            type: "checkbox",
            "aria-label": `选择对话 ${displaySessionTitle(session.title)}`,
            checked: selectedIds.includes(session.id),
            disabled: batchBusy,
            onChange: (event) =>
              setSelectedIds((ids) =>
                event.target.checked
                  ? [...ids, session.id]
                  : ids.filter((id) => id !== session.id),
              ),
          })
        : null,
      actions: h(
        React.Fragment,
        null,
        h(SidebarAction, {
          icon: "pin",
          label: `${pins.pins.includes(session.id) ? "取消置顶" : "置顶"} ${displaySessionTitle(session.title)}`,
          "aria-pressed": pins.pins.includes(session.id),
          onClick: () => pins.toggle(session.id),
        }),
        h(SidebarAction, {
          label: `编辑对话 ${displaySessionTitle(session.title)}`,
          title: "对话操作",
          "aria-haspopup": "dialog",
          onClick: () => setSessionMenu(session),
        }),
      ),
    });
  };
  return h(
    "div",
    { className: "workagent-sidebar-browser" },
    confirmation,
    h(workbench.Notifications, {
      sessions: sessionState.rows,
      settings: false,
    }),
    h("button", {
      type: "button",
      className: "workagent-mobile-backdrop",
      "aria-label": "收起导航菜单",
      tabIndex: -1,
      onClick: closeMobileSidebar,
    }),
    h(
      SidebarHeader,
      { heading: sectionToggle("projects", "项目") },
      h(
        "div",
        { className: "workagent-batch-actions" },
        h(
          Button,
          {
            disabled: batchBusy,
            "aria-label": batchMode ? "结束多选" : "多选对话",
            title: batchMode ? "结束多选" : "多选对话",
            "aria-pressed": batchMode,
            onClick: () => {
              setBatchMode((value) => !value);
              setSelectedIds([]);
              setBatchError("");
            },
          },
          h(Icon, { name: batchMode ? "close" : "list", size: 15 }),
        ),
        batchMode
          ? h(
              React.Fragment,
              null,
              h(
                Button,
                {
                  disabled: batchBusy,
                  onClick: () => setSelectedIds(sessions.map((row) => row.id)),
                },
                "全选当前列表",
              ),
              h(
                Button,
                {
                  disabled: batchBusy || !selectedIds.length,
                  onClick: deleteSelected,
                },
                batchBusy ? "删除中…" : `删除选中（${selectedIds.length}）`,
              ),
            )
          : null,
        batchError
          ? h("p", { role: "alert", className: "workagent-error" }, batchError)
          : null,
      ),

      sectionsCollapsed.projects
        ? null
        : h(
            "div",
            { className: "workagent-sidebar-heading-actions" },
            h(
              "button",
              {
                type: "button",
                "aria-label": searching ? "关闭搜索" : "搜索对话",
                title: searching ? "关闭搜索" : "搜索对话",
                "aria-pressed": searching,
                onClick: toggleSearch,
              },
              h(Icon, { name: searching ? "close" : "search", size: 15 }),
            ),
            h(
              "button",
              {
                type: "button",
                "aria-label": "管理项目",
                title: "管理项目",
                onClick: () => navigation.navigate("/?workagent=workspaces"),
              },
              h(Icon, { name: "plus", size: 15 }),
            ),
          ),
    ),
    searching
      ? h(SidebarSearch, {
          "aria-label": "搜索对话",
          value: query,
          onChange: (event) => setQuery(event.target.value),
          placeholder: "搜索对话…",
          autoFocus: true,
        })
      : null,
    h(
      "div",
      { className: "workagent-sidebar-projects" },
      workspaceState.loading && !sectionsCollapsed.projects
        ? h("span", { className: "workagent-sidebar-empty" }, "加载中…")
        : null,
      ...(sectionsCollapsed.projects ? [] : projectRows).map((project) => {
        const projectSessions = sessions.filter(
          (session) => session.workspaceId === project.id,
        );
        const isCollapsed = Boolean(collapsed[project.id]);
        return h(
          SidebarGroup,
          {
            key: project.id,
            title: displayWorkspaceName(project.name),
            icon: h(Icon, { name: "workspace", size: 15 }),
            expanded: !isCollapsed,
            onToggle: () => {
              selectProject(project);
              setCollapsed((value) => ({
                ...value,
                [project.id]: !value[project.id],
              }));
            },
            pinned: projectPins.pins.includes(project.id),
            badge: project.scope === "team" ? h("small", null, "共享") : null,
            actions: h(
              React.Fragment,
              null,
              h(SidebarAction, {
                icon: "plus",
                label: `在 ${displayWorkspaceName(project.name)} 中新建会话`,
                title: "在此项目中新建会话",
                onClick: () => startProjectConversation(project),
              }),
              h(SidebarAction, {
                label: `项目操作 ${displayWorkspaceName(project.name)}`,
                "aria-haspopup": "dialog",
                title: "置顶或管理项目",
                onClick: () => setProjectMenu(project),
              }),
            ),
          },
          projectSessions.length === 0
            ? h(
                "span",
                { className: "workagent-sidebar-empty" },
                query ? "没有匹配的对话" : "暂无对话",
              )
            : projectSessions.map(renderSession),
        );
      }),
      h(
        "section",
        { className: "workagent-sidebar-unassigned" },
        h(
          "div",
          { className: "workagent-sidebar-subheading" },
          sectionToggle("sessions", "对话"),
        ),
        sectionsCollapsed.sessions
          ? null
          : h(
              "div",
              {
                className:
                  "workagent-sidebar-project-sessions workagent-sidebar-standalone",
              },
              ...unassignedSessions.map(renderSession),
            ),
      ),
    ),
    sessionState.loading && !sectionsCollapsed.sessions
      ? h("span", { className: "workagent-sidebar-empty" }, "加载中…")
      : null,
    error && !action?.kind.endsWith("-session")
      ? h("span", { role: "alert", className: "workagent-error" }, error)
      : null,
    sessionMenu
      ? h(ConversationMenu, {
          title: displaySessionTitle(sessionMenu.title),
          projectName: displayWorkspaceName(
            workspaceState.rows.find(
              (workspace) => workspace.id === sessionMenu.workspaceId,
            )?.name || "未归属",
          ),
          pinned: pins.pins.includes(sessionMenu.id),
          onPin: () => {
            pins.toggle(sessionMenu.id);
            setSessionMenu(null);
          },
          onReminder: () => {
            setReminderSession(sessionMenu);
            setSessionMenu(null);
          },
          onManage: () => {
            const target = sessionMenu;
            setSessionMenu(null);
            beginAction("rename-session", target);
          },
          onClose: () => setSessionMenu(null),
        })
      : null,
    projectMenu
      ? h(
          Dialog,
          {
            title: displayWorkspaceName(projectMenu.name),
            "aria-label": "项目操作",
            onClose: () => setProjectMenu(null),
          },
          h(
            ActionList,
            null,
            h(
              Button,
              {
                onClick: () => {
                  projectPins.toggle(projectMenu.id);
                  setProjectMenu(null);
                },
              },
              h(Icon, { name: "pin" }),
              projectPins.pins.includes(projectMenu.id)
                ? "取消置顶"
                : "置顶项目",
            ),
            h(
              Button,
              {
                onClick: () => {
                  const target = projectMenu;
                  setProjectMenu(null);
                  beginAction("rename-project", target);
                },
              },
              h(Icon, { name: "edit" }),
              "管理",
            ),
          ),
        )
      : null,
    reminderSession
      ? h(
          Dialog,
          { title: "消息提醒", onClose: () => setReminderSession(null) },
          h(
            "small",
            null,
            `项目：${displayWorkspaceName(workspaceState.rows.find((workspace) => workspace.id === reminderSession.workspaceId)?.name || "未归属")} · 对话：${displaySessionTitle(reminderSession.title)}`,
          ),
          h(workbench.SessionReminder, {
            sessionId: reminderSession.id,
            onSaved: () => setReminderSession(null),
          }),
        )
      : null,
    action?.kind.endsWith("-session")
      ? h(ConversationManagementDialog, {
          name: actionValue,
          onNameChange: setActionValue,
          onSave: submitAction,
          onDelete: submitAction,
          onRequestDelete: () => beginAction("delete-session", action.target),
          onClose: () => setAction(null),
          busy: actionBusy,
          error,
          deleting: action.kind === "delete-session",
        })
      : action
        ? h(
            Dialog,
            {
              title: action.kind.startsWith("rename") ? "重命名" : "确认删除",
              as: "form",
              onClose: () => setAction(null),
              onSubmit: submitAction,
            },
            action.kind.startsWith("rename")
              ? h(Input, {
                  autoFocus: true,
                  value: actionValue,
                  onChange: (event) => setActionValue(event.target.value),
                  required: true,
                  maxLength: 120,
                })
              : h(
                  "p",
                  null,
                  action.kind === "delete-project"
                    ? "项目及其对话将移入可恢复的回收目录。"
                    : "删除后，这个对话将不再显示。",
                ),
            h(
              "div",
              { className: "workagent-actions" },
              h(
                Button,
                {
                  type: "submit",
                  disabled:
                    action.kind.startsWith("rename") && !actionValue.trim(),
                },
                action.kind.startsWith("rename") ? "保存" : "删除",
              ),
              action.kind.startsWith("rename")
                ? h(
                    Button,
                    {
                      className: "workagent-button is-danger",
                      onClick: () =>
                        beginAction(
                          action.kind === "rename-project"
                            ? "delete-project"
                            : "delete-session",
                          action.target,
                        ),
                    },
                    "删除",
                  )
                : null,
              h(Button, { onClick: () => setAction(null) }, "取消"),
            ),
          )
        : null,
  );
}

export { SidebarSessions };
