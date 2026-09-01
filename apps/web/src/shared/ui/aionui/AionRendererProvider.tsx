import { type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import { ConfigProvider } from "@arco-design/web-react";
import { LayoutContext } from "@renderer/hooks/context/LayoutContext";
import { ThemeProvider } from "@renderer/hooks/context/ThemeContext";
import { PreviewProvider } from "@renderer/pages/conversation/Preview/context/PreviewContext";

/** WorkAgent3 host adapter for the unmodified AionUi Renderer context. */
export function AionRendererProvider({ children }: { children: ReactNode }) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  const [siderCollapsed, setSiderCollapsed] = useState(isMobile);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

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
        <PreviewProvider>
          <LayoutContext.Provider
            value={{ isMobile, siderCollapsed, setSiderCollapsed }}
          >
            {children}
          </LayoutContext.Provider>
        </PreviewProvider>
      </ThemeProvider>
    </ConfigProvider>
  );
}
