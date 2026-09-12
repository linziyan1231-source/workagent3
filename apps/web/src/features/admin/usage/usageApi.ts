import { postJson, requestJson } from "../../../shared/api/http.js";

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
export type DollarBudget = {
  pool: string;
  dailyLimitUsd: number;
  weeklyLimitUsd: number;
  dailyUsd: number;
  weeklyUsd: number;
  dailyResetAt: string;
  weeklyResetAt: string;
  updatedAt: string;
};
export type UsageRow = {
  sid: string;
  pool: string;
  usd: number;
  requests: number;
  unpriced: number;
  estimated: number;
};
export const usageApi = {
  dollars: (username: string) =>
    requestJson<{ budgets: DollarBudget[] }>(
      `/api/quota/dollars?username=${encodeURIComponent(username)}`,
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
    postJson<{ budgets: Budget[] }>("/api/portal/admin/quotas", {
      username,
      modelId,
      mode,
      limitUnits,
    }),
  usage: (username: string, from: string, to: string) => {
    const start = new Date(from),
      end = new Date(to);
    if (!(start < end)) throw new Error("interval");
    const query = new URLSearchParams({
      username,
      from: start.toISOString(),
      to: end.toISOString(),
    });
    return requestJson<{ rows: UsageRow[] }>(
      `/api/portal/admin/usage?${query}`,
    );
  },
};
