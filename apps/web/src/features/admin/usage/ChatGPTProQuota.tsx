import { useEffect, useState } from "react";
import { postJson, requestJson } from "../../../shared/api/http.js";
import { date } from "../shared/adminUi.js";

type Quota = {
  limit: number;
  used: number;
  pending: number;
  unknown: number;
  remaining: number;
  reset_at: string;
};
type Send = {
  logical_id: string;
  requested_model: string;
  state: string;
  outcome: string;
  reserved_at: string;
  resolved: boolean;
};
type Snapshot = { quota: Quota; sends: Send[] };
const states: Record<string, string> = {
  reserved: "等待确认",
  unknown: "发出状态待核对",
  dispatched: "已计次",
  cancelled: "确认未发出",
};
const outcomes: Record<string, string> = {
  pending: "结果等待中",
  completed: "已结束",
  failed: "请求失败",
  interrupted: "连接中断",
  unknown: "结果未知",
};

export function ChatGPTProQuota({ username }: { username: string }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [limit, setLimit] = useState("7"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [review, setReview] = useState(""),
    [decision, setDecision] = useState("dispatched"),
    [reason, setReason] = useState("");
  const accept = (value: Snapshot) => {
    setSnapshot(value);
    setLimit(String(value.quota.limit));
    setError("");
  };
  useEffect(() => {
    let active = true;
    setSnapshot(null);
    setError("");
    setReview("");
    void requestJson<Snapshot>(
      `/api/portal/admin/chatgpt/quotas?username=${encodeURIComponent(username)}`,
    )
      .then((value) => {
        if (active) accept(value);
      })
      .catch(() => {
        if (active) setError("暂时无法读取 ChatGPT Pro 次数，请稍后重试。");
      });
    return () => {
      active = false;
    };
  }, [username]);
  const save = async (input: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      accept(
        await postJson<Snapshot>("/api/portal/admin/chatgpt/quotas", {
          username,
          ...input,
        }),
      );
      setReview("");
      setReason("");
    } catch {
      setError(
        "保存未完成。记录可能已更新，请刷新后核对；已发出的请求不能退次数。",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="admin-card" aria-label="ChatGPT Pro 次数">
      <h3>ChatGPT Pro 次数</h3>
      <p className="admin-hint">
        请求成功发出即计 1 次，之后失败、降级或中断都不退回。每周一北京时间
        00:00 重置。
      </p>
      {error && <p role="alert">{error}</p>}
      {snapshot ? (
        <>
          <p>
            已用 <strong>{snapshot.quota.used}</strong> · 待确认{" "}
            <strong>{snapshot.quota.pending}</strong> · 剩余{" "}
            <strong>{snapshot.quota.remaining}</strong> / {snapshot.quota.limit}
          </p>
          <small>下次重置 {date(snapshot.quota.reset_at)}</small>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save({ limit: Number(limit) });
            }}
          >
            <label>
              每周次数上限
              <input
                type="number"
                min="0"
                max="10000"
                step="1"
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
                required
              />
            </label>
            <button disabled={busy}>保存上限</button>
            <p className="admin-hint">
              0 表示暂停新的 Pro 请求。降低上限不会删除已用次数。
            </p>
          </form>
          <details>
            <summary>本周请求与待核对记录（最多 200 条）</summary>
            <div className="admin-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>发起时间</th>
                    <th>模型</th>
                    <th>计次状态</th>
                    <th>结果</th>
                    <th>核对</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.sends.map((send) => (
                    <tr key={send.logical_id}>
                      <td>{date(send.reserved_at)}</td>
                      <td>{send.requested_model || "发送已取消"}</td>
                      <td>{states[send.state] ?? send.state}</td>
                      <td>{outcomes[send.outcome] ?? send.outcome}</td>
                      <td>
                        {!send.resolved &&
                          (send.state === "unknown" ||
                            (send.state === "reserved" &&
                              Date.now() - Date.parse(send.reserved_at) >
                                900000)) && (
                            <button
                              disabled={busy}
                              onClick={() => {
                                setReview(send.logical_id);
                                setReason("");
                                setDecision("dispatched");
                              }}
                            >
                              核对
                            </button>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!snapshot.sends.length && <p>新账本暂无请求记录。</p>}
          </details>
          {review && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save({ logical_id: review, decision, reason });
              }}
            >
              <h4>核对发出状态</h4>
              <p className="admin-hint">
                只有能确认没有发出的请求才可释放占用。回复失败或中断仍应计次。
              </p>
              <label>
                核对结果
                <select
                  value={decision}
                  onChange={(event) => setDecision(event.target.value)}
                >
                  <option value="dispatched">确认已经发出，计 1 次</option>
                  <option value="cancelled">确认没有发出，释放占用</option>
                </select>
              </label>
              <label>
                核对依据
                <textarea
                  value={reason}
                  maxLength={500}
                  required
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <button disabled={busy || !reason.trim()}>保存核对结果</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setReview("")}
              >
                取消
              </button>
            </form>
          )}
        </>
      ) : (
        !error && <p role="status">正在读取次数…</p>
      )}
    </section>
  );
}
