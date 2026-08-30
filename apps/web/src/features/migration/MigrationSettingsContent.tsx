import { Button, Empty, Spin, Tag } from "@arco-design/web-react";
import type {
  MigrationStatus,
  SkillMcpMigrationResult,
} from "@workagent/contracts";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { migrationPort } from "./migrationPort.js";

const statusColor: Record<MigrationStatus, string> = {
  ready: "green",
  needs_auth: "orange",
  needs_review: "arcoblue",
  failed: "red",
};

const recoveryText = (status: MigrationStatus) => {
  switch (status) {
    case "needs_auth":
      return "Open MCP settings and sign in again.";
    case "needs_review":
      return "Review this item in Skills or MCP settings before enabling it.";
    case "failed":
      return "Resolve the reported issue, then run migration again.";
    default:
      return "This item is ready to use.";
  }
};

export default function MigrationSettingsContent() {
  const { t } = useTranslation();
  const [results, setResults] = useState<SkillMcpMigrationResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setResults((await migrationPort.skillMcpReport()).results);
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
            {t("settings.migration", { defaultValue: "Migration" })}
          </h2>
          <p className="mb-0 mt-6px text-13px text-t-secondary">
            {t("settings.migrationDescription", {
              defaultValue:
                "Recovery status for Skills, MCP servers, bindings, and authorization imported from WorkAgent2.",
            })}
          </p>
        </div>
        <Button size="small" onClick={() => void load()} loading={loading}>
          {t("common.refresh", { defaultValue: "Refresh" })}
        </Button>
      </div>

      {loading ? (
        <div className="flex min-h-220px items-center justify-center">
          <Spin />
        </div>
      ) : failed ? (
        <Empty
          description={t("settings.migrationLoadFailed", {
            defaultValue: "Unable to load the migration report.",
          })}
        />
      ) : results.length === 0 ? (
        <Empty
          description={t("settings.migrationEmpty", {
            defaultValue:
              "No imported Skills or MCP servers require attention.",
          })}
        />
      ) : (
        <div className="flex flex-col gap-10px pb-16px">
          {results.map((result) => (
            <MigrationResultCard
              key={`${result.kind}:${result.sourceId}`}
              result={result}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MigrationResultCard({ result }: { result: SkillMcpMigrationResult }) {
  return (
    <section className="rounded-12px border border-border-2 bg-fill-1 p-14px">
      <div className="flex items-start justify-between gap-12px">
        <div className="min-w-0">
          <div className="truncate text-14px font-600 text-t-primary">
            {result.sourceId}
          </div>
          <div className="mt-2px text-12px text-t-tertiary">
            {result.kind.replaceAll("_", " ")}
            {result.targetId ? ` · ${result.targetId}` : ""}
          </div>
        </div>
        <Tag size="small" color={statusColor[result.status]}>
          {result.status.replaceAll("_", " ")}
        </Tag>
      </div>
      <div className="mt-10px text-12px text-t-secondary">
        {result.reason ?? recoveryText(result.status)}
      </div>
      {result.reason && result.status !== "ready" ? (
        <div className="mt-4px text-12px text-t-tertiary">
          {recoveryText(result.status)}
        </div>
      ) : null}
    </section>
  );
}
