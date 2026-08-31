import { requestJson } from "../../shared/api/http.js";

export type SystemStatus = {
  build: { version: string; commit: string; build_time: string };
  components: Array<{
    id: string;
    status: "healthy" | "unhealthy" | "unavailable" | "unknown" | "disabled";
    message?: string;
  }>;
};

export const systemPort = {
  diagnosticsUrl: "/api/system/diagnostics",
  status: () => requestJson<SystemStatus>("/api/system/status"),
  restartRuntime: () =>
    requestJson<{ reconnect_after_ms: number }>("/api/system/runtime/restart", {
      method: "POST",
    }),
};
