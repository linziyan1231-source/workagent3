import { useTranslation } from "react-i18next";
import type { IExtensionSettingsTab } from "./ipcBridge.js";

export function useExtensionSettingsTabs(): IExtensionSettingsTab[] {
  const { t } = useTranslation();
  return [
    {
      id: "workagent-skills",
      label: t("settings.skillsHub.title", { defaultValue: "Skills" }),
      url: "workagent:skills",
      order: 0,
      extensionName: "workagent",
      position: { relativeTo: "system", placement: "before" as const },
    },
    {
      id: "workagent-usage",
      label: t("settings.usage", { defaultValue: "Usage" }),
      url: "workagent:usage",
      order: 1,
      extensionName: "workagent",
      position: { relativeTo: "system", placement: "before" as const },
    },
  ];
}
export function useExtI18n() {
  return {
    resolveExtTabName: (tab: IExtensionSettingsTab) => tab.label,
  };
}
