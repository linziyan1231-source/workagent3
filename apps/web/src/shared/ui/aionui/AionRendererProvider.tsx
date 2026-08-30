import { type ReactNode, useEffect, useState } from "react";
import { LayoutContext } from "@renderer/hooks/context/LayoutContext";

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

  return (
    <LayoutContext.Provider
      value={{ isMobile, siderCollapsed, setSiderCollapsed }}
    >
      {children}
    </LayoutContext.Provider>
  );
}
