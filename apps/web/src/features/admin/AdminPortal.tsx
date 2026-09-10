import { useEffect, useState } from "react";
import { adminApi, errorMessage, type Employee, type Job } from "./adminApi.js";
import { Dialog, ActionForm, Password, date } from "./adminUi.js";
import { EmployeePanel } from "./EmployeePanel.js";
import { DollarUsage, DollarBudgets } from "./DollarUsage.js";
import { AuditLog } from "./AuditLog.js";
import "./AdminPortal.css";
export function AdminPortal({
  username,
  onLogout,
}: {
  username: string;
  onLogout: () => Promise<void>;
}) {
  const [users, setUsers] = useState<Employee[]>([]),
    [sources, setSources] = useState<string[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null),
    [create, setCreate] = useState(false),
    [view, setView] = useState("accounts");
  const [job, setJob] = useState<Job | null>(null);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("workagent.admin.sidebar") !== "expanded",
  );
  const reload = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await adminApi.users();
      setUsers(result.users ?? []);
      setSources(result.kimi_datasource_sources ?? []);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void reload();
  }, []);
  useEffect(() => {
    if (!job || job.status !== "running") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void adminApi
        .job(job.id)
        .then(({ job: next }) => {
          if (cancelled) return;
          setJob(next);
          if (next.status === "succeeded") void reload();
        })
        .catch((e) => {
          if (!cancelled) {
            setError(errorMessage(e));
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
    <main className={`admin-app${collapsed ? " is-collapsed" : ""}`}>
      <aside className="admin-sidebar">
        <button
          className="admin-sidebar-toggle"
          aria-label={collapsed ? "展开管理侧栏" : "折叠管理侧栏"}
          title={collapsed ? "展开管理侧栏" : "折叠管理侧栏"}
          aria-expanded={!collapsed}
          onClick={() => {
            setCollapsed(!collapsed);
            localStorage.setItem(
              "workagent.admin.sidebar",
              collapsed ? "expanded" : "collapsed",
            );
          }}
        >
          ◧
        </button>
        <a className="admin-brand" href="/admin/accounts">
          <span className="admin-mark">W</span>
          <span className="admin-nav-label">WorkAgent</span>
        </a>
        <span className="admin-eyebrow">管理空间</span>
        <nav aria-label="管理导航">
          <button
            aria-label="账户与额度"
            title="账户与额度"
            aria-current={view === "accounts" ? "page" : undefined}
            onClick={() => setView("accounts")}
          >
            <span>◫</span>
            <span className="admin-nav-label">账户与额度</span>
          </button>
          <button
            aria-label="操作记录"
            title="操作记录"
            aria-current={view === "audit" ? "page" : undefined}
            onClick={() => setView("audit")}
          >
            <span>≡</span>
            <span className="admin-nav-label">操作记录</span>
          </button>
        </nav>
        <div className="admin-sidebar-bottom">
          <a
            href="/?frontend=dsh"
            aria-label="返回工作空间"
            title="返回工作空间"
          >
            ↗ <span className="admin-nav-label">返回工作空间</span>
          </a>
          <div className="admin-identity">
            <span className="admin-avatar">
              {username.slice(0, 1).toUpperCase()}
            </span>
            <div className="admin-nav-label">
              <strong>{username}</strong>
              <small>管理员</small>
            </div>
            <button
              onClick={() =>
                void onLogout().catch((e) => setError(errorMessage(e)))
              }
              aria-label="退出登录"
            >
              退出
            </button>
          </div>
        </div>
      </aside>
      <div className="admin-main">
        <header className="admin-topbar">
          <span>
            管理空间 <span className="admin-slash">/</span>{" "}
            {view === "accounts" ? "账户与额度" : "操作记录"}
          </span>
          <span className="admin-status">管理控制台</span>
        </header>
        {view === "accounts" ? (
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
        ) : (
          <AuditLog />
        )}
      </div>
      {create && (
        <Dialog title="创建账户" onClose={() => setCreate(false)}>
          <ActionForm
            submit="创建账户"
            onSubmit={async (data) => {
              const r = await adminApi.create(
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
    </main>
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
