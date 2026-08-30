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
  content: {
    pipeline: {
      include: [/\.[jt]sx?($|\?)/, /\.vue($|\?)/, /\.css($|\?)/],
      exclude: [/[\\/]node_modules[\\/]/, /\.html($|\?)/],
    },
  },
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
      "t-disabled": "var(--text-disabled)",
      base: "var(--bg-base)",
      1: "var(--bg-1)",
      2: "var(--bg-2)",
      3: "var(--bg-3)",
      4: "var(--bg-4)",
      5: "var(--bg-5)",
      6: "var(--bg-6)",
      8: "var(--bg-8)",
      9: "var(--bg-9)",
      10: "var(--bg-10)",
      hover: "var(--bg-hover)",
      active: "var(--bg-active)",
      brand: "var(--brand)",
      "brand-light": "var(--brand-light)",
      "brand-hover": "var(--brand-hover)",
      aou: {
        1: "var(--aou-1)",
        2: "var(--aou-2)",
        3: "var(--aou-3)",
        4: "var(--aou-4)",
        5: "var(--aou-5)",
        6: "var(--aou-6)",
        7: "var(--aou-7)",
        8: "var(--aou-8)",
        9: "var(--aou-9)",
        10: "var(--aou-10)",
      },
      "message-user": "var(--message-user-bg)",
      "message-tips": "var(--message-tips-bg)",
      "workspace-btn": "var(--workspace-btn-bg)",
      fill: "var(--fill)",
      inverse: "var(--inverse)",
    },
    fontFamily: {
      mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, "Cascadia Code", "Roboto Mono", Consolas, "Liberation Mono", monospace',
    },
  },
});
