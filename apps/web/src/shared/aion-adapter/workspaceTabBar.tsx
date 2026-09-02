// Browser host adapter for the workspace tab bar.
//
// The upstream "changes" tab is backed by the desktop fileSnapshot/branch
// service. WorkAgent3 v1 deliberately does not copy that snapshot API
// (plan.md P2: workspaces that need version control use Git/Harness tooling),
// so the browser build only offers the files tab; the desktop component keeps
// both tabs. Visual structure (tabs bar, files pane title) is unchanged.
import { Tabs } from "@arco-design/web-react";
import type { TFunction } from "i18next";
import type React from "react";

type WorkspaceTabBarProps = {
  t: TFunction;
  activeTab: "files" | "changes";
  onTabChange: (tab: "files" | "changes") => void;
  changeCount: number;
  branch: string | null;
};

const WorkspaceTabBar: React.FC<WorkspaceTabBarProps> = ({
  t,
  activeTab,
  onTabChange,
}) => (
  <Tabs
    activeTab={activeTab}
    onChange={(key) => onTabChange(key as "files" | "changes")}
    type="line"
    size="small"
    className="px-12px [&_.arco-tabs-nav]:border-b-0 [&_.arco-tabs-header-title]:!mr-8px"
  >
    <Tabs.TabPane
      key="files"
      title={t("conversation.workspace.changes.filesTab")}
    />
  </Tabs>
);

export default WorkspaceTabBar;
