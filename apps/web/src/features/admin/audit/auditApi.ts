import { requestJson } from "../../../shared/api/http.js";

export type AuditEvent = {
  id: string;
  occurred_at: string;
  actor: string;
  action: string;
  target: string;
  result: string;
};
const query = (action: string) =>
  `limit=100&action=${encodeURIComponent(action)}`;
export const auditApi = {
  events: (action: string) =>
    requestJson<{ events: AuditEvent[] }>(
      `/api/portal/admin/audit?${query(action)}`,
    ),
  exportUrl: (action: string) =>
    `/api/portal/admin/audit/export?${query(action)}`,
};
