import { useEffect, useState } from "react";
import {
  adminApi,
  post,
  errorMessage,
  type Employee,
  type Job,
} from "./adminApi.js";
import { Dialog, ActionForm, Password } from "./adminUi.js";
import { DollarBudgets } from "./DollarUsage.js";
import { StorageEditor } from "./StorageEditor.js";
export function EmployeePanel({
  employee: u,
  sources,
  onClose,
  onUpdate,
}: {
  employee: Employee;
  sources: string[];
  onClose: () => void;
  onUpdate: () => Promise<void>;
}) {
  const [tab, setTab] = useState("quota"),
    [action, setAction] = useState("");
  const jobKey = `workagent:employee-maintenance:${u.username}`;
  const [job, setJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState("");
  useEffect(() => {
    setJob(null);
    setJobError("");
    const id = localStorage.getItem(jobKey);
    if (!id) return;
    let cancelled = false;
    void adminApi
      .job(id)
      .then(({ job }) => {
        if (!cancelled) setJob(job);
      })
      .catch((e) => {
        if (!cancelled) setJobError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [jobKey]);
  useEffect(() => {
    if (!job || job.status !== "running") return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void adminApi
        .job(job.id)
        .then(({ job: next }) => {
          if (cancelled) return;
          setJobError("");
          setJob(next);
          if (next.status !== "running") void onUpdate();
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
  const actions: Record<string, string> = {
    "reset-password": "重置密码",
    repair: "修复服务",
    restart: "重启服务",
    "rename-windows": "修改 Windows 用户名",
    "set-limits": "资源限制",
    "offboard-retain": "离职并保留数据",
    "offboard-delete": "永久删除账户",
    enable: "启用账户",
    disable: "停用账户",
  };
  return (
    <Dialog title={u.username} onClose={onClose} wide>
      <p className="admin-hint">
        {u.windows_username} ·{" "}
        {u.offboarded ? "已离职" : u.enabled ? "正常使用" : "已停用"}
      </p>
      {job && (
        <div className="admin-job" role="status">
          <strong>
            {job.status === "running"
              ? "服务维护进行中"
              : job.status === "succeeded"
                ? "服务维护已完成"
                : "服务维护未完成"}
          </strong>
          <p>
            {job.status === "running"
              ? "操作在后台继续执行，刷新页面后可查看结果。"
              : job.status === "failed"
                ? job.error_message
                : "员工服务已通过检查。"}
          </p>
          <progress max="100" value={job.percent} />
        </div>
      )}
      {jobError && <p role="alert">{jobError}</p>}
      <div className="admin-tabs" role="tablist" aria-label="账户管理">
        {[
          ["quota", "使用额度"],
          ["storage", "磁盘空间"],
          ["service", "账户与服务"],
          ["datasource", "数据源"],
        ].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => {
              setTab(id);
              setAction("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "quota" && <DollarBudgets username={u.username} />}
      {tab === "storage" && <StorageEditor key={u.username} username={u.username} />}
      {tab === "datasource" && sources.length === 0 && (
        <p className="admin-empty">当前部署尚未接入 Kimi 数据源服务。</p>
      )}
      {tab === "datasource" && sources.length > 0 && (
        <ActionForm
          key="datasource"
          onSubmit={async (data) => {
            await post("/api/portal/admin/users/kimi-datasource", {
              username: u.username,
              enabled: data.get("enabled") === "on",
              allowed_sources: data.getAll("sources"),
              daily_limit: Number(data.get("daily")),
              monthly_limit: Number(data.get("monthly")),
            });
            await onUpdate();
          }}
        >
          <label className="admin-check">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={u.kimi_datasource?.enabled}
            />
            允许使用 Kimi 数据源
          </label>
          <div className="admin-two">
            <label>
              每日次数
              <input
                type="number"
                name="daily"
                min="0"
                step="1"
                required
                defaultValue={u.kimi_datasource?.daily_limit ?? 0}
              />
            </label>
            <label>
              每月次数
              <input
                type="number"
                name="monthly"
                min="0"
                step="1"
                required
                defaultValue={u.kimi_datasource?.monthly_limit ?? 0}
              />
            </label>
          </div>
          <p className="admin-hint">
            今日已用 {u.kimi_datasource?.daily_used ?? 0} · 本月已用{" "}
            {u.kimi_datasource?.monthly_used ?? 0}；每月上限须不小于每日上限。
          </p>
          <div className="admin-source-list">
            {sources.map((source) => (
              <label className="admin-check" key={source}>
                <input
                  type="checkbox"
                  name="sources"
                  value={source}
                  defaultChecked={u.kimi_datasource?.allowed_sources?.includes(
                    source,
                  )}
                />
                {source}
              </label>
            ))}
          </div>
        </ActionForm>
      )}
      {tab === "service" && (
        <>
          <div className="admin-action-list">
            {(u.offboarded
              ? ["offboard-delete"]
              : [
                  u.enabled ? "disable" : "enable",
                  "reset-password",
                  ...(u.enabled ? ["restart"] : []),
                  "repair",
                  "rename-windows",
                  "set-limits",
                  "offboard-retain",
                ]
            ).map((id) => (
              <button
                key={id}
                disabled={job?.status === "running"}
                className={action === id ? "selected" : ""}
                onClick={() => setAction(id)}
              >
                {actions[id]} <span>›</span>
              </button>
            ))}
          </div>
          {action && (
            <section className="admin-action-detail">
              <h3>{actions[action]}</h3>
              <ActionForm
                key={action}
                submit={actions[action]}
                danger={action.includes("offboard") || action === "disable"}
                onSubmit={async (data) => {
                  const fields: Record<string, unknown> = {};
                  for (const [key, value] of data) fields[key] = value;
                  if (action === "set-limits")
                    fields.limits = {
                      memory_bytes: Math.round(
                        Number(data.get("memory")) * 1024 ** 3,
                      ),
                      cpu_percent: Number(data.get("cpu")),
                      active_processes: Number(data.get("processes")),
                    };
                  const result = await adminApi.action(
                    u.username,
                    action,
                    fields,
                  );
                  if (result.job) {
                    localStorage.setItem(jobKey, result.job.id);
                    setJob(result.job);
                    setJobError("");
                  }
                  await onUpdate();
                  setAction("");
                  if (action === "offboard-delete") onClose();
                }}
              >
                {action === "reset-password" && (
                  <Password label="新密码" name="portal_password" />
                )}
                {["repair", "rename-windows"].includes(action) && (
                  <p className="admin-hint">
                    服务凭据由系统管理，此操作不会重置 Windows 密码。
                  </p>
                )}
                {action === "rename-windows" && (
                  <label>
                    新的 Windows 用户名
                    <input name="new_windows_username" required />
                  </label>
                )}
                {action === "set-limits" && (
                  <>
                    <p className="admin-hint">
                      保存后会重启员工服务。内存至少 0.25 GiB，CPU 为
                      1–100%，进程数至少 3。请填写三个项目以替换当前资源配置。
                    </p>
                    <div className="admin-two">
                      <label>
                        内存上限（GiB）
                        <input
                          name="memory"
                          type="number"
                          min="0.25"
                          step="0.25"
                          required
                        />
                      </label>
                      <label>
                        CPU 上限（%）
                        <input
                          name="cpu"
                          type="number"
                          min="1"
                          max="100"
                          required
                        />
                      </label>
                      <label>
                        进程数上限
                        <input
                          name="processes"
                          type="number"
                          min="3"
                          required
                        />
                      </label>
                    </div>
                  </>
                )}
                {action === "disable" && (
                  <p>停用后该账户无法登录，正在运行的服务会停止。</p>
                )}
                {action === "enable" && <p>恢复该账户的登录权限和员工服务。</p>}
                {action === "offboard-retain" && (
                  <p>停止服务并移除访问权限，保留账户数据供后续处理。</p>
                )}
                {action === "offboard-delete" && (
                  <>
                    <p>此操作会永久删除已离职账户及其保留数据。</p>
                    <label>
                      输入 DELETE {u.username} 确认
                      <input
                        name="confirmation"
                        required
                        onInput={(e) =>
                          e.currentTarget.setCustomValidity(
                            e.currentTarget.value === `DELETE ${u.username}`
                              ? ""
                              : "请输入完整确认文本",
                          )
                        }
                      />
                    </label>
                  </>
                )}
              </ActionForm>
            </section>
          )}
        </>
      )}
    </Dialog>
  );
}
