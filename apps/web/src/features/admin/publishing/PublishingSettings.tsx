import { useEffect, useState } from "react";
import {
  publishingApi,
  type AdminPublishedApp,
  type PublishingSettings,
} from "./publishingApi.js";
import { errorMessage } from "../shared/adminErrors.js";

export function PublishingSettingsPanel() {
  const [data, setData] = useState<PublishingSettings | null>(null),
    [apps, setApps] = useState<AdminPublishedApp[]>([]),
    [firstPort, setFirstPort] = useState(""),
    [lastPort, setLastPort] = useState(""),
    [maxEmployeePorts, setMaxEmployeePorts] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      const [settings, listed] = await Promise.all([
        publishingApi.settings(),
        publishingApi.list(),
      ]);
      setData(settings);
      setApps(listed.apps);
      setFirstPort(String(settings.firstPort));
      setLastPort(String(settings.lastPort));
      setMaxEmployeePorts(String(settings.maxEmployeePorts));
      setError("");
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const first = Number(firstPort),
    last = Number(lastPort),
    max = Number(maxEmployeePorts);
  const invalid =
    !Number.isInteger(first) ||
    !Number.isInteger(last) ||
    !Number.isInteger(max) ||
    first < 1024 ||
    last > 65535 ||
    last - first < 1 ||
    max < 1;
  const rangeChanged =
    data !== null && (first !== data.firstPort || last !== data.lastPort);
  async function submit() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const settings = await publishingApi.save({
        firstPort: first,
        lastPort: last,
        maxEmployeePorts: max,
      });
      setData(settings);
      setNotice(
        rangeChanged
          ? "已保存。现有网页的端口已重新分配到新范围，旧的分享链接随之更新。"
          : "已保存。",
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function unpublish(app: AdminPublishedApp) {
    if (!window.confirm(`确定下架「${app.name}」吗？链接将立即失效。`)) return;
    setError("");
    setNotice("");
    try {
      await publishingApi.unpublish(app.id);
      setNotice(`已下架「${app.name}」。`);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <section className="admin-market">
      <div className="admin-heading">
        <div>
          <h1>应用发布</h1>
          <p>
            网页发布的分享链接使用这里的专用端口直连，端口范围必须与云防火墙开放的端口段一致；每个应用占用
            2 个端口（访问 + 预览）。
          </p>
        </div>
        <button onClick={() => void load()}>刷新</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {data && (
        <>
          <article className="admin-market-card">
            <h2>端口范围</h2>
            <p>
              已占用 {data.usedPorts} / {data.totalPorts} 个端口
            </p>
            <label>
              起始端口
              <input
                type="number"
                aria-label="起始端口"
                value={firstPort}
                onChange={(e) => setFirstPort(e.target.value)}
              />
            </label>
            <label>
              结束端口
              <input
                type="number"
                aria-label="结束端口"
                value={lastPort}
                onChange={(e) => setLastPort(e.target.value)}
              />
            </label>
            {rangeChanged && (
              <p role="note">
                保存后现有网页会被重新分配到这个范围，旧端口链接立即失效。
              </p>
            )}
          </article>
          <article className="admin-market-card">
            <h2>每员工上限</h2>
            <p>每名员工同时发布的网页最多占用的端口数。</p>
            <label>
              每员工最大端口数
              <input
                type="number"
                aria-label="每员工最大端口数"
                value={maxEmployeePorts}
                onChange={(e) => setMaxEmployeePorts(e.target.value)}
              />
            </label>
          </article>
          <button
            className="admin-primary"
            disabled={busy || invalid}
            onClick={() => void submit()}
          >
            {busy ? "正在保存…" : "保存设置"}
          </button>
          {invalid && <p role="alert">请输入合法的端口范围和每员工上限。</p>}
          <h2>员工占用</h2>
          {data.employeeUsage.length === 0 && <p>暂无已发布网页。</p>}
          {data.employeeUsage.map((row) => (
            <article className="admin-market-card" key={row.sid}>
              <p>
                {row.username || row.sid}：{row.ports} / {data.maxEmployeePorts}{" "}
                个端口
              </p>
            </article>
          ))}
          <h2>已发布网页</h2>
          {apps.length === 0 && <p>暂无已发布网页。</p>}
          {apps.map((app) => (
            <article className="admin-market-card" key={app.id}>
              <h2>{app.name}</h2>
              <p>发布者：{app.username || "未知"}</p>
              <p>
                访问链接：
                <a
                  href={app.shareUrl || app.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {app.shareUrl || app.url}
                </a>
              </p>
              {app.enabled ? (
                <div className="admin-market-buttons">
                  <button
                    className="admin-danger"
                    onClick={() => void unpublish(app)}
                  >
                    下架
                  </button>
                </div>
              ) : (
                <p>已下架</p>
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
