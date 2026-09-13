import React from "react";
import { createRoot } from "react-dom/client";
import { FeedbackForm } from "../../packages/dsh-client-workagent/src/features/system/feedback.js";
import { PublishedAppsSection } from "../../packages/dsh-client-workagent/src/features/apps/settings.js";
import { AcpCredentials } from "../../packages/dsh-client-workagent/src/features/agents/acp.js";
import { AcpCatalog } from "../../apps/web/src/features/admin/acp/AcpCatalog.tsx";
import { FeedbackInbox } from "../../apps/web/src/features/admin/feedback/FeedbackInbox.tsx";
import { TeamsPage } from "../../packages/dsh-client-workagent/src/features/teams/page.js";
import { createAutomations } from "../../packages/dsh-client-workagent/src/features/automations/automations.js";
import {
  apiRoot,
  request,
} from "../../packages/dsh-client-workagent/src/platform/api.js";
import { useResource } from "../../packages/dsh-client-workagent/src/platform/resources.js";
import { usePresets } from "../../packages/dsh-client-workagent/src/features/agents/api.js";
import { friendlyError } from "../../packages/dsh-client-workagent/src/ui/labels.js";
import * as elements from "../../packages/dsh-client-workagent/src/ui/elements.js";

const Automations = createAutomations({
  React,
  request,
  apiRoot,
  useResource,
  usePresets,
  friendlyError,
  ...elements,
});
const options = new URLSearchParams(location.search);
const font = options.get("font") || "13";
document.documentElement.dataset.workagentFontSize = font;
document.documentElement.dataset.theme = options.get("theme") || "light";
document.documentElement.style.setProperty(
  "--workagent-font-scale",
  String(Number(font) / 14),
);
const screen = options.get("screen") || "feedback";
const Component = {
  feedback: FeedbackForm,
  acp: AcpCredentials,
  "acp-admin": AcpCatalog,
  "feedback-admin": FeedbackInbox,
  teams: TeamsPage,
  once: Automations,
  apps: PublishedAppsSection,
}[screen];
createRoot(document.getElementById("root")).render(
  <main
    className={screen.endsWith("admin") ? "admin-main" : "workagent-fixture"}
  >
    <p className="fixture-label">隔离浏览器验收 · 本地模拟接口 · {screen}</p>
    <Component />
  </main>,
);
