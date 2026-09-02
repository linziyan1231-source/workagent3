import { Button, Empty, Progress, Spin, Tag } from "@arco-design/web-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GatewayUsage } from "@workagent/contracts";
import { quotaPort, type ModelQuotaUsage } from "./quotaPort.js";

const percentFor = (entry: ModelQuotaUsage) => {
  const usage = entry.usage;
  if (!usage || usage.limitUnits === 0) return 0;
  return Math.min(
    100,
    Math.round(
      ((usage.consumedUnits + usage.reservedUnits) / usage.limitUnits) * 100,
    ),
  );
};

export default function QuotaSettingsContent() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ModelQuotaUsage[]>([]);
  const [gateway, setGateway] = useState<GatewayUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const [models, gatewayUsage] = await Promise.all([
        quotaPort.list(),
        quotaPort.gatewayUsage(),
      ]);
      setEntries(models);
      setGateway(gatewayUsage);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex min-h-full flex-col gap-18px">
      <div className="flex items-start justify-between gap-12px">
        <div>
          <h2 className="m-0 text-18px font-bold text-t-primary">
            {t("settings.usage", { defaultValue: "Usage" })}
          </h2>
          <p className="mb-0 mt-6px text-13px text-t-secondary">
            {t("settings.usageDescription", {
              defaultValue:
                "Model limits and usage assigned to your WorkAgent account.",
            })}
          </p>
        </div>
        <div>
          <Button size="small" onClick={() => void load()} loading={loading}>
            {t("common.refresh", { defaultValue: "Refresh" })}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex min-h-220px items-center justify-center">
          <Spin />
        </div>
      ) : failed ? (
        <Empty
          description={t("settings.usageLoadFailed", {
            defaultValue: "Unable to load usage.",
          })}
        />
      ) : entries.length === 0 && gateway === null ? (
        <Empty
          description={t("settings.usageNoModels", {
            defaultValue: "No models have been assigned.",
          })}
        />
      ) : (
        <div className="flex flex-col gap-12px pb-16px">
          {gateway !== null && (
            <section className="rounded-12px border border-border-2 bg-fill-1 p-16px">
              <div className="mb-12px flex items-start justify-between gap-12px">
                <div className="min-w-0">
                  <div className="truncate text-14px font-600 text-t-primary">
                    {t("settings.gatewayUsage", {
                      defaultValue: "Gateway usage (authoritative)",
                    })}
                  </div>
                  <div className="mt-2px truncate text-12px text-t-tertiary">
                    {t("settings.gatewayUsageDescription", {
                      defaultValue:
                        "Real tokens recorded by the model gateway for your account.",
                    })}
                  </div>
                </div>
              </div>
              <div className="flex gap-24px text-12px text-t-secondary">
                <span>
                  {t("settings.gatewayUsageDaily", {
                    defaultValue: "Today ({{period}}): {{value}} tokens",
                    period: gateway.dailyPeriodKey,
                    value: gateway.dailyTokens.toLocaleString(),
                  })}
                </span>
                <span>
                  {t("settings.gatewayUsageWeekly", {
                    defaultValue: "This week ({{period}}): {{value}} tokens",
                    period: gateway.weeklyPeriodKey,
                    value: gateway.weeklyTokens.toLocaleString(),
                  })}
                </span>
              </div>
              {gateway.models.length > 0 && (
                <div className="mt-8px flex flex-col gap-4px text-12px text-t-tertiary">
                  {gateway.models.map((model) => (
                    <div key={model.model} className="flex justify-between">
                      <span className="truncate">{model.model}</span>
                      <span>
                        {t("settings.gatewayUsageModelTokens", {
                          defaultValue:
                            "{{tokens}} tokens · {{requests}} requests today",
                          tokens: model.totalTokens.toLocaleString(),
                          requests: model.requests.toLocaleString(),
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
          {entries.map((entry) => {
            const usage = entry.usage;
            const used = usage ? usage.consumedUnits + usage.reservedUnits : 0;
            return (
              <section
                key={entry.model.id}
                className="rounded-12px border border-border-2 bg-fill-1 p-16px"
              >
                <div className="mb-12px flex items-start justify-between gap-12px">
                  <div className="min-w-0">
                    <div className="truncate text-14px font-600 text-t-primary">
                      {entry.model.displayName}
                    </div>
                    <div className="mt-2px truncate text-12px text-t-tertiary">
                      {entry.model.id}
                    </div>
                  </div>
                  <Tag size="small" color={usage ? "arcoblue" : "gray"}>
                    {usage
                      ? usage.period === "daily"
                        ? t("settings.quotaDaily", { defaultValue: "Daily" })
                        : t("settings.quotaWeekly", { defaultValue: "Weekly" })
                      : t("settings.quotaUnconfigured", {
                          defaultValue: "Not configured",
                        })}
                  </Tag>
                </div>
                {usage ? (
                  <>
                    <Progress percent={percentFor(entry)} showText={false} />
                    <div className="mt-8px flex justify-between gap-12px text-12px text-t-secondary">
                      <span>
                        {t("settings.quotaUsed", {
                          defaultValue: "{{value}} used",
                          value: used.toLocaleString(),
                        })}
                      </span>
                      <span>
                        {t("settings.quotaLimit", {
                          defaultValue: "{{value}} limit",
                          value: usage.limitUnits.toLocaleString(),
                        })}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="text-12px text-t-tertiary">
                    {t("settings.quotaAskAdmin", {
                      defaultValue: "Ask an administrator to assign a budget.",
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
