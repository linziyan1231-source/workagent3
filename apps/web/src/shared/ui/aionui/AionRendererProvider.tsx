import { useLayoutEffect, type ReactNode } from "react";
import { ConfigProvider } from "@arco-design/web-react";
import { ThemeProvider } from "@renderer/hooks/context/ThemeContext";
import { PreviewProvider } from "@renderer/pages/conversation/Preview/context/PreviewContext";

/**
 * WorkAgent3 host adapter for the unmodified AionUi Renderer context.
 *
 * LayoutContext (isMobile/siderCollapsed) is intentionally NOT provided here:
 * the formal Renderer Layout owns the single authoritative mobile/viewport
 * determination and provides the context for the routed tree; nothing outside
 * Layout consumes it.
 */
export function AionRendererProvider({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.colorScheme = "default";
    document.documentElement.style.setProperty("--chat-font-size", "14px");
    document.documentElement.style.setProperty("--md-font-size", "13px");
    document.documentElement.style.setProperty("--code-font-size", "12px");
    document.body.setAttribute("arco-theme", "light");
  }, []);

  return (
    <ConfigProvider theme={{ primaryColor: "#4E5969" }}>
      <ThemeProvider>
        <PreviewProvider>{children}</PreviewProvider>
      </ThemeProvider>
    </ConfigProvider>
  );
}
