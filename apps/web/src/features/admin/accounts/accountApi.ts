import { postJson, requestJson } from "../../../shared/api/http.js";

export type Grant = {
  enabled: boolean;
  allowed_sources: string[];
  daily_limit: number;
  monthly_limit: number;
  daily_used: number;
  monthly_used: number;
};
export type Employee = {
  username: string;
  windows_username: string;
  windows_sid: string;
  enabled: boolean;
  offboarded: boolean;
  created_at: string;
  last_login_at?: string;
  kimi_datasource?: Grant;
  quota_unavailable?: boolean;
};
export type Job = {
  id: string;
  username: string;
  status: string;
  percent: number;
  step: string;
  error_message?: string;
};
export const accountApi = {
  users: () =>
    requestJson<{ users: Employee[]; kimi_datasource_sources: string[] }>(
      "/api/portal/admin/users",
    ),
  create: (username: string, portal_password: string) =>
    postJson<{ job: Job }>("/api/portal/admin/users", {
      username,
      portal_password,
    }),
  action: (
    username: string,
    action: string,
    fields: Record<string, unknown> = {},
  ) =>
    postJson<{ job?: Job }>(`/api/portal/admin/users/${action}`, {
      username,
      ...fields,
    }),
  job: (id: string) =>
    requestJson<{ job: Job }>(
      `/api/portal/admin/user-jobs?id=${encodeURIComponent(id)}`,
    ),
  setDatasource: (
    username: string,
    grant: Pick<
      Grant,
      "enabled" | "allowed_sources" | "daily_limit" | "monthly_limit"
    >,
  ) =>
    postJson<void>("/api/portal/admin/users/kimi-datasource", {
      username,
      ...grant,
    }),
};
