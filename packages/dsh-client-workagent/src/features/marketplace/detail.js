import React, { createElement as h } from "react";
import { Dialog } from "../../ui/dialog.js";
import { Button } from "../../ui/elements.js";

const sourceLabels = {
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

export function MarketplaceDetail({ row, request, explain, onClose }) {
  const [state, setState] = React.useState({
    loading: true,
    value: null,
    error: "",
  });
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    const controller = new AbortController();
    setState({ loading: true, value: null, error: "" });
    request(`/api/portal/marketplace?id=${encodeURIComponent(row.id)}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((value) => {
        if (!controller.signal.aborted)
          setState({ loading: false, value, error: "" });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setState({
            loading: false,
            value: null,
            error: explain(cause.message),
          });
      });
    return () => controller.abort();
  }, [row.id, revision]);

  const entry = state.value?.entry;
  const quota = state.value?.professionalDatabase;
  return h(
    Dialog,
    {
      title: `${row.name} · 详情`,
      onClose,
      className: "workagent-market-detail",
    },
    state.loading
      ? h("p", { role: "status" }, "正在加载详情与调用次数…")
      : null,
    state.error
      ? h(
          "p",
          { role: "alert", className: "workagent-error" },
          `详情加载失败：${state.error}`,
        )
      : null,
    entry
      ? h(
          React.Fragment,
          null,
          h(
            "p",
            { className: "workagent-muted" },
            `版本 ${entry.version} · ${entry.publisher}${entry.defaultEnabled === false ? " · 默认关闭" : ""}`,
          ),
          h("p", { className: "workagent-release-notes" }, entry.description),
          entry.releaseNotes
            ? h(
                "p",
                { className: "workagent-release-notes" },
                `更新说明：${entry.releaseNotes}`,
              )
            : null,
        )
      : null,
    quota
      ? h(
          "section",
          { "aria-label": "我的专业数据库调用次数" },
          h("h3", null, "我的调用次数"),
          h(
            "p",
            { className: "workagent-muted" },
            "数据通过 Kimi 专业数据服务查询，实际可用数据取决于上游授权。",
          ),
          quota.configured && quota.upstream_ready === false
            ? h(
                "div",
                { role: "status" },
                h("strong", null, "服务待授权"),
                h(
                  "p",
                  null,
                  "管理员尚需完成 Kimi 服务授权。授权完成前无法查询，不扣调用次数；账户额度可预先配置。",
                ),
              )
            : null,
          h(
            "p",
            { className: "workagent-muted" },
            !quota.configured
              ? "尚未配置调用额度，请联系管理员。"
              : !quota.enabled
                ? "未开通，当前不可调用。请联系管理员开通专业数据库。"
                : "已开通 · 所有项目共用当前账户的调用次数。",
          ),
          quota.configured
            ? h(
                React.Fragment,
                null,
                h(
                  "div",
                  { className: "workagent-market-quota-grid" },
                  ...[
                    [
                      "今日",
                      quota.daily_remaining,
                      quota.daily_limit,
                      quota.daily_used,
                    ],
                    [
                      "本月",
                      quota.monthly_remaining,
                      quota.monthly_limit,
                      quota.monthly_used,
                    ],
                  ].map(([period, remaining, total, used]) =>
                    h(
                      "section",
                      {
                        key: period,
                        className: "workagent-market-quota",
                        "aria-label": `${period}调用次数`,
                      },
                      h("h4", null, period),
                      h("p", null, "剩余调用次数 / 总可调用次数"),
                      h(
                        "p",
                        { className: "workagent-market-quota-count" },
                        h("strong", null, remaining),
                        " / ",
                        total,
                      ),
                      h(
                        "p",
                        { className: "workagent-muted" },
                        `已用 ${used} 次`,
                      ),
                    ),
                  ),
                ),
                quota.enabled &&
                  (quota.daily_remaining === 0 || quota.monthly_remaining === 0)
                  ? h(
                      "p",
                      null,
                      "当前可用次数为 0，暂时无法调用。可等待额度重置或联系管理员调整次数。",
                    )
                  : null,
                h(
                  "p",
                  { className: "workagent-muted" },
                  "每日 00:00、每月 1 日 00:00 按北京时间（Asia/Shanghai）重置对应周期的已用次数；每日与每月上限同时生效。",
                ),
                h("p", { className: "workagent-muted" }, quota.counting_rule),
                h("h4", null, "允许的数据源"),
                h(
                  "p",
                  { className: "workagent-market-sources" },
                  quota.allowed_sources.length
                    ? quota.allowed_sources
                        .map((source) => sourceLabels[source] || source)
                        .join("、")
                    : "未授权任何数据源，当前不可调用。",
                ),
              )
            : null,
        )
      : null,
    h(
      "div",
      { className: "workagent-dialog-actions" },
      h(
        Button,
        {
          disabled: state.loading,
          onClick: () => setRevision((value) => value + 1),
        },
        state.loading ? "正在刷新…" : "刷新详情与调用次数",
      ),
    ),
  );
}
