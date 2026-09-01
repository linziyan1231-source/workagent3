import { useTranslation } from "react-i18next";
import type { IExtensionSettingsTab } from "./ipcBridge.js";

export function useExtensionSettingsTabs(): IExtensionSettingsTab[] {
  const { t } = useTranslation();
  return [
    {
      id: "workagent-channels",
      label: t("settings.channels.title", { defaultValue: "Channels" }),
      url: "workagent:channels",
      order: 0,
      extensionName: "workagent",
      position: { relativeTo: "system", placement: "before" as const },
    },
    {
      id: "workagent-skills",
      label: t("settings.skillsHub.title", { defaultValue: "Skills" }),
      url: "workagent:skills",
      order: 1,
      extensionName: "workagent",
      position: { relativeTo: "system", placement: "before" as const },
    },
    {
      id: "workagent-usage",
      label: t("settings.usage", { defaultValue: "Usage" }),
      url: "workagent:usage",
      order: 2,
      extensionName: "workagent",
      position: { relativeTo: "system", placement: "before" as const },
    },
    {
      id: "workagent-components",
      label: t("settings.components", { defaultValue: "Components" }),
      url: "workagent:components",
      order: 3,
      extensionName: "workagent",
      position: { relativeTo: "system", placement: "before" as const },
    },
    {
      id: "workagent-migration",
      label: t("settings.migration", { defaultValue: "Migration" }),
      url: "workagent:migration",
      order: 4,
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
