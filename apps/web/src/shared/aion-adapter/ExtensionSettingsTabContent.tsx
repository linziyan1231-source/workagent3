import QuotaSettingsContent from "../../features/quota/QuotaSettingsContent.js";

type Props = {
  url: string;
  tabId: string;
  extensionName: string;
};

export default function ExtensionSettingsTabContent({ tabId }: Props) {
  if (tabId === "workagent-usage") return <QuotaSettingsContent />;
  return null;
}
