import { useTranslation } from "react-i18next";

export function useExtensionSettingsTabs() {
  const { t } = useTranslation();
  return [
    {
      id: "workagent-usage",
      label: t("settings.usage", { defaultValue: "Usage" }),
      url: "workagent:usage",
      order: 0,
      extensionName: "workagent",
      position: { relativeTo: "system", placement: "before" as const },
    },
  ];
}
export function useExtI18n() {
  return {
    resolveExtTabName: (tab: { id: string; label?: string }) =>
      tab.label ?? tab.id,
  };
}
