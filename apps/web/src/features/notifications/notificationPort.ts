import { requestJson } from "../../shared/api/http.js";

export type PortalNotification = {
  id: string;
  kind: string;
  title?: string;
  message: string;
  deep_link?: string;
  published_at: string;
  read_at?: string;
  acknowledged_at?: string;
};

export const notificationPort = {
  list: () =>
    requestJson<{ notifications: PortalNotification[] }>(
      "/api/portal/me/notifications",
    ),

  acknowledge: (id: string) =>
    requestJson<{ success: boolean }>(
      `/api/portal/me/notifications/${encodeURIComponent(id)}/acknowledge`,
      { method: "POST" },
    ),
};
