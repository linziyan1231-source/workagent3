import QuotaSettingsContent from "../../features/quota/QuotaSettingsContent.js";
import MigrationSettingsContent from "../../features/migration/MigrationSettingsContent.js";
import SkillsHubSettings from "@renderer/pages/settings/SkillsHubSettings";
import ChannelModalContent from "@renderer/components/settings/SettingsModal/contents/channels/ChannelModalContent";

type Props = {
  url: string;
  tabId: string;
  extensionName: string;
};

export default function ExtensionSettingsTabContent({ tabId }: Props) {
  if (tabId === "workagent-channels") return <ChannelModalContent />;
  if (tabId === "workagent-skills")
    return <SkillsHubSettings withWrapper={false} />;
  if (tabId === "workagent-usage") return <QuotaSettingsContent />;
  if (tabId === "workagent-migration") return <MigrationSettingsContent />;
  return null;
}
