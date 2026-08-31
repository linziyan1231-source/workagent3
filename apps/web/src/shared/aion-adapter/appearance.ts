import {
  FONT_SIZE_KEYS,
  clampFontSize,
  defaultFontSizes,
  fontSizeConfigKey,
} from "@/common/config/fontSizes";
import { LIGHT_THEME_ID } from "@/common/theme/constants";
import { resolveActiveTheme } from "@/common/theme/resolveTheme";
import type { Theme } from "@/common/theme/types";
import { BUILTIN_THEMES } from "@renderer/theme/builtinThemes";
import { applyFontSizes } from "@renderer/utils/theme/applyFontSizes";
import { applyTheme } from "@renderer/utils/theme/applyTheme";
import { getSystemPrefersDark } from "@renderer/utils/theme/systemAppearance";
import { ipcBridge } from "./common.js";
import { configService } from "./configService.js";

export async function hydrateRendererAppearance(): Promise<void> {
  await configService.reload();
  const activeId = configService.get("theme.activeId") ?? LIGHT_THEME_ID;
  const userThemes = configService.get("theme.userThemes") ?? [];
  const theme = resolveActiveTheme(
    activeId,
    [...BUILTIN_THEMES, ...(userThemes as Theme[])],
    getSystemPrefersDark(),
  );
  applyTheme(theme);
  await ipcBridge.theme.setActive.invoke(theme);

  const sizes = defaultFontSizes();
  for (const key of FONT_SIZE_KEYS) {
    const value = configService.get(fontSizeConfigKey(key));
    if (typeof value === "number") sizes[key] = clampFontSize(key, value);
  }
  applyFontSizes(sizes);
}
