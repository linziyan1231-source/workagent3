import SettingsPageWrapper from "@renderer/pages/settings/components/SettingsPageWrapper";
import { useParams } from "react-router-dom";
import ExtensionSettingsTabContent from "../../aion-adapter/ExtensionSettingsTabContent.js";

/** Web 78 settings page chrome with WorkAgent3-native feature content. */
export function AionExtensionSettingsPage() {
  const { tabId = "" } = useParams<{ tabId: string }>();

  return (
    <SettingsPageWrapper>
      <ExtensionSettingsTabContent
        tabId={tabId}
        url={`workagent:${tabId}`}
        extensionName="workagent"
      />
    </SettingsPageWrapper>
  );
}
