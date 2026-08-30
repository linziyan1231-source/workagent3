import QuotaSettingsContent from "../../features/quota/QuotaSettingsContent.js";
import MigrationSettingsContent from "../../features/migration/MigrationSettingsContent.js";
import SkillsHubSettings from "@renderer/pages/settings/SkillsHubSettings";

type Props = {
  url: string;
  tabId: string;
  extensionName: string;
};

export default function ExtensionSettingsTabContent({ tabId }: Props) {
  if (tabId === "workagent-skills")
    return <SkillsHubSettings withWrapper={false} />;
  if (tabId === "workagent-usage") return <QuotaSettingsContent />;
  if (tabId === "workagent-migration") return <MigrationSettingsContent />;
  return null;
}
