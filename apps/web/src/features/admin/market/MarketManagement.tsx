import { useEffect, useState } from "react";
import { marketApi, type Entry, type MarketCatalog } from "./marketApi.js";
import { errorMessage } from "../shared/adminErrors.js";
const labels: Record<string, string> = {
  update: "统一升级",
  disable: "停用",
  delete: "删除",
  unlist: "禁用",
  relist: "恢复上架",
};
export function MarketManagement({
  users,
}: {
  users: readonly { username: string; windows_sid: string }[];
}) {
  const [data, setData] = useState<MarketCatalog>({
      entries: [],
      actions: [],
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState("");
  const [selection, setSelection] = useState<{
      entry: Entry;
      action: string;
    } | null>(null),
    [target, setTarget] = useState(""),
    [reason, setReason] = useState("");
  async function load() {
    try {
      setData(await marketApi.catalog());
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!data.actions.some((a) => a.targets.some((t) => t.state === "pending")))
      return;
    const timer = setTimeout(() => void load(), 3000);
    return () => clearTimeout(timer);
  }, [data]);
  const groups = [
    ...new Map(
      data.entries
        .filter((e) => e.kind === "skill")
        .map((e) => [e.seriesId, e]),
    ).keys(),
  ]
    .map((id) => data.entries.find((e) => e.seriesId === id)!)
    .filter((e) => `${e.name} ${e.publisher}`.includes(query));
  async function submit() {
    if (!selection) return;
    setBusy(true);
    setError("");
    try {
      await marketApi.act({
        seriesId: selection.entry.seriesId,
        targetId: selection.action === "update" ? target : "",
        action: selection.action,
        reason,
      });
      setSelection(null);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="admin-market">
      <div className="admin-heading">
        <div>
          <h1>市场能力管理</h1>
          <p>
            普通用户自行选择升级。这里的安全处置会统一调整已安装的市场技能和项目订阅。
          </p>
        </div>
        <button onClick={() => void load()}>刷新</button>
      </div>
      {error && <p role="alert">{error}</p>}
      <input
        type="search"
        aria-label="搜索市场技能"
        placeholder="搜索技能或发布者"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="admin-market-grid">
        {groups.map((e) => (
          <article className="admin-market-card" key={e.seriesId}>
            <h2>{e.name}</h2>
            <p>
              {e.publisher} · {e.version}
              {e.revoked ? " · 已撤销" : ""}
              {e.listed === false ? " · 已禁用" : ""}
            </p>
            <p className="admin-market-notes">
              {e.releaseNotes || "尚无更新说明"}
            </p>
            <div className="admin-market-buttons">
              {[
                "update",
                "disable",
                "delete",
                e.listed === false ? "relist" : "unlist",
              ].map((action) => (
                <button
                  key={action}
                  className={action === "delete" ? "admin-danger" : undefined}
                  disabled={busy}
                  onClick={() => {
                    setSelection({ entry: e, action });
                    setTarget(
                      data.entries.find(
                        (v) => v.seriesId === e.seriesId && !v.revoked,
                      )?.id || "",
                    );
                    setReason("");
                  }}
                >
                  {labels[action]}
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
      {!groups.length && <p>暂无市场技能。</p>}
      {selection && (
        <section className="admin-market-confirm" aria-label="确认安全处置">
          <h2>
            {labels[selection.action]}：{selection.entry.name}
          </h2>
          {selection.action === "unlist" || selection.action === "relist" ? (
            <p>
              {selection.action === "unlist"
                ? "仅从市场移除并阻止新安装；已安装的副本不受影响。"
                : "恢复到市场列表。"}
            </p>
          ) : (
            <p>
              范围：所有安装过此技能的员工及订阅项目。正在使用受影响技能的任务会停止；离线账户保留待处理记录，上线执行前必须完成处置。
            </p>
          )}
          {selection.action === "delete" && (
            <p>删除市场安装的软件副本并撤销旧版本；工作文件和会话历史保留。</p>
          )}
          {selection.action === "update" && (
            <label>
              目标版本
              <select
                aria-label="统一升级目标版本"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                {data.entries
                  .filter(
                    (e) =>
                      e.seriesId === selection.entry.seriesId && !e.revoked,
                  )
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.version}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label>
            处置原因
            <textarea
              value={reason}
              maxLength={2000}
              onChange={(e) => setReason(e.target.value)}
              placeholder="说明漏洞、风险或修复原因"
            />
          </label>
          <button
            className="admin-primary"
            disabled={
              busy ||
              !reason.trim() ||
              (selection.action === "update" && !target)
            }
            onClick={() => void submit()}
          >
            {busy ? "正在提交…" : `确认${labels[selection.action]}`}
          </button>
          <button disabled={busy} onClick={() => setSelection(null)}>
            取消
          </button>
        </section>
      )}
      <h2>处置记录</h2>
      {data.actions.map((a) => (
        <article className="admin-market-card" key={a.id}>
          <h3>
            {labels[a.action]} ·{" "}
            {data.entries.find((e) => e.seriesId === a.seriesId)?.name}
          </h3>
          <p>
            {a.actor} · {new Date(a.createdAt).toLocaleString()}
          </p>
          <p>{a.reason}</p>
          <p>
            {a.targets.length
              ? `完成 ${a.targets.filter((t) => t.state === "complete").length} / ${a.targets.length}`
              : "已完成"}
          </p>
          <ul>
            {a.targets.map((t) => (
              <li key={t.sid}>
                {users.find((u) => u.windows_sid === t.sid)?.username || t.sid}
                ：
                {t.state === "complete"
                  ? "已完成"
                  : t.state === "superseded"
                    ? "已由后续处置替代"
                    : "待处理"}
                {t.error
                  ? `（${t.error === "employee_runtime_pending" ? "等待员工运行环境可用" : t.error}）`
                  : ""}
              </li>
            ))}
          </ul>
          {a.targets.some((t) => t.state === "pending") && (
            <button
              onClick={async () => {
                try {
                  await marketApi.retry(a.id);
                  await load();
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            >
              重试待处理账户
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
