export function useExtensionSettingsTabs() {
  return [];
}
export function useExtI18n() {
  return { resolveExtTabName: (tab: { id: string }) => tab.id };
}
