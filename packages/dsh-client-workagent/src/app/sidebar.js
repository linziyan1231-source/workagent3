import { SharedPage } from "../features/collaboration/page.js";
import { SidebarSessions } from "../features/conversations/sidebar.js";
import { TeamsPage } from "../features/teams/page.js";
import { navigation } from "../host/navigation.js";
import { Icon } from "../ui/icons.js";
import { Dialog, ActionList } from "../ui/dialog.js";
import {
  SidebarAction,
  SidebarGroup,
  SidebarHeader,
  SidebarRow,
  SidebarSearch,
  SidebarStatus,
} from "../ui/sidebar.js";
import React from "react";
import { createElement as h } from "react";

// Channel data stays in its package; its presentation uses these ordinary components.
const sidebarUI = {
  Row: SidebarRow,
  Group: SidebarGroup,
  Header: SidebarHeader,
  Action: SidebarAction,
  Search: SidebarSearch,
  Status: SidebarStatus,
  Dialog,
  ActionList,
};

const sidebarTabs = (() => {
  let tabs = [];
  const listeners = new Set();
  return {
    version: 1,
    officialTree: SidebarSessions,
    sessionFilters: [],
    getTabs: () => tabs,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    insert: (tab) => {
      tabs = [...tabs.filter((row) => row.id !== tab.id), tab].sort(
        (a, b) => (a.order || 0) - (b.order || 0),
      );
      listeners.forEach((listener) => listener());
      return () => {
        tabs = tabs.filter((row) => row !== tab);
        listeners.forEach((listener) => listener());
      };
    },
    addSessionFilter: () => () => {},
  };
})();

function CollaborationSidebar(props) {
  const search = navigation.useSearch();
  const state = SharedPage.useShared();
  const tabs = React.useSyncExternalStore(
    sidebarTabs.subscribe,
    sidebarTabs.getTabs,
  );
  const params = new URLSearchParams(search);
  const tab =
    params.get("workagent") === "shared"
      ? "shared"
      : params.get("sidebar") || "tasks";
  const count = state.invites.filter(
    (invite) => invite.status === "pending",
  ).length;
  const extra = tabs.find((item) => item.id === tab);
  return h(
    "div",
    { className: "workagent-sidebar-sections" },
    h(
      "nav",
      { className: "workagent-sidebar-tabs", "aria-label": "工作区分类" },
      ...[
        { id: "tasks", label: "任务" },
        ...tabs,
        { id: "shared", label: `协作${count ? ` ${count}` : ""}` },
      ].map((item) =>
        h(
          "button",
          {
            key: item.id,
            type: "button",
            "aria-current": tab === item.id ? "page" : undefined,
            onClick: () =>
              navigation.navigate(
                item.id === "shared"
                  ? SharedPage.route()
                  : `/?sidebar=${encodeURIComponent(item.id)}`,
              ),
          },
          item.label,
        ),
      ),
    ),
    tab === "shared"
      ? h(SharedPage.Sidebar)
      : extra
        ? extra.render({ ...props, sidebarUI })
        : h(SidebarSessions, props),
  );
}

CollaborationSidebar.__dshNativeTabHost = true;

CollaborationSidebar.__dshNativeTabs = sidebarTabs;

function CollaborationPage() {
  const [tab, setTab] = React.useState("shared");
  return h(
    "div",
    { className: "workagent-collaboration" },
    h(
      "nav",
      {
        className: "workagent-collaboration-tabs",
        "aria-label": "协作视图",
      },
      ...[
        ["shared", "共享项目"],
        ["teams", "智能体团队"],
      ].map(([id, label]) =>
        h(
          "button",
          {
            type: "button",
            key: id,
            "aria-pressed": tab === id,
            onClick: () => setTab(id),
          },
          h(Icon, { name: id }),
          label,
        ),
      ),
    ),
    h(
      "p",
      { className: "workagent-muted" },
      tab === "teams"
        ? "让多个助手分工完成任务。"
        : "与同事共享项目资料、文件和对话。",
    ),
    tab === "teams" ? h(TeamsPage) : h(SharedPage),
  );
}

export { CollaborationSidebar };
