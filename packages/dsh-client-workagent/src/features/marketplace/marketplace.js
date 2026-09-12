import { MarketplaceDetail } from "./detail.js";

export function createMarketplace({
  React,
  h,
  request,
  Section,
  Button,
  Card,
  Field,
  Input,
  useResource,
  Status,
  friendlyError,
  PublishForm,
}) {
  const endpoint = "/api/portal/marketplace",
    kinds = { skill: "技能", mcp: "MCP", assistant: "助手" };
  const explain = (message) =>
    ({
      market_update_session_busy: "相关任务正在执行，请完成后再更新。",
      market_credentials_required: "这个版本需要连接凭据，请填写后重试。",
      project_owner_required: "只有项目负责人可以调整订阅。",
      market_skill_revoked: "此版本已被管理员撤销。",
      project_capability_unavailable: "项目订阅的版本暂不可用，请联系负责人。",
      market_security_update_pending: "管理员正在处理安全更新，请稍后重试。",
      professional_database_disabled: "请联系管理员开通专业数据库。",
      professional_database_unavailable: "专业数据库服务暂不可用，请稍后重试。",
    })[message] || friendlyError(message);
  function MarketplaceSection() {
    const [catalog, refresh] = useResource(endpoint, (v) => v.entries || []),
      [projects] = useResource(
        "/api/portal/shared-projects",
        (v) => v.projects || [],
      );
    const [personalProjects] = useResource("/api/runtime/v1/workspaces");
    const [project, setProject] = React.useState(
      () => new URLSearchParams(location.search).get("marketProject") || "",
    );
    const [subscriptions, setSubscriptions] = React.useState([]),
      [canManage, setCanManage] = React.useState(false);
    const [query, setQuery] = React.useState(""),
      [kind, setKind] = React.useState("all"),
      [busy, setBusy] = React.useState(""),
      [error, setError] = React.useState(""),
      [notice, setNotice] = React.useState("");
    const [publishing, setPublishing] = React.useState(null),
      [history, setHistory] = React.useState(null),
      [detail, setDetail] = React.useState(null),
      [credentials, setCredentials] = React.useState(null);
    const projectURL = project
      ? project.startsWith("personal:")
        ? `/api/portal/projects/${encodeURIComponent(project.slice(9))}/capabilities`
        : `/api/portal/shared-projects/${encodeURIComponent(project)}/capabilities`
      : "";
    async function reloadProject() {
      if (!projectURL) {
        setSubscriptions([]);
        setCanManage(true);
        return;
      }
      const value = await request(projectURL);
      setSubscriptions(value.subscriptions || []);
      setCanManage(value.canManage);
    }
    React.useEffect(() => {
      let alive = true;
      setError("");
      setSubscriptions([]);
      setCanManage(!project);
      if (projectURL)
        request(projectURL)
          .then((v) => {
            if (alive) {
              setSubscriptions(v.subscriptions || []);
              setCanManage(v.canManage);
            }
          })
          .catch((e) => {
            if (alive) setError(explain(e.message));
          });
      return () => {
        alive = false;
      };
    }, [projectURL]);
    const currentFor = (row) =>
      project
        ? subscriptions.find((s) => s.entry.seriesId === row.seriesId)?.entry
        : row.selectedId
          ? { id: row.selectedId, version: row.installedVersion }
          : null;
    async function versions(row) {
      setError("");
      try {
        const v = await request(
          `${endpoint}/versions?seriesId=${encodeURIComponent(row.seriesId)}`,
        );
        setHistory({ row, versions: v.versions });
      } catch (e) {
        setError(explain(e.message));
      }
    }
    async function apply(row, operation, secrets) {
      setBusy(row.id);
      setError("");
      setNotice("");
      try {
        const path = project
          ? projectURL
          : `${endpoint}/${operation === "install" ? "install" : "update"}`;
        const result = await request(path, {
          method: "POST",
          body: JSON.stringify({
            id: row.id,
            ...(secrets ? { credentials: secrets } : {}),
          }),
        });
        const failure = result.results?.find((v) => !v.success);
        if (failure) throw new Error(failure.error);
        await refresh();
        await reloadProject();
        setCredentials(null);
        setHistory(null);
        setNotice(
          project
            ? "项目订阅已保存，后续执行将使用选定版本。其他项目保持自己的版本。"
            : operation === "install"
              ? "已获取。可在助手设置中选择这项能力。"
              : "版本已切换，原会话和历史保留。项目订阅保持原版本。",
        );
      } catch (e) {
        if (e.message === "market_credentials_required" && !secrets) {
          try {
            const detail = await request(
              `${endpoint}?id=${encodeURIComponent(row.id)}`,
            );
            setCredentials({ ...detail, row, operation });
          } catch (cause) {
            setError(explain(cause.message));
          }
        } else setError(explain(e.message));
      } finally {
        setBusy("");
      }
    }
    async function updateAll() {
      setBusy("all");
      setError("");
      setNotice("");
      try {
        let results = [];
        if (project) {
          for (const s of subscriptions.filter((v) => v.updateAvailable)) {
            try {
              await request(projectURL, {
                method: "POST",
                body: JSON.stringify({ id: s.latest.id }),
              });
              results.push({ success: true });
            } catch (e) {
              results.push({
                success: false,
                error: `${s.entry.name}：${explain(e.message)}`,
              });
            }
          }
        } else {
          const v = await request(`${endpoint}/update`, {
            method: "POST",
            body: JSON.stringify({ all: true }),
          });
          results = v.results || [];
        }
        await refresh();
        await reloadProject();
        const failed = results.filter((v) => !v.success);
        setNotice(
          `已更新 ${results.filter((v) => v.success).length} 项${failed.length ? `，${failed.length} 项未完成，请分别打开处理。` : "。"}`,
        );
        if (failed.length)
          setError(failed.map((v) => explain(v.error)).join("；"));
      } catch (e) {
        setError(explain(e.message));
      } finally {
        setBusy("");
      }
    }
    async function unsubscribe(row) {
      setBusy(row.id);
      setError("");
      try {
        await request(
          `${projectURL}?seriesId=${encodeURIComponent(row.seriesId)}`,
          { method: "DELETE" },
        );
        await reloadProject();
        setNotice("已取消项目订阅，个人安装和其他项目不受影响。");
      } catch (e) {
        setError(explain(e.message));
      } finally {
        setBusy("");
      }
    }
    const rows = catalog.rows.filter(
      (r) =>
        (!project || r.kind !== "assistant") &&
        (kind === "all" || r.kind === kind) &&
        `${r.name} ${r.description} ${r.publisher}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    );
    const updateCount = project
      ? subscriptions.filter((s) => s.updateAvailable).length
      : catalog.rows.filter((r) => r.updateAvailable).length;
    const action = (row) => {
      const current = currentFor(row);
      return h(
        Button,
        {
          disabled: !!busy || !canManage,
          onClick: () =>
            apply(row, current && current.id !== row.id ? "update" : "install"),
        },
        busy === row.id
          ? "处理中…"
          : current?.id === row.id
            ? "当前版本"
            : current
              ? (
                  project
                    ? subscriptions.find(
                        (s) => s.entry.seriesId === row.seriesId,
                      )?.updateAvailable
                    : row.updateAvailable
                )
                ? "更新"
                : "使用此版本"
              : project
                ? "订阅此版本"
                : "获取",
      );
    };
    return h(
      Section,
      { title: "市场" },
      h(
        "div",
        { className: "workagent-market-toolbar" },
        h("input", {
          type: "search",
          "aria-label": "搜索市场",
          placeholder: "搜索技能、MCP 或助手",
          value: query,
          onChange: (e) => setQuery(e.target.value),
        }),
        h(
          Button,
          { onClick: () => setPublishing(publishing ? null : {}) },
          publishing ? "收起发布" : "发布到市场",
        ),
      ),
      h(
        "label",
        { className: "workagent-market-scope" },
        "能力使用范围",
        h(
          "select",
          {
            "aria-label": "能力使用范围",
            value: project,
            disabled: !!busy,
            onChange: (e) => {
              setProject(e.target.value);
              setHistory(null);
              setCredentials(null);
            },
          },
          h("option", { value: "" }, "我的能力"),
          h("option", { value: "personal:default" }, "个人项目 · 默认项目"),
          ...personalProjects.rows
            .filter((p) => p.id !== "default")
            .map((p) =>
              h(
                "option",
                { key: `personal:${p.id}`, value: `personal:${p.id}` },
                `个人项目 · ${p.name}`,
              ),
            ),
          ...projects.rows.map((p) =>
            h("option", { key: p.id, value: p.id }, `协作项目 · ${p.name}`),
          ),
        ),
      ),
      h(
        "p",
        { className: "workagent-muted" },
        project
          ? "项目固定使用订阅时选定的版本，不会自动升级。所有成员可查看，负责人可更新。这里订阅技能与 MCP；助手可在项目成员中添加。"
          : "新版本只会提示，由你决定是否升级；可在版本记录中回退。管理员安全处置除外。",
      ),
      h(
        Button,
        { disabled: !!busy || !canManage || !updateCount, onClick: updateAll },
        busy === "all"
          ? "正在更新…"
          : `一键更新${updateCount ? `（${updateCount}）` : ""}`,
      ),
      h(
        "nav",
        { className: "workagent-tabs", "aria-label": "市场分类" },
        ...[["all", "全部"], ...Object.entries(kinds)].map(([value, label]) =>
          h(
            Button,
            {
              key: value,
              "aria-pressed": kind === value,
              onClick: () => setKind(value),
            },
            label,
          ),
        ),
      ),
      publishing
        ? h(PublishForm, {
            entry: publishing.id ? publishing : undefined,
            onPublished: async () => {
              setPublishing(null);
              await refresh();
              setNotice("版本已发布，用户可自行选择更新。");
            },
          })
        : null,
      error
        ? h("p", { role: "alert", className: "workagent-error" }, error)
        : null,
      notice ? h("p", { role: "status" }, notice) : null,
      h(Status, { state: catalog }),
      ...rows.map((row) => {
        const current = currentFor(row);
        return h(
          Card,
          {
            key: row.id,
            title: row.name,
            detail: `${kinds[row.kind]} · 最新 ${row.version} · ${row.publisher}`,
          },
          h("p", null, row.description),
          h(
            "p",
            null,
            current
              ? `当前${project ? "订阅" : "安装"}：${current.version}`
              : "尚未获取",
          ),
          row.releaseNotes
            ? h("p", { className: "workagent-release-notes" }, row.releaseNotes)
            : null,
          row.skills?.length
            ? h("p", null, `包含技能：${row.skills.join("、")}`)
            : null,
          row.mcp?.length
            ? h("p", null, `包含 MCP：${row.mcp.join("、")}`)
            : null,
          action(row),
          row.kind === "mcp"
            ? h(Button, { onClick: () => setDetail(row) }, "详情")
            : null,
          h(
            Button,
            { disabled: !!busy, onClick: () => versions(row) },
            "版本记录",
          ),
          project && current && canManage
            ? h(
                Button,
                { disabled: !!busy, onClick: () => unsubscribe(row) },
                "取消订阅",
              )
            : null,
          row.canDelete
            ? h(
                Button,
                { disabled: !!busy, onClick: () => setPublishing(row) },
                "发布新版本",
              )
            : null,
          row.canDelete
            ? h(
                Button,
                {
                  disabled: !!busy,
                  onClick: async () => {
                    setBusy(row.id);
                    try {
                      await request(
                        `${endpoint}?id=${encodeURIComponent(row.id)}`,
                        { method: "DELETE" },
                      );
                      await refresh();
                      setNotice("此版本已下架，已安装的副本仍可使用。");
                    } catch (e) {
                      setError(explain(e.message));
                    } finally {
                      setBusy("");
                    }
                  },
                },
                "下架此版本",
              )
            : null,
        );
      }),
      project
        ? subscriptions
            .filter(
              (s) => !catalog.rows.some((r) => r.seriesId === s.entry.seriesId),
            )
            .map((s) =>
              h(
                Card,
                {
                  key: s.entry.id,
                  title: s.entry.name,
                  detail: `项目订阅 ${s.entry.version}${s.entry.revoked ? " · 已撤销" : " · 已下架"}`,
                },
                canManage
                  ? h(
                      Button,
                      { onClick: () => unsubscribe(s.entry) },
                      "取消订阅",
                    )
                  : null,
              ),
            )
        : null,
      !catalog.loading && !rows.length
        ? h("p", null, "暂无匹配内容，可以发布自己的能力。")
        : null,
      detail
        ? h(MarketplaceDetail, {
            key: `detail:${detail.id}`,
            row: detail,
            request,
            explain,
            onClose: () => setDetail(null),
          })
        : null,
      history
        ? h(
            "section",
            { className: "workagent-market-history", "aria-label": "版本记录" },
            h("h3", null, `${history.row.name} · 版本记录`),
            h(Button, { onClick: () => setHistory(null) }, "关闭版本记录"),
            ...history.versions.map((v) =>
              h(
                Card,
                {
                  key: v.id,
                  title: v.version,
                  detail: new Date(v.createdAt).toLocaleString(),
                },
                h(
                  "p",
                  { className: "workagent-release-notes" },
                  v.releaseNotes || "此版本尚未填写更新说明。",
                ),
                h(
                  Button,
                  {
                    disabled:
                      !!busy ||
                      !canManage ||
                      currentFor(history.row)?.id === v.id,
                    onClick: () =>
                      apply(v, currentFor(history.row) ? "update" : "install"),
                  },
                  currentFor(history.row)?.id === v.id
                    ? "当前版本"
                    : `使用 ${v.version}`,
                ),
              ),
            ),
          )
        : null,
      credentials
        ? h(
            "form",
            {
              className: "workagent-market-credentials",
              onSubmit: (e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget),
                  values = {};
                for (const m of credentials.bundle.mcp) {
                  values[m.id] = {};
                  for (const name of m.credentialNames)
                    values[m.id][name] = String(
                      form.get(`${m.id}:${name}`) || "",
                    );
                }
                apply(credentials.row, credentials.operation, values);
              },
            },
            h("h3", null, `配置 ${credentials.row.name}`),
            ...credentials.bundle.mcp.flatMap((m) =>
              m.credentialNames.map((name) =>
                h(
                  Field,
                  { key: `${m.id}:${name}`, label: `${m.name} · ${name}` },
                  h(Input, {
                    name: `${m.id}:${name}`,
                    type: "password",
                    autoComplete: "new-password",
                    required: true,
                  }),
                ),
              ),
            ),
            h(Button, { type: "submit", disabled: !!busy }, "保存并继续"),
            h(Button, { onClick: () => setCredentials(null) }, "取消"),
          )
        : null,
    );
  }
  return { MarketplaceSection };
}
