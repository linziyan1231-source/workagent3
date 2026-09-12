import { useEffect, useState } from "react";
import { requestJson } from "../../../shared/api/http.js";

type Entry = {
  id: string;
  label: string;
  revision: string;
  packageRef: string;
  billingModelId: string;
  enabled: boolean;
  credentialFields: { id: string; label: string; required: boolean }[];
};
export function AcpCatalog() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      const value = await requestJson<{ entries: Entry[] }>(
        "/api/portal/admin/acp-catalog",
      );
      setEntries(value.entries);
      setError("");
    } catch (reason) {
      setError((reason as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const select = async (entry: Entry, enabled: boolean) => {
    setBusy(true);
    setError("");
    try {
      await requestJson(
        `/api/portal/admin/acp-catalog/${encodeURIComponent(entry.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ revision: entry.revision, enabled }),
        },
      );
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="admin-card">
      <h1>ACP 引擎目录</h1>
      <p>
        从当前软件版本提供的目录启用引擎。员工在自己的设置中填写连接信息。停用后，已有会话也不能发起新一轮请求。
      </p>
      <button disabled={busy} onClick={() => void load()}>
        刷新
      </button>
      {error && <p role="alert">{error}</p>}
      {!entries.length && !error && <p>当前软件版本尚未提供 ACP 引擎。</p>}
      {entries.map((entry) => (
        <article className="admin-card" key={`${entry.id}:${entry.revision}`}>
          <h2>{entry.label}</h2>
          <p>
            版本：{entry.revision} · 计费模型：{entry.billingModelId}
          </p>
          <p>
            员工连接字段：
            {entry.credentialFields
              .map(
                (field) => `${field.label}${field.required ? "（必填）" : ""}`,
              )
              .join("、") || "无"}
          </p>
          <button
            disabled={busy}
            aria-pressed={entry.enabled}
            onClick={() => void select(entry, !entry.enabled)}
          >
            {entry.enabled ? "停用" : "启用此版本"}
          </button>
        </article>
      ))}
    </section>
  );
}
