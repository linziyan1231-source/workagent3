// Ported from C:/projects/AionUi/uno.config.ts.
import {
  defineConfig,
  presetMini,
  presetWind3,
  transformerDirectives,
  transformerVariantGroup,
} from "unocss";
import { presetExtra } from "unocss-preset-extra";

export default defineConfig({
  presets: [presetMini(), presetExtra(), presetWind3()],
  transformers: [
    transformerVariantGroup(),
    transformerDirectives({ enforce: "pre" }),
  ],
  shortcuts: { "flex-center": "flex items-center justify-center" },
  rules: [
    [/^text-([1-4])$/, ([, d]) => ({ color: `var(--color-text-${d})` })],
    [
      /^bg-fill-([1-4])$/,
      ([, d]) => ({ "background-color": `var(--color-fill-${d})` }),
    ],
    ["bg-dialog-fill-0", { "background-color": "var(--dialog-fill-0)" }],
  ],
  theme: {
    colors: {
      "t-primary": "var(--text-primary)",
      "t-secondary": "var(--text-secondary)",
      "t-tertiary": "var(--bg-6)",
      base: "var(--bg-base)",
      1: "var(--bg-1)",
      2: "var(--bg-2)",
      3: "var(--bg-3)",
      hover: "var(--bg-hover)",
      active: "var(--bg-active)",
      brand: "var(--brand)",
    },
  },
});
