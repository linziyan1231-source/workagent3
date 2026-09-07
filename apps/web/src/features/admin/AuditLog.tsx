import { useEffect, useState } from "react";
import { requestJson } from "../../shared/api/http.js";
import { errorMessage } from "./adminApi.js";
import { date } from "./adminUi.js";
type AuditEvent = {
  id: string;
  occurred_at: string;
  actor: string;
  action: string;
  target: string;
  result: string;
};
export function AuditLog() {
  const [events, setEvents] = useState<AuditEvent[]>([]),
    [error, setError] = useState(""),
    [action, setAction] = useState("");
  const load = async () => {
    setError("");
    try {
      const r = await requestJson<{ events: AuditEvent[] }>(
        `/api/portal/admin/audit?limit=100&action=${encodeURIComponent(action)}`,
      );
      setEvents(r.events ?? []);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <div className="admin-heading">
        <div>
          <p className="admin-eyebrow">ACTIVITY</p>
          <h1>操作记录</h1>
          <p>查看管理操作与额度变更。</p>
        </div>
        <a
          className="admin-button"
          href={`/api/portal/admin/audit/export?limit=100&action=${encodeURIComponent(action)}`}
        >
          导出记录
        </a>
      </div>
      <section className="admin-card">
        <form
          className="admin-table-toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <input
            aria-label="筛选操作"
            placeholder="按操作筛选，如 quota.adjust"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          />
          <button>查询</button>
        </form>
        {error && <p role="alert">{error}</p>}
        <div className="admin-table-scroll">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>操作</th>
                <th>操作者</th>
                <th>目标</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={e.id ?? i}>
                  <td>{date(e.occurred_at)}</td>
                  <td>{e.action}</td>
                  <td>{e.actor}</td>
                  <td>{e.target}</td>
                  <td>
                    {e.result === "success"
                      ? "成功"
                      : e.result === "denied"
                        ? "拒绝"
                        : "失败"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!events.length && !error && (
          <p className="admin-empty">暂无操作记录</p>
        )}
      </section>
    </>
  );
}
