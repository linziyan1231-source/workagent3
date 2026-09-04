import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const apiProxyTarget =
  process.env.WORKAGENT_WEB_API_TARGET ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": apiProxyTarget,
    },
  },
  test: {
    environment: "jsdom",
  },
});
