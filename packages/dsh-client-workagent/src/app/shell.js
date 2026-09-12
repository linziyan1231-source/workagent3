import { sharedTaskProject } from "../features/collaboration/personal-tasks.js";
import { PresetsSection } from "../features/agents/settings.js";
import { AutomationsPage } from "../features/automations/page.js";
import { SharedPage } from "../features/collaboration/page.js";
import { RuntimeServices } from "../features/conversations/runtime.js";
import { ConversationWorkspace } from "../features/conversations/workspace.js";
import { MarketplaceSection } from "../features/marketplace/page.js";
import {
  NotificationFooter,
  NotificationsPage,
} from "../features/notifications/page.js";
import { WorkspacesPage } from "../features/projects/page.js";
import { CHAT_PAGE_KEY } from "../features/system/settings.js";
import { TeamsPage } from "../features/teams/page.js";
import { navigation } from "../host/navigation.js";
import { createConversationCache } from "../features/conversations/cache.js";
import { trackConversationScroll } from "../features/conversations/scroll.js";
import { sidebarState } from "../host/compatibility.js";
import { Icon } from "../ui/icons.js";
import { workbench } from "../features/content/index.js";
import React from "react";
import { createElement as h } from "react";

function BrandMark({ size = 28 }) {
  return h(
    "span",
    {
      className: "workagent-brand-mark",
      style: {
        width: size,
        height: size,
      },
    },
    h(
      "svg",
      {
        viewBox: "0 0 32 32",
        width: size,
        height: size,
        "aria-hidden": true,
      },
      h("path", {
        d: "M7.2 7.4 10.5 23h3.2L16 13.5 18.3 23h3.2l3.3-15.6h-3.3l-1.9 10-2.2-10h-2.8l-2.2 10-1.9-10Z",
        fill: "currentColor",
      }),
    ),
  );
}

function BrandName() {
  return h("strong", { className: "workagent-brand-name" }, "WorkAgent");
}

const pages = {
  shared: SharedPage,
  teams: TeamsPage,
  assistants: PresetsSection,
  automations: AutomationsPage,
  notifications: NotificationsPage,
  workspaces: WorkspacesPage,
  marketplace: MarketplaceSection,
};

function WorkAgentOverlay() {
  const routeSearch = navigation.useSearch();
  const ctx = React.useContext(RuntimeServices);
  const params = new URLSearchParams(routeSearch);
  const target = params.get("workagent");
  const sessionId = params.get("session");
  const personalDraft = sharedTaskProject(params);
  React.useEffect(() => {
    // Native views bind by ID and must not move the upstream session stage.
    // Returning home does clear the old stage so DSH displays its hero.
    if (!sessionId && (!target || personalDraft)) ctx?.sessions?.clear?.();
  }, [ctx, sessionId, target, personalDraft]);
  const Page = pages[target];
  const pageRef = React.useRef(null);
  React.useLayoutEffect(() => {
    // A session route renders the conversation, which tracks itself.
    if (!Page || sessionId || personalDraft) return;
    return trackConversationScroll(
      pageRef.current,
      sidebarState(),
      createConversationCache(1),
      target,
      false,
    );
  }, [Page, target, sessionId, personalDraft]);
  if (personalDraft || (!Page && !sessionId)) return null;
  const labels = {
    shared: "协作",
    teams: "AI 团队",
    assistants: "助手",
    automations: "定时任务",
    notifications: "通知",
    workspaces: "项目",
    marketplace: "市场",
  };
  const label = sessionId || !Page ? "会话" : labels[target];
  return h(
    "div",
    {
      role: "dialog",
      "aria-label": label,
      className: `workagent-overlay${target === "shared" && !sessionId ? " is-collaboration" : ""}`,
      ref: pageRef,
    },
    h(
      "header",
      { className: "workagent-overlay-header" },

      h("h1", null, label),
    ),
    h(
      "main",
      { className: "workagent-overlay-content" },
      sessionId
        ? h(ConversationWorkspace, { key: sessionId, sessionId })
        : h(Page, { key: target }),
    ),
  );
}

function FooterAction({ wide, kind, theme }) {
  if (kind === "notifications") return h(NotificationFooter, { wide });
  const navigate = (page) => () => navigation.navigate(`/?workagent=${page}`);
  const actions = {
    teams: ["AI 团队", navigate("teams")],
    shared: ["共享项目", navigate("shared")],
    assistants: ["助手", navigate("assistants")],
    tasks: ["定时任务", navigate("automations")],
    chatgpt: [
      "聊天模式",
      () => location.assign(localStorage.getItem(CHAT_PAGE_KEY) || "/chatgpt/"),
    ],
    workspace: ["项目", navigate("workspaces")],
    theme: [
      "主题",
      () => {
        const current = theme.getTheme();
        const next =
          (current.preference || current.resolved) === "dark"
            ? "light"
            : "dark";
        theme.setTheme(next);
      },
    ],
    logout: [
      "退出登录",
      async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        workbench.clearDrafts();
        location.assign("/");
      },
    ],
  };
  const [label, action] = actions[kind];
  return h(
    "button",
    {
      type: "button",
      className: "workagent-footer",
      "data-kind": kind,
      title: label,
      "aria-label": label,
      onClick: action,
    },
    h(Icon, { name: kind }),
    wide ? h("span", null, label) : null,
  );
}

export { BrandMark, BrandName, WorkAgentOverlay, FooterAction };
