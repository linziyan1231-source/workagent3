import type { PropsWithChildren } from "react";

export function NavigationHistoryProvider({ children }: PropsWithChildren) {
  return children;
}

export function useNavigationHistory() {
  return undefined;
}
