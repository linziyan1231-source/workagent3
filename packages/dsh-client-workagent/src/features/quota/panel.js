import { useResource } from "../../platform/resources.js";
import { Status } from "../../ui/elements.js";
import React from "react";
import { createElement as h } from "react";

function QuotaPanel() {
  const [state, refresh] = useResource(
    "/api/quota/dollars",
    (value) => value.budgets || [],
  );
  React.useEffect(() => {
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const remaining = (used, limit) =>
    `${limit > 0 ? Math.round(Math.max(0, Math.min(1, 1 - used / limit)) * 100) : 0}%`;
  const meter = (label, used, limit) => {
    const value = remaining(used, limit);
    return h(
      "div",
      { className: "workagent-quota-row" },
      h("span", null, label),
      h("span", null, value),
      h(
        "div",
        {
          className: "workagent-quota-track",
          role: "progressbar",
          "aria-label": label,
          "aria-valuemin": 0,
          "aria-valuemax": 100,
          "aria-valuenow": parseInt(value, 10),
        },
        h("span", { style: { width: value } }),
      ),
    );
  };
  return h(
    "aside",
    { className: "workagent-quota-panel", "aria-label": "使用额度" },
    h("strong", null, "剩余额度"),
    h(Status, { state }),
    ...state.rows.map((b) =>
      h(
        "div",
        { className: "workagent-dollar-quota", key: b.pool },
        h("strong", null, b.pool === "codex" ? "Codex / ChatGPT" : "Kimi"),
        meter("每日剩余", b.dailyUsd, b.dailyLimitUsd),
        meter("每周剩余", b.weeklyUsd, b.weeklyLimitUsd),
      ),
    ),
    h(
      "span",
      { className: "workagent-muted" },
      "DSH 与 Codex / ChatGPT 共享额度。",
    ),
  );
}

export { QuotaPanel };
