import {
  BrandMark,
  BrandName,
  FooterAction,
  WorkAgentOverlay,
} from "./app/shell.js";
import { CollaborationSidebar } from "./app/sidebar.js";
import { ModelsSection } from "./features/agents/models.js";
import { AgentPicker } from "./features/agents/picker.js";
import { PresetsSection } from "./features/agents/settings.js";
import {
  TypographySettings,
  installTypography,
} from "./features/appearance/settings.js";
import { MCPSection, SkillsSection } from "./features/capabilities/settings.js";
import { HeroWorkspaceComposer } from "./features/conversations/home.js";
import {
  BusyEnterSettings,
  UploadSettings,
  bindConversationSettings,
} from "./features/conversations/preferences.js";
import { RuntimeServices } from "./features/conversations/runtime.js";
import { FileSidebar } from "./features/files/sidebar.js";
import { MarketplaceSection } from "./features/marketplace/page.js";
import { CompletionNotificationSettings } from "./features/notifications/page.js";
import { QuotaPanel } from "./features/quota/panel.js";
import { SystemSettings } from "./features/system/settings.js";
import { installHostCompatibility } from "./host/compatibility.js";
import { bindLayout, navigation } from "./host/navigation.js";
import { createElement as h } from "react";

const pluginScript = document.currentScript?.src;

const sections = [
  ["workagent-system", 40, "系统与帮助", SystemSettings],
  ["workagent-mcp", 30, "MCP 服务", MCPSection],
  ["workagent-skills", 31, "技能", SkillsSection],
  ["workagent-market", 32, "市场", MarketplaceSection],
  ["workagent-presets", 33, "助手", PresetsSection],
  ["workagent-models", 34, "模型", ModelsSection],
  [
    "workagent-completion-notifications",
    36,
    "消息提醒",
    CompletionNotificationSettings,
  ],
];

const inject = [
  "slots",
  "layout",
  "theme",
  "locale",
  "settingsScope",
  "sessions",
  "connection",
];

function apply(ctx) {
  bindLayout(ctx.layout);
  ctx.effect(() => navigation.install(), "workagent: in-page navigation");
  bindConversationSettings(
    ctx.settingsScope.bind({ namespace: "ui-conversation" }),
  );
  ctx.effect(
    () =>
      installHostCompatibility({
        navigate: navigation.navigate,
        pluginScript,
        applyTypography: installTypography,
      }),
    "workagent: host compatibility",
  );
  ctx.slots.inject("settings.general.item", () =>
    ctx.slots.register(
      {
        name: "settings.general.item",
        id: "workagent-upload-project",
        order: 15,
      },
      UploadSettings,
    ),
  );
  ctx.slots.inject("settings.general.item", () =>
    ctx.slots.register(
      {
        name: "settings.general.item",
        id: "composer-enter",
        order: 20,
        priority: -10,
      },
      BusyEnterSettings,
    ),
  );
  ctx.slots.inject("settings.general.item", () =>
    ctx.slots.register(
      {
        name: "settings.general.item",
        id: "permission",
        order: -20,
        priority: -10,
      },
      () => null,
    ),
  );
  ctx.slots.inject("settings.general.item", () =>
    ctx.slots.register(
      {
        name: "settings.general.item",
        id: "workagent-typography",
        order: 5,
      },
      TypographySettings,
    ),
  );
  const localeScope = ctx.settingsScope.bind({ namespace: "locale" });
  let localeWritePending = false;
  const initializeLocale = () => {
    const value = localeScope.getSnapshot().value;
    if (value?.preference === "zh") localeWritePending = false;
    else if (value !== undefined && !localeWritePending) {
      localeWritePending = true;
      ctx.locale.setLocale("zh");
    }
  };
  ctx.effect(() => {
    const unsubscribe = localeScope.subscribe(initializeLocale);
    initializeLocale();
    return unsubscribe;
  }, "workagent: Chinese interface language");
  ctx.slots.inject("settings.general.item", () =>
    ctx.slots.register(
      {
        name: "settings.general.item",
        id: "language",
        order: 0,
        priority: -10,
      },
      () => null,
    ),
  );
  ctx.slots.inject("sidebar.brand.mark", () =>
    ctx.slots.inject("sidebar.brand.name", function* () {
      yield ctx.slots.register({ name: "sidebar.brand.mark" }, BrandMark);
      yield ctx.slots.register({ name: "sidebar.brand.name" }, BrandName);
    }),
  );
  ctx.slots.inject("conversation.hero.brand.mark", () =>
    ctx.slots.register(
      {
        name: "conversation.hero.brand.mark",
        id: "workagent-hero-mark",
        order: 10,
      },
      BrandMark,
    ),
  );
  for (const [id, order, label, Component] of sections)
    ctx.slots.inject("settings.section", () =>
      ctx.slots.register(
        { name: "settings.section", id, order, label },
        Component,
      ),
    );
  ctx.slots.inject("settings.action", () =>
    ctx.slots.register(
      { name: "settings.action", id: "workagent-quota", order: 100 },
      QuotaPanel,
    ),
  );
  for (const [order, kind] of [
    "chatgpt",
    "tasks",
    "workspace",
    "theme",
    "logout",
  ].entries())
    ctx.slots.inject("sidebar.footer.action", () =>
      ctx.slots.register(
        {
          name: "sidebar.footer.action",
          id: `workagent-${kind}`,
          order: 100 + order,
        },
        (props) => h(FooterAction, { ...props, kind, theme: ctx.theme }),
      ),
    );
  ctx.slots.inject("conversation.hero.agentPreset", () =>
    ctx.slots.register(
      {
        name: "conversation.hero.agentPreset",
        id: "workagent-agent-picker",
        order: 10,
      },
      AgentPicker,
    ),
  );
  ctx.slots.inject("conversation.hero.workspace", () =>
    ctx.slots.register(
      {
        name: "conversation.hero.workspace",
        id: "workagent-workspace-composer",
        order: 20,
        priority: -10,
      },
      HeroWorkspaceComposer,
    ),
  );
  ctx.slots.inject("sidebar.workspaces", () =>
    ctx.slots.register(
      {
        name: "sidebar.workspaces",
        id: "workagent-sidebar-browser",
        order: 20,
        priority: -10,
      },
      CollaborationSidebar,
    ),
  );
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      { name: "shell.overlay", id: "workagent-page", order: 10 },
      (props) =>
        h(RuntimeServices.Provider, { value: ctx }, h(WorkAgentOverlay, props)),
    ),
  );
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      { name: "shell.overlay", id: "workagent-files", order: 20 },
      FileSidebar,
    ),
  );
}

export { inject, apply };
