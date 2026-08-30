import { Button, Empty, Progress, Spin, Tag } from "@arco-design/web-react";
import SettingsPageHeader from "@renderer/pages/settings/components/SettingsPageHeader";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setEntries(await quotaPort.list());
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
      <SettingsPageHeader
        title={t("settings.usage", { defaultValue: "Usage" })}
        description={t("settings.usageDescription", {
          defaultValue:
            "Model limits and usage assigned to your WorkAgent account.",
        })}
        actions={
          <Button size="small" onClick={() => void load()} loading={loading}>
            {t("common.refresh", { defaultValue: "Refresh" })}
          </Button>
        }
      />

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
      ) : entries.length === 0 ? (
        <Empty
          description={t("settings.usageNoModels", {
            defaultValue: "No models have been assigned.",
          })}
        />
      ) : (
        <div className="flex flex-col gap-12px pb-16px">
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
