import type { ReactNode } from "react";

export function useDeepLink() {}
export function useNotificationClick() {}
export function useBrowserNotification() {}
export function useConversationShortcuts(_options: unknown) {}
export function useDirectorySelection(): { contextHolder: ReactNode } {
  return { contextHolder: null };
}
