import { useEffect, useState } from "react";
import {
  adminApi,
  errorMessage,
  modelName,
  number,
  type Budget,
} from "./adminApi.js";
import { ActionForm, date } from "./adminUi.js";
export function QuotaEditor({ username }: { username: string }) {
  const [budgets, setBudgets] = useState<Budget[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [editing, setEditing] = useState<string | null>(null),
    [mode, setMode] = useState("temporary");
  const load = async () => {
    setError("");
    try {
      setBudgets((await adminApi.budgets(username)).budgets);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [username]);
  return (
    <div className="admin-quota-list">
      {budgets.some((b) => b.gatewayAccounting) && (
        <p className="admin-hint">
          用量按网关实际 token 统计，通常在数秒内更新。Harness 与 Codex
          共用用量；引擎额度和模型额度同时生效，不能相加。额度不足时阻止新一轮请求，已开始的一轮可能超过剩余额度。
        </p>
      )}
      {error && (
        <p role="alert">
          {error} <button onClick={() => void load()}>重试</button>
        </p>
      )}
      {loading && <p>正在加载额度…</p>}
      {!loading && !error && !budgets.length && (
        <p className="admin-empty">此账户尚未配置模型额度。</p>
      )}
      {budgets.map((b) => (
        <section className="admin-quota" key={b.modelId}>
          <div className="admin-quota-title">
            <h3>{modelName(b.modelId)}</h3>
            <span className={`admin-badge ${b.temporary ? "temporary" : ""}`}>
              {b.temporary
                ? "本周期临时额度"
                : b.period === "weekly"
                  ? "每周额度"
                  : "每日额度"}
            </span>
          </div>
          <div className="admin-quota-amount">
            <strong>{number(b.consumedUnits + b.reservedUnits)}</strong>
            <span>
              / {number(b.limitUnits)}{" "}
              {b.modelId === "speech-transcription" ? "秒" : "tokens"}
            </span>
            <button
              className="admin-link"
              onClick={() => {
                setEditing(editing === b.modelId ? null : b.modelId);
                setMode("temporary");
              }}
            >
              调整额度
            </button>
          </div>
          <progress
            max={Math.max(1, b.limitUnits)}
            value={Math.min(b.limitUnits, b.consumedUnits + b.reservedUnits)}
          />
          <p className="admin-hint">
            已使用 {number(b.consumedUnits)} · 处理中预留{" "}
            {number(b.reservedUnits)}
            <br />
            永久额度 {number(b.baseLimitUnits)} · {date(b.resetsAt)}{" "}
            开始下一周期
            {b.gatewayAccounting && (
              <>
                <br />
                {b.usageUpdatedAt
                  ? `用量更新于 ${date(b.usageUpdatedAt)}`
                  : "用量统计尚未就绪，新请求暂不可用"}
              </>
            )}
          </p>
          {editing === b.modelId && (
            <ActionForm
              onSubmit={async (data) => {
                setBudgets(
                  (
                    await adminApi.adjust(
                      username,
                      b.modelId,
                      mode,
                      Number(data.get("limit")),
                    )
                  ).budgets,
                );
                setEditing(null);
              }}
            >
              <div
                className="admin-segment"
                role="group"
                aria-label="额度生效范围"
              >
                <button
                  type="button"
                  aria-pressed={mode === "temporary"}
                  onClick={() => setMode("temporary")}
                >
                  仅本周期
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "permanent"}
                  onClick={() => setMode("permanent")}
                >
                  永久修改
                </button>
                {b.temporary && (
                  <button
                    type="button"
                    aria-pressed={mode === "restore"}
                    onClick={() => setMode("restore")}
                  >
                    恢复永久额度
                  </button>
                )}
              </div>
              <label>
                额度总量（
                {b.modelId === "speech-transcription" ? "秒" : "tokens"}）
                <input
                  name="limit"
                  aria-label="额度总量"
                  type="number"
                  min="0"
                  max="9007199254740991"
                  step="1"
                  required
                  defaultValue={b.limitUnits}
                  readOnly={mode === "restore"}
                />
              </label>
              <p className="admin-hint">
                {mode === "temporary"
                  ? `立即生效，下一个计费周期自动恢复至 ${number(b.baseLimitUnits)}。`
                  : mode === "permanent"
                    ? "立即替换永久额度并结束现有临时额度，后续周期继续使用新值。"
                    : "立即结束临时调整，恢复永久额度。"}{" "}
                已用量不会清零。
              </p>
            </ActionForm>
          )}
        </section>
      ))}
    </div>
  );
}
