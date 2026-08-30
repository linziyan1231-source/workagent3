import type { ComponentType, ReactNode } from "react";

declare const Layout: ComponentType<{
  sider: ReactNode;
  onSessionClick?: () => void;
}>;

export default Layout;
