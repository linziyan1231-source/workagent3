import { useEffect, useState } from "react";
import { usageApi, type DollarBudget, type UsageRow } from "./usageApi.js";
import { dollars, poolName } from "./usageFormat.js";
import { errorMessage } from "../shared/adminErrors.js";
import { date } from "../shared/adminUi.js";

export function DollarBudgets({ username }: { username: string }) {
  const [budgets, setBudgets] = useState<DollarBudget[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const load = () =>
      usageApi
        .dollars(username)
        .then((r) => {
          if (active) {
            setBudgets(r.budgets);
            setError("");
          }
        })
        .catch((e) => {
          if (active) setError(errorMessage(e));
        });
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [username]);
  if (error) return <span role="alert">{error}</span>;
  if (!budgets.length) return <span>正在获取美元额度…</span>;
  return (
    <div className="admin-dollar-budgets">
      {budgets.map((b) => (
        <div key={b.pool}>
          <strong>{poolName(b.pool)}</strong>
          <span>
            每日：已用 {dollars(b.dailyUsd)} / {dollars(b.dailyLimitUsd)}
          </span>
          <progress
            aria-label={`${poolName(b.pool)} 每日消耗`}
            max={Math.max(b.dailyLimitUsd, 0.01)}
            value={b.dailyUsd}
          />
          <span>
            每周：已用 {dollars(b.weeklyUsd)} / {dollars(b.weeklyLimitUsd)}
          </span>
          <progress
            aria-label={`${poolName(b.pool)} 每周消耗`}
            max={Math.max(b.weeklyLimitUsd, 0.01)}
            value={b.weeklyUsd}
          />
          <small>
            日重置 {date(b.dailyResetAt)} · 周重置 {date(b.weeklyResetAt)}
          </small>
          {Date.now() - Date.parse(b.updatedAt) > 30000 && (
            <small role="status">
              数据暂未更新，上次同步 {date(b.updatedAt)}
            </small>
          )}
        </div>
      ))}
      <div>
        <strong>DSH</strong>
        <span>与 Codex / ChatGPT 共享以上日额度和周额度。</span>
      </div>
    </div>
  );
}

const localMinute = (at: Date) =>
  new Date(at.getTime() - at.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
export function DollarUsage({
  users,
}: {
  users: readonly { username: string; windows_sid: string }[];
}) {
  const [username, setUsername] = useState("");
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return localMinute(d);
  });
  const [to, setTo] = useState(() => localMinute(new Date(Date.now() + 60000)));
  const [rows, setRows] = useState<UsageRow[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const r = await usageApi.usage(username, from, to);
      setRows(r.rows);
    } catch (e) {
      setError(
        e instanceof Error && e.message === "interval"
          ? "结束时间必须晚于开始时间。"
          : errorMessage(e),
      );
      setRows([]);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <section
      className="admin-card admin-dollar-usage"
      aria-label="美元消耗统计"
    >
      <h2>消耗统计（美元）</h2>
      <form
        className="admin-usage-filters"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label>
          用户
          <select
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          >
            <option value="">所有用户</option>
            {users.map((u) => (
              <option key={u.username}>{u.username}</option>
            ))}
          </select>
        </label>
        <label>
          开始时间
          <input
            type="datetime-local"
            required
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          结束时间
          <input
            type="datetime-local"
            required
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button disabled={loading}>查询</button>
      </form>
      <p className="admin-hint">
        按本地时间查询，包含开始时刻、不含结束时刻。DSH 计入
        Codex，共享消耗不重复累加。
      </p>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          <p>
            区间总消耗{" "}
            <strong>{dollars(rows.reduce((sum, r) => sum + r.usd, 0))}</strong>{" "}
            · {rows.reduce((sum, r) => sum + r.requests, 0)} 次请求
          </p>
          {rows.some((r) => r.unpriced > 0) && (
            <p role="status">
              有 {rows.reduce((sum, r) => sum + r.unpriced, 0)}{" "}
              条记录缺少价格，未计入金额。
            </p>
          )}
          {rows.some((r) => r.estimated > 0) && (
            <p className="admin-hint">
              区间金额按采集到的 token
              与网关价格估算；缓存记录缺失或历史价格变化可能造成差异。账户日、周已用金额以网关实际扣费为准。
            </p>
          )}
          <div className="admin-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>用户</th>
                  <th>服务</th>
                  <th>消耗（美元）</th>
                  <th>请求数</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.sid}:${r.pool}`}>
                    <td>
                      {users.find((u) => u.windows_sid === r.sid)?.username ??
                        r.sid}
                    </td>
                    <td>{poolName(r.pool)}</td>
                    <td>{dollars(r.usd)}</td>
                    <td>{r.requests}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && !loading && <p>该区间暂无消耗记录。</p>}
        </>
      )}
    </section>
  );
}
