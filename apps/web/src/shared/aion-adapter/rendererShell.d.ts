import type { ReactElement, ReactNode } from "react";

declare module "@renderer/components/layout/Router" {
  export default function Router(props: { layout: ReactElement }): ReactElement;
}

declare module "@renderer/components/layout/Sider" {
  export default function Sider(): ReactElement;
}

declare module "@renderer/components/layout/PortalNotificationHost" {
  export default function PortalNotificationHost(): ReactElement | null;
}

declare module "@renderer/hooks/context/ConversationHistoryContext" {
  export function ConversationHistoryProvider(props: {
    children: ReactNode;
  }): ReactElement;
}
