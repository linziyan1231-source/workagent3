import { useState } from "react";
import { AccountsPage } from "./accounts/AccountsPage.js";
import { useAccountDirectory } from "./accounts/useAccountDirectory.js";
import { AuditLog } from "./audit/AuditLog.js";
import { FeedbackInbox } from "./feedback/FeedbackInbox.js";
import { AcpCatalog } from "./acp/AcpCatalog.js";
import { MarketManagement } from "./market/MarketManagement.js";
import { PublishingSettingsPanel } from "./publishing/PublishingSettings.js";
import { errorMessage } from "./shared/adminErrors.js";
import "./AdminPortal.css";
export function AdminPortal({
  username,
  onLogout,
}: {
  username: string;
  onLogout: () => Promise<void>;
}) {
  const directory = useAccountDirectory();
  const [view, setView] = useState("accounts");
  const [logoutError, setLogoutError] = useState("");
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("workagent.admin.sidebar") !== "expanded",
  );
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
          <button aria-label="ACP 引擎" title="ACP 引擎" aria-current={view === "acp" ? "page" : undefined} onClick={() => setView("acp")}><span>⚙</span><span className="admin-nav-label">ACP 引擎</span></button>
          <button aria-label="问题反馈" title="问题反馈" aria-current={view==="feedback"?"page":undefined} onClick={()=>setView("feedback")}><span>✉</span><span className="admin-nav-label">问题反馈</span></button>
          <button
            aria-label="市场能力"
            title="市场能力"
            aria-current={view === "market" ? "page" : undefined}
            onClick={() => setView("market")}
          >
            <span>◇</span>
            <span className="admin-nav-label">市场能力</span>
          </button>
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
            aria-label="应用发布"
            title="应用发布"
            aria-current={view === "publishing" ? "page" : undefined}
            onClick={() => setView("publishing")}
          >
            <span>↥</span>
            <span className="admin-nav-label">应用发布</span>
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
                void onLogout().catch((e) => setLogoutError(errorMessage(e)))
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
            {view === "accounts"
              ? "账户与额度"
              : view === "market"
                ? "市场能力"
                : view === "publishing"
                  ? "应用发布"
                  : view === "feedback" ? "问题反馈" : view === "acp" ? "ACP 引擎" : "操作记录"}
          </span>
          <span className="admin-status">管理控制台</span>
        </header>
        {logoutError && <p role="alert">{logoutError}</p>}
        <AccountsPage active={view === "accounts"} directory={directory} />
        {view === "market" && <MarketManagement users={directory.users} />}
        {view === "publishing" && <PublishingSettingsPanel />}
        {view === "audit" && <AuditLog />}
        {view === "feedback" && <FeedbackInbox />}
        {view === "acp" && <AcpCatalog />}
      </div>
    </main>
  );
}
