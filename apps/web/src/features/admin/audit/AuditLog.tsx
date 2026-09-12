import { useEffect, useState } from "react";
import { auditApi, type AuditEvent } from "./auditApi.js";
import { errorMessage } from "../shared/adminErrors.js";
import { date } from "../shared/adminUi.js";
export function AuditLog() {
  const [events, setEvents] = useState<AuditEvent[]>([]),
    [error, setError] = useState(""),
    [ip, setIP] = useState(""),
    [action, setAction] = useState("");
  const load = async () => {
    setError("");
    try {
      const r = await auditApi.events(action, ip);
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
        <a className="admin-button" href={auditApi.exportUrl(action, ip)}>
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
          <input
            aria-label="来源 IP"
            placeholder="按来源 IP 筛选"
            value={ip}
            onChange={(e) => setIP(e.target.value)}
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
                <th>来源</th>
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
                    <details>
                      <summary>
                        {e.metadata?.client_ip ||
                          e.metadata?.source_kind ||
                          "历史记录未采集"}
                      </summary>
                      <div>连接：{e.metadata?.peer_ip || "—"}</div>
                      <div>{e.metadata?.user_agent || ""}</div>
                      <div>关联编号：{e.correlation_id || "—"}</div>
                    </details>
                  </td>
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
