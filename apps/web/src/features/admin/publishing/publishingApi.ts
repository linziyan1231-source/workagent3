import { requestJson } from "../../../shared/api/http.js";

export type PublishingSettings = {
  firstPort: number;
  lastPort: number;
  maxEmployeePorts: number;
  totalPorts: number;
  usedPorts: number;
  employeeUsage: { sid: string; username?: string; ports: number }[];
};

export type AdminPublishedApp = {
  id: string;
  name: string;
  kind: string;
  access: string;
  url: string;
  shareUrl: string;
  enabled: boolean;
  createdAt: string;
  username?: string;
};

export const publishingApi = {
  settings: () =>
    requestJson<PublishingSettings>("/api/portal/admin/published-apps/settings"),
  save: (input: {
    firstPort: number;
    lastPort: number;
    maxEmployeePorts: number;
  }) =>
    requestJson<PublishingSettings>("/api/portal/admin/published-apps/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  list: () =>
    requestJson<{ apps: AdminPublishedApp[] }>(
      "/api/portal/admin/published-apps",
    ),
  unpublish: (id: string) =>
    requestJson<unknown>(
      `/api/portal/admin/published-apps/${id}/unpublish`,
      { method: "POST" },
    ),
};
