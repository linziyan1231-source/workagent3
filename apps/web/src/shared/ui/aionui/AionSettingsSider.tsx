import SettingsSider from "@renderer/pages/settings/components/SettingsSider";
import SiderFooter from "@renderer/components/layout/Sider/SiderFooter";
import { useLayoutContext } from "@renderer/hooks/context/LayoutContext";
import { useThemeContext } from "@renderer/hooks/context/ThemeContext";
import { getSiderTooltipProps } from "@renderer/utils/ui/siderTooltip";
import { useNavigate } from "react-router-dom";

/**
 * Route-mode settings sidebar from the managed WorkAgent2 Web 78 Renderer.
 * Only the return-to-chat and logout actions cross the WorkAgent3 boundary.
 */
export function AionSettingsSider({
  onLogout,
}: {
  onLogout: () => Promise<void>;
}) {
  const layout = useLayoutContext();
  const { theme, setTheme } = useThemeContext();
  const navigate = useNavigate();
  const isMobile = layout?.isMobile ?? false;

  return (
    <div className="size-full flex flex-col">
      <div className="flex-1 min-h-0 overflow-hidden">
        <SettingsSider
          collapsed={false}
          tooltipEnabled={false}
          hiddenBuiltinIds={["webui"]}
        />
      </div>
      <SiderFooter
        isMobile={isMobile}
        isSettings
        collapsed={false}
        theme={theme}
        siderTooltipProps={getSiderTooltipProps(false)}
        onSettingsClick={() => navigate("/guid")}
        onThemeToggle={() => void setTheme(theme === "dark" ? "light" : "dark")}
        showLogout
        onLogoutClick={onLogout}
      />
    </div>
  );
}
