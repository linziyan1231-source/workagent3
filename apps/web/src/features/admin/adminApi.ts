import { ApiError, requestJson } from "../../shared/api/http.js";

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
  enabled: boolean;
  offboarded: boolean;
  created_at: string;
  last_login_at?: string;
  kimi_datasource?: Grant;
  budgets?: Budget[];
  quota_unavailable?: boolean;
};
export type Budget = {
  modelId: string;
  baseLimitUnits: number;
  limitUnits: number;
  consumedUnits: number;
  gatewayAccounting?: boolean;
  usageUpdatedAt?: string;
  reservedUnits: number;
  period: string;
  periodKey: string;
  temporary: boolean;
  resetsAt: string;
};
export type Job = {
  id: string;
  username: string;
  status: string;
  percent: number;
  step: string;
  error_message?: string;
};
export const post = <T>(path: string, body: unknown) =>
  requestJson<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
export const adminApi = {
  users: () =>
    requestJson<{ users: Employee[]; kimi_datasource_sources: string[] }>(
      "/api/portal/admin/users",
    ),
  budgets: (username: string) =>
    requestJson<{ budgets: Budget[] }>(
      `/api/portal/admin/quotas?username=${encodeURIComponent(username)}`,
    ),
  adjust: (
    username: string,
    modelId: string,
    mode: string,
    limitUnits: number,
  ) =>
    post<{ budgets: Budget[] }>("/api/portal/admin/quotas", {
      username,
      modelId,
      mode,
      limitUnits,
    }),
  action: (
    username: string,
    action: string,
    fields: Record<string, unknown> = {},
  ) =>
    post<{ job?: Job }>(`/api/portal/admin/users/${action}`, {
      username,
      ...fields,
    }),
  create: (username: string, portal_password: string) =>
    post<{ job: Job }>("/api/portal/admin/users", {
      username,
      portal_password,
    }),
  job: (id: string) =>
    requestJson<{ job: Job }>(
      `/api/portal/admin/user-jobs?id=${encodeURIComponent(id)}`,
    ),
};
export function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    const messages: Record<string, string> = {
      administrator_required: "当前账户没有管理权限。",
      invalid_employee: "请检查账户名和密码格式。",
      invalid_password: "密码不符合安全要求。",
      invalid_quota_adjustment: "请输入有效的非负整数额度。",
      employee_provision_failed: "账户创建未能启动，请检查账户名是否已存在。",
      employee_manager_failed: "操作未完成，请检查账户状态后重试。",
      quota_not_configured: "此账户尚未配置该模型额度。",
      quota_unavailable: "额度服务暂时不可用。",
    };
    return messages[error.code] ?? `操作未完成（${error.code}），请重试。`;
  }
  return "连接失败，请检查网络后重试。";
}
export const modelName = (id: string) =>
  ({
    "harness-default": "通用默认模型",
    "codex-native": "Codex 原生模型",
    "kimi-native": "Kimi 原生模型",
    "speech-transcription": "语音转写",
  })[id] ?? id;
export const number = (value: number) => value.toLocaleString("zh-CN");
