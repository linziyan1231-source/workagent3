import React, { createElement as h } from "react";
import { request } from "../../platform/api.js";
import { Button, Input, Field } from "../../ui/elements.js";
export function PublishedApps({ workspace, entry = "index.html" }) {
  const workspaceId =
    workspace.currentRole && !workspace.id.startsWith("shared:")
      ? `shared:${workspace.id}`
      : workspace.id;
  const [apps, setApps] = React.useState([]),
    [name, setName] = React.useState(workspace.name || "应用"),
    [kind, setKind] = React.useState("static"),
    [entryPath, setEntry] = React.useState(entry),
    [origins, setOrigins] = React.useState(""),
    [error, setError] = React.useState(""),
    [busy, setBusy] = React.useState(false),
    [preview, setPreview] = React.useState(null),
    [access, setAccess] = React.useState("owner"),
    [members, setMembers] = React.useState("");
  const [statuses, setStatuses] = React.useState({});
  const acting = React.useRef(false);
  const frameName = React.useId().replaceAll(":", "");
  const ticketForm = React.useRef(null);
  const load = () =>
    request("/api/portal/apps")
      .then((result) =>
        setApps(result.items.filter((a) => a.workspaceId === workspaceId)),
      )
      .catch((reason) => setError(reason.message));
  React.useEffect(() => {
    void load();
  }, [workspaceId]);
  const act = async (action) => {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason.message);
    } finally {
      await load();
      acting.current = false;
      setBusy(false);
    }
  };
  const post = (url, body) =>
    request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  const showPreview = async (app) => {
    await post(`/api/portal/apps/${app.id}/previews`);
    const ticket = await post(
      `/api/portal/apps/${app.id}/access-ticket?preview=true`,
    );
    setPreview(ticket);
  };
  React.useEffect(() => {
    if (!preview) return;
    const frame = requestAnimationFrame(() => ticketForm.current?.submit());
    return () => cancelAnimationFrame(frame);
  }, [preview, frameName]);
  return h(
    "section",
    { className: "workagent-section" },
    h("h3", null, "应用预览与发布"),
    h(
      "p",
      null,
      "发布会保存入口所在目录的快照。请先把要公开的网页和依赖放入独立目录；应用只使用自己的数据空间。服务器资源计入你的额度。",
    ),
    h(
      "form",
      {
        className: "workagent-form",
        onSubmit: (event) => {
          event.preventDefault();
          void act(async () => {
            const app = await post("/api/portal/apps", {
              workspaceId,
              name,
              kind,
              entry: entryPath,
              allowedOrigins: origins.split(/[,\s]+/).filter(Boolean),
            });
            await showPreview(app);
          });
        },
      },
      h(
        Field,
        { label: "应用名称" },
        h(Input, {
          value: name,
          required: true,
          onChange: (e) => setName(e.target.value),
        }),
      ),
      h(
        Field,
        { label: "运行方式" },
        h(
          "select",
          { value: kind, onChange: (e) => setKind(e.target.value) },
          h("option", { value: "static" }, "HTML / JavaScript"),
          h("option", { value: "node" }, "Node.js"),
          h("option", { value: "python" }, "Python"),
        ),
      ),
      h(
        Field,
        { label: "项目内入口路径" },
        h(Input, {
          value: entryPath,
          required: true,
          onChange: (e) => setEntry(e.target.value),
        }),
      ),
      h(
        Field,
        { label: "允许访问的外部 API 来源（可选）" },
        h(Input, {
          value: origins,
          placeholder: "https://api.example.com",
          onChange: (e) => setOrigins(e.target.value),
        }),
      ),
      h(
        Button,
        { type: "submit", disabled: busy },
        busy ? "处理中…" : "创建并预览",
      ),
    ),
    h(
      Field,
      { label: "发布访问范围" },
      h(
        "select",
        { value: access, onChange: (e) => setAccess(e.target.value) },
        h("option", { value: "owner" }, "仅自己"),
        h("option", { value: "members" }, "指定成员"),
        h("option", { value: "authenticated" }, "全站登录用户"),
        h("option", { value: "public" }, "公开免登录"),
      ),
    ),
    access === "members"
      ? h(
          Field,
          { label: "成员用户名（逗号分隔）" },
          h(Input, {
            value: members,
            onChange: (e) => setMembers(e.target.value),
          }),
        )
      : null,
    ...apps.map((app) =>
      h(
        "article",
        { key: app.id },
        h("strong", null, app.name),
        h("span", null, app.enabled ? " · 已发布" : " · 未上线"),
        h(
          Button,
          {
            disabled: busy,
            onClick: () =>
              act(async () => {
                const status = await request(
                  `/api/portal/apps/${app.id}/status?latest=true`,
                );
                setStatuses((current) => ({ ...current, [app.id]: status }));
              }),
          },
          "运行状态与日志",
        ),
        statuses[app.id]
          ? h(
              "div",
              null,
              h(
                "p",
                null,
                `运行状态：${{ running: "运行中", stopped: "已停止", starting: "启动中", failed: "启动失败", idle: "空闲" }[statuses[app.id].state] || statuses[app.id].state}`,
              ),
              statuses[app.id].error
                ? h("p", { role: "alert" }, statuses[app.id].error)
                : null,
              h(
                "pre",
                {
                  style: {
                    whiteSpace: "pre-wrap",
                    maxHeight: "240px",
                    overflow: "auto",
                  },
                },
                statuses[app.id].logTail || "暂无日志",
              ),
            )
          : null,
        h(
          Button,
          { disabled: busy, onClick: () => act(() => showPreview(app)) },
          "预览",
        ),
        h(
          Button,
          {
            disabled: busy,
            onClick: () =>
              act(async () => {
                const updated = await post(
                  `/api/portal/apps/${app.id}/versions`,
                );
                await post(`/api/portal/apps/${app.id}/publish`, {
                  version: updated.versions.at(-1),
                  access,
                  memberUsernames: members.split(/[,\s]+/).filter(Boolean),
                });
              }),
          },
          "发布新版本",
        ),
        app.enabled
          ? h(
              "a",
              { href: `/apps/${app.id}`, target: "_blank", rel: "noopener" },
              "打开应用",
            )
          : null,
        app.enabled
          ? h(Input, {
              readOnly: true,
              value: `${location.origin}/apps/${app.id}`,
              "aria-label": "应用分享链接",
              onFocus: (event) => event.target.select(),
            })
          : null,
        h(
          Button,
          {
            disabled: busy,
            onClick: () =>
              act(() => post(`/api/portal/apps/${app.id}/unpublish`)),
          },
          "停止并下线",
        ),
        app.versions.length > 1
          ? h(
              "select",
              {
                "aria-label": `${app.name}版本`,
                value: app.version || "",
                onChange: (e) =>
                  act(() =>
                    post(`/api/portal/apps/${app.id}/publish`, {
                      version: e.target.value,
                      access: app.access,
                      members: app.members,
                    }),
                  ),
              },
              h("option", { value: "", disabled: true }, "选择版本"),
              ...app.versions.map((version) =>
                h("option", { key: version, value: version }, version),
              ),
            )
          : null,
      ),
    ),
    error ? h("p", { role: "alert" }, error) : null,
    preview
      ? h(
          "form",
          {
            ref: ticketForm,
            method: "POST",
            action: preview.url,
            target: frameName,
            hidden: true,
          },
          h("input", { type: "hidden", name: "ticket", value: preview.ticket }),
        )
      : null,
    preview
      ? h("iframe", {
          name: frameName,
          title: "交互式应用预览",
          sandbox:
            "allow-scripts allow-same-origin allow-forms allow-downloads",
          style: { width: "100%", height: "60vh", border: 0 },
        })
      : null,
  );
}
