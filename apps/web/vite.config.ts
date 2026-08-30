import react from "@vitejs/plugin-react";
import UnoCSS from "unocss/vite";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import unoConfig from "./uno.config";

const aionSrc = fileURLToPath(
  new URL("../../third_party/aionui/packages/desktop/src", import.meta.url),
);
const webModules = fileURLToPath(new URL("./node_modules", import.meta.url));

export default defineConfig({
  plugins: [react(), UnoCSS(unoConfig)],
  resolve: {
    alias: [
      { find: "react", replacement: `${webModules}/react` },
      { find: "react-dom", replacement: `${webModules}/react-dom` },
      {
        find: "@arco-design/web-react",
        replacement: `${webModules}/@arco-design/web-react`,
      },
      {
        find: "@icon-park/react",
        replacement: `${webModules}/@icon-park/react`,
      },
      { find: "classnames", replacement: `${webModules}/classnames` },
      { find: "i18next", replacement: `${webModules}/i18next` },
      { find: "react-i18next", replacement: `${webModules}/react-i18next` },
      {
        find: "react-router-dom",
        replacement: `${webModules}/react-router-dom`,
      },
      { find: "swr", replacement: `${webModules}/swr` },
      {
        find: "@renderer/utils/platform",
        replacement: fileURLToPath(
          new URL("./src/shared/aion-adapter/platform.ts", import.meta.url),
        ),
      },
      {
        find: "@/renderer/utils/platform",
        replacement: fileURLToPath(
          new URL("./src/shared/aion-adapter/platform.ts", import.meta.url),
        ),
      },
      { find: "@renderer", replacement: `${aionSrc}/renderer` },
      { find: "@", replacement: aionSrc },
    ],
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8080",
    },
  },
  test: {
    environment: "jsdom",
  },
});
