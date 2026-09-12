import { requestJson } from "../../../shared/api/http.js";

export type AuditEvent = {
  id: string;
  occurred_at: string;
  actor: string;
  action: string;
  target: string;
  result: string;
  correlation_id?: string;
  metadata?: Record<string, string>;
};
const query = (action: string, ip = "") =>
  `limit=100&action=${encodeURIComponent(action)}&client_ip=${encodeURIComponent(ip)}`;
export const auditApi = {
  events: (action: string, ip = "") =>
    requestJson<{ events: AuditEvent[] }>(
      `/api/portal/admin/audit?${query(action, ip)}`,
    ),
  exportUrl: (action: string, ip = "") =>
    `/api/portal/admin/audit/export?${query(action, ip)}`,
};
