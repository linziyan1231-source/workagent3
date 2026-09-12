import { useEffect, useState } from "react";
import { accountApi, type Employee, type Job } from "./accountApi.js";
import type { AccountDirectory } from "./useAccountDirectory.js";
import { errorMessage } from "../shared/adminErrors.js";
import { Dialog, ActionForm, Password, date } from "../shared/adminUi.js";
import { EmployeePanel } from "./EmployeePanel.js";
import { DollarUsage, DollarBudgets } from "../usage/DollarUsage.js";

// Keep account actions alive while another admin page is visible, so background
// provisioning continues to report progress when the administrator returns.
export function AccountsPage({
  active,
  directory,
}: {
  active: boolean;
  directory: AccountDirectory;
}) {
  const { users, sources, loading } = directory;
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [create, setCreate] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState("");
  const error = jobError || directory.error;
  const reload = async () => {
    setJobError("");
    await directory.reload();
  };
  useEffect(() => {
    if (!job || job.status !== "running") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void accountApi
        .job(job.id)
        .then(({ job: next }) => {
          if (cancelled) return;
          setJob(next);
          if (next.status === "succeeded") void reload();
        })
        .catch((e) => {
          if (!cancelled) {
            setJobError(errorMessage(e));
            setJob({ ...job });
          }
        });
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [job]);
  const visible = users.filter((u) =>
    `${u.username} ${u.windows_username}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const employee = users.find((u) => u.username === selected);
  return (
    <>
      {active && (
        <>
          <div className="admin-heading">
            <div>
              <p className="admin-eyebrow">WORKSPACE MANAGEMENT</p>
              <h1>账户与额度</h1>
              <p>管理成员访问、使用额度与服务配置。</p>
            </div>
            <button className="admin-primary" onClick={() => setCreate(true)}>
              ＋ 创建账户
            </button>
          </div>
          <div className="admin-metrics">
            <Metric label="全部账户" value={users.length} />
            <Metric
              label="正常使用"
              value={users.filter((u) => u.enabled && !u.offboarded).length}
            />
            <Metric
              label="已停用 / 离职"
              value={users.filter((u) => !u.enabled || u.offboarded).length}
            />
          </div>
          <DollarUsage users={users} />
          {error && (
            <p role="alert">
              {error} <button onClick={() => void reload()}>重试</button>
            </p>
          )}
          {job && (
            <div className="admin-job" role="status">
              <div>
                <strong>{job.username}</strong> ·{" "}
                {job.status === "succeeded"
                  ? "账户已就绪"
                  : job.status === "failed"
                    ? "创建失败"
                    : job.step}
              </div>
              <progress max="100" value={job.percent} />
              <span>
                {job.status === "failed"
                  ? job.error_message
                  : `${job.percent}%`}
              </span>
              {job.status !== "running" && (
                <button onClick={() => setJob(null)}>关闭</button>
              )}
            </div>
          )}
          <section className="admin-card">
            <div className="admin-table-toolbar">
              <h2>
                成员账户 <small>{users.length}</small>
              </h2>
              <div>
                <input
                  type="search"
                  aria-label="搜索账户"
                  placeholder="搜索账户或 Windows 用户名"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button onClick={() => void reload()} disabled={loading}>
                  刷新
                </button>
              </div>
            </div>
            <div className="admin-table-scroll">
              <table className="admin-accounts-table">
                <thead>
                  <tr>
                    <th>账户</th>
                    <th>状态</th>
                    <th>使用额度</th>
                    <th>最近登录</th>
                    <th>创建时间</th>
                    <th>
                      <span className="admin-sr">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((u) => (
                    <tr key={u.username}>
                      <td>
                        <div className="admin-user-cell">
                          <span className="admin-avatar">
                            {u.username.slice(0, 1).toUpperCase()}
                          </span>
                          <div>
                            <strong>{u.username}</strong>
                            <small>{u.windows_username}</small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span
                          className={`admin-badge ${u.enabled && !u.offboarded ? "active" : ""}`}
                        >
                          {u.offboarded
                            ? "已离职"
                            : u.enabled
                              ? "正常"
                              : "已停用"}
                        </span>
                      </td>
                      <td>
                        <AccountBudgets user={u} />
                      </td>
                      <td>{date(u.last_login_at)}</td>
                      <td>{date(u.created_at)}</td>
                      <td>
                        <button
                          className="admin-link"
                          onClick={() => setSelected(u.username)}
                        >
                          管理 <span aria-hidden>↗</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!visible.length && (
              <p className="admin-empty">
                {loading
                  ? "正在加载账户…"
                  : query
                    ? "没有匹配的账户"
                    : "暂无成员账户，创建后即可开始使用。"}
              </p>
            )}
          </section>
          <p className="admin-footnote">
            每个账户独立计算美元额度，DSH 与 Codex / ChatGPT 共享。
          </p>
        </>
      )}
      {create && (
        <Dialog title="创建账户" onClose={() => setCreate(false)}>
          <ActionForm
            submit="创建账户"
            onSubmit={async (data) => {
              const r = await accountApi.create(
                String(data.get("username")),
                String(data.get("password")),
              );
              setJob(r.job);
              setCreate(false);
            }}
          >
            <label>
              账户名
              <input
                name="username"
                required
                autoComplete="off"
                pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                maxLength={64}
              />
            </label>
            <Password label="初始密码" name="password" />
            <p className="admin-hint">
              系统会创建独立工作空间。创建进度显示在账户列表上方。
            </p>
          </ActionForm>
        </Dialog>
      )}
      {employee && (
        <EmployeePanel
          key={employee.username}
          employee={employee}
          sources={sources}
          onClose={() => setSelected(null)}
          onUpdate={reload}
        />
      )}
    </>
  );
}
function AccountBudgets({ user }: { user: Employee }) {
  return <DollarBudgets username={user.username} />;
}
function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value.toString().padStart(2, "0")}</strong>
    </div>
  );
}
