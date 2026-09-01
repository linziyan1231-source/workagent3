import { Alert, Button, Empty, Spin, Tag } from "@arco-design/web-react";
import type { CapabilityReadModel, ModuleManifest } from "@workagent/contracts";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { systemPort } from "./systemPort.js";

type ModuleStatus = CapabilityReadModel["runtimeStatus"] | "disabled";

const statusColor = (status: ModuleStatus) => {
  switch (status) {
    case "healthy":
      return "green";
    case "unhealthy":
      return "red";
    case "unavailable":
      return "orangered";
    case "disabled":
      return "gray";
    default:
      return "arcoblue";
  }
};

function ModuleCard({
  manifest,
  status,
}: {
  manifest: ModuleManifest;
  status: ModuleStatus;
}) {
  const { t } = useTranslation();
  const atRisk = manifest.required && status !== "healthy";
  return (
    <section className="rounded-12px border border-border-2 bg-fill-1 p-14px">
      <div className="flex items-start justify-between gap-12px">
        <div className="min-w-0">
          <div className="truncate text-14px font-600 text-t-primary">
            {manifest.id}
          </div>
          <div className="mt-3px text-12px text-t-tertiary">
            {manifest.dataOwner}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-6px">
          <Tag size="small">{manifest.layer}</Tag>
          <Tag size="small" color={statusColor(status)}>
            {t(`settings.componentStatus.${status}`, {
              defaultValue: status,
            })}
          </Tag>
          {atRisk ? (
            <Tag size="small" color="orangered">
              {t("settings.componentRequiredRisk", {
                defaultValue: "Required",
              })}
            </Tag>
          ) : null}
        </div>
      </div>
      <div className="mt-10px flex flex-wrap gap-6px">
        {manifest.capabilities.map((capability) => (
          <Tag key={capability} size="small" bordered>
            {capability}
          </Tag>
        ))}
      </div>
      <div className="mt-8px text-12px text-t-tertiary">
        {t("settings.componentDependencies", {
          defaultValue: "{{count}} Port dependencies",
          count: manifest.dependencies.length,
        })}
        {" · "}
        {manifest.version}
      </div>
    </section>
  );
}

export default function CapabilitySettingsContent() {
  const { t } = useTranslation();
  const [model, setModel] = useState<CapabilityReadModel>();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setModel(await systemPort.capabilities());
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
            {t("settings.components", { defaultValue: "Components" })}
          </h2>
          <p className="mb-0 mt-6px text-13px text-t-secondary">
            {t("settings.componentsDescription", {
              defaultValue:
                "Read-only module health, capabilities and required-component risks.",
            })}
          </p>
        </div>
        <Button size="small" loading={loading} onClick={() => void load()}>
          {t("common.refresh", { defaultValue: "Refresh" })}
        </Button>
      </div>

      {loading ? (
        <div className="flex min-h-220px items-center justify-center">
          <Spin />
        </div>
      ) : failed || !model ? (
        <Empty
          description={t("settings.componentsLoadFailed", {
            defaultValue: "Unable to load component health.",
          })}
        />
      ) : (
        <>
          {model.runtimeStatus !== "healthy" ? (
            <Alert
              type="warning"
              content={t("settings.runtimeCapabilityStatus", {
                defaultValue: "SID Runtime capability status: {{status}}",
                status: model.runtimeStatus,
              })}
            />
          ) : null}

          <div>
            <h3 className="mb-10px mt-0 text-14px font-600 text-t-primary">
              {t("settings.platformComponents", {
                defaultValue: "Platform",
              })}
            </h3>
            <div className="flex flex-col gap-10px">
              {model.platformModules.map((entry) => (
                <ModuleCard
                  key={entry.manifest.id}
                  manifest={entry.manifest}
                  status={entry.status}
                />
              ))}
            </div>
          </div>

          <div className="pb-16px">
            <h3 className="mb-10px mt-0 text-14px font-600 text-t-primary">
              {t("settings.runtimeComponents", {
                defaultValue: "SID Runtime",
              })}
            </h3>
            {model.runtimeModules.length === 0 ? (
              <Empty
                description={t("settings.runtimeComponentsUnavailable", {
                  defaultValue: "No Runtime manifests are available.",
                })}
              />
            ) : (
              <div className="flex flex-col gap-10px">
                {model.runtimeModules.map((manifest) => (
                  <ModuleCard
                    key={manifest.id}
                    manifest={manifest}
                    status={model.runtimeStatus}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
