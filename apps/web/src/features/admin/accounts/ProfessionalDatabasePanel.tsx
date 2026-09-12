import { useEffect, useState, type FormEvent } from "react";
import { accountApi, type Employee } from "./accountApi.js";
import { errorMessage } from "../shared/adminErrors.js";

const sourceLabels: Record<string, string> = {
  stock_finance_data: "沪深股票财务数据",
  yahoo_finance: "雅虎财经",
  world_bank_open_data: "世界银行开放数据",
  tianyancha: "天眼查",
  arxiv: "arXiv 论文",
  scholar: "学术论文",
  yuandian_law: "元典法律",
  wind: "Wind 金融数据",
  imf: "国际货币基金组织（IMF）",
  gildata: "恒生聚源",
  sec_edgar: "美国证券交易委员会（SEC）",
  sp_data: "标普全球（S&P）",
  china_nda: "国家数据局",
  china_nbs: "国家统计局",
  china_standards: "国家标准",
  who: "世界卫生组织（WHO）",
  fao: "联合国粮农组织（FAO）",
  unsd: "联合国统计司（UNSD）",
  ecb: "欧洲中央银行（ECB）",
  eurostat: "欧盟统计局",
  unicef: "联合国儿童基金会（UNICEF）",
  oecd: "经济合作与发展组织（OECD）",
  fred: "美联储经济数据（FRED）",
  xhcj: "新华财经",
  caixin: "财新",
};

export function ProfessionalDatabasePanel({
  employee,
  sources,
  onUpdate,
}: {
  employee: Employee;
  sources: string[];
  onUpdate: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [grant, setGrant] = useState(employee.kimi_datasource);
  useEffect(
    () => setGrant(employee.kimi_datasource),
    [employee.kimi_datasource],
  );

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    const data = new FormData(event.currentTarget);
    const daily = Number(data.get("daily"));
    const monthly = Number(data.get("monthly"));
    const enabled = data.get("enabled") === "on";
    const allowedSources = data.getAll("sources").map(String);
    if (
      !Number.isSafeInteger(daily) ||
      !Number.isSafeInteger(monthly) ||
      daily < 0 ||
      monthly < 0
    ) {
      setError("调用次数须为非负整数，0 表示不可调用。");
      return;
    }
    if (monthly < daily) {
      setError("每月总可调用次数不能小于每日总可调用次数。");
      return;
    }
    if (daily > 10000 || monthly > 100000) {
      setError("每日总可调用次数最多 10000 次，每月最多 100000 次。");
      return;
    }
    if (enabled && !allowedSources.length) {
      setError("启用专业数据库时，请至少选择一个数据源。");
      return;
    }
    setBusy(true);
    try {
      await accountApi.setDatasource(employee.username, {
        enabled,
        allowed_sources: allowedSources,
        daily_limit: daily,
        monthly_limit: monthly,
      });
      setNotice("调用权限与次数已保存。");
      await onUpdate();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await accountApi.users();
      const current = result.users.find(
        (user) => user.username === employee.username,
      );
      if (!current) {
        setError("该账户已不在当前员工列表中，请重新打开账户管理。");
        return;
      }
      setGrant(current.kimi_datasource);
      setNotice("调用次数已刷新。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!sources.length) {
    return <p className="admin-empty">当前部署尚未配置专业数据库服务。</p>;
  }

  return (
    <section aria-label="专业数据库调用管理">
      <p className="admin-hint">
        {grant?.enabled ? "已启用" : "未启用，当前不可调用"} ·
        此账户通过市场获取专业数据库 MCP 后，可按以下权限与次数查询 Kimi
        专业数据服务。
      </p>
      <div className="admin-two" aria-label="当前调用次数">
        {(
          [
            ["今日", grant?.daily_limit ?? 0, grant?.daily_used ?? 0],
            ["本月", grant?.monthly_limit ?? 0, grant?.monthly_used ?? 0],
          ] as const
        ).map(([period, limit, used]) => (
          <section key={period} aria-label={`${period}调用次数`}>
            <h3>{period}</h3>
            <p>
              剩余调用次数 <strong>{Math.max(0, limit - used)}</strong> /
              总可调用次数 <strong>{limit}</strong>
            </p>
            <p className="admin-hint">已用 {used} 次</p>
          </section>
        ))}
      </div>
      <button type="button" disabled={busy} onClick={() => void refresh()}>
        刷新调用次数
      </button>
      <form className="admin-form" onSubmit={(event) => void save(event)}>
        <fieldset
          disabled={busy}
          key={JSON.stringify([
            employee.username,
            grant?.enabled,
            grant?.daily_limit,
            grant?.monthly_limit,
            grant?.allowed_sources,
          ])}
        >
          <label className="admin-check">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={grant?.enabled}
            />
            允许使用专业数据库
          </label>
          <div className="admin-two">
            <label>
              每日总可调用次数
              <input
                type="number"
                name="daily"
                min="0"
                max="10000"
                step="1"
                required
                defaultValue={grant?.daily_limit ?? 0}
              />
            </label>
            <label>
              每月总可调用次数
              <input
                type="number"
                name="monthly"
                min="0"
                max="100000"
                step="1"
                required
                defaultValue={grant?.monthly_limit ?? 0}
              />
            </label>
          </div>
          <p className="admin-hint">
            0 表示不可调用；每日最多 10000 次，每月最多 100000
            次，且每月总次数须不小于每日总次数。调整上限不会清除已用次数。
          </p>
          <p className="admin-hint">
            按北京时间（Asia/Shanghai）每日 00:00、每月 1 日 00:00
            重置对应周期的已用次数。接口说明和数据查询发送到上游后各计 1
            次，已发送但失败的请求也计次。
          </p>
          <h3>允许的数据源</h3>
          <p className="admin-hint">
            只允许访问勾选的数据源；启用时至少选择一个数据源。
          </p>
          <div className="admin-source-list">
            {sources.map((source) => (
              <label className="admin-check" key={source}>
                <input
                  type="checkbox"
                  name="sources"
                  value={source}
                  defaultChecked={grant?.allowed_sources?.includes(source)}
                />
                {sourceLabels[source] || source}
              </label>
            ))}
          </div>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        {notice && (
          <p role="status" className="admin-success">
            {notice}
          </p>
        )}
        <button className="admin-primary" disabled={busy}>
          {busy ? "正在处理…" : "保存调用权限与次数"}
        </button>
      </form>
    </section>
  );
}
