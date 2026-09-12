import { useEffect, useState } from "react";
import { requestJson } from "../../../shared/api/http.js";
type Report = {
  id: string;
  username: string;
  description: string;
  steps: string;
  status: string;
  savedAt: string;
  attachments: { id: string; name: string }[];
};
export function FeedbackInbox() {
  const [items, setItems] = useState<Report[]>([]);
  const [error, setError] = useState("");
  const load = () =>
    requestJson<{ items: Report[] }>("/api/system/feedback?all=1")
      .then((result) => setItems(result.items))
      .catch((error) => setError(error.message));
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="admin-card">
      <h1>问题反馈</h1>
      <button onClick={() => void load()}>刷新</button>
      <a href="/api/admin/feedback/backup" download>
        下载完整反馈备份
      </a>
      {error && <p role="alert">{error}</p>}
      {items.map((item) => (
        <details key={item.id}>
          <summary>
            {item.username} · {item.description.slice(0, 60)} ·{" "}
            {new Date(item.savedAt).toLocaleString()}
          </summary>
          <p style={{ whiteSpace: "pre-wrap" }}>{item.description}</p>
          <p style={{ whiteSpace: "pre-wrap" }}>{item.steps}</p>
          <p>反馈编号：{item.id}</p>
          <label>
            处理状态{" "}
            <select
              value={item.status}
              onChange={async (event) => {
                try {
                  await requestJson(`/api/system/feedback/${item.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ status: event.target.value }),
                  });
                  await load();
                } catch (error) {
                  setError((error as Error).message);
                }
              }}
            >
              <option value="new">待处理</option>
              <option value="in_progress">处理中</option>
              <option value="resolved">已解决</option>
            </select>
          </label>
          {item.attachments.map((a) => (
            <p key={a.id}>
              <a
                href={`/api/system/feedback/${item.id}/attachments/${a.id}`}
                download
              >
                {a.name}
              </a>
            </p>
          ))}
        </details>
      ))}
      {!items.length && !error && <p>暂无反馈</p>}
    </section>
  );
}
