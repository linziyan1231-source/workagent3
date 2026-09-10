export function createShared({ React, request, apiRoot, useResource, Section, Button, Input, Markdown, friendlyError }) {
  const h = React.createElement;
  const Select = ({ children, ...props }) => h("label", { className: "workagent-shared-field" }, h("span", null, props["aria-label"]), h("select", props, children));
  const SharedInput = (props) => h("label", { className: "workagent-shared-field" }, h("span", null, props["aria-label"]), h(Input, props));
  const root = "/api/portal";
  const id = encodeURIComponent;
  const json = (body, method = "POST") => ({ method, body: JSON.stringify(body) });
  function SharedFiles({ projectId }) {
    const [files, setFiles] = React.useState([]);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const operate = async (operation, path, data) => (await request(`${root}/shared-files`, json({ project_id: projectId, operation, path, data }))).data;
    const load = async () => setFiles(await operate("list"));
    React.useEffect(() => {
      const controller = new AbortController();
      request(`${root}/shared-files`, { ...json({ project_id: projectId, operation: "list" }), signal: controller.signal })
        .then((value) => { if (!controller.signal.aborted) setFiles(value.data); })
        .catch((reason) => { if (!controller.signal.aborted) setError(friendlyError(reason.message)); });
      return () => controller.abort();
    }, [projectId]);
    const perform = async (callback) => {
      setBusy(true); setError("");
      try { await callback(); } catch (reason) { setError(friendlyError(reason.message)); }
      finally { setBusy(false); }
    };
    return h("section", { "aria-label": "共享资料" }, h("h4", null, "共享资料"),
      h("p", null, "上传到共享项目根目录，单个最大 6 MiB；同名文件不会被覆盖。"),
      h("input", { type: "file", "aria-label": "上传共享资料", disabled: busy, onChange: (event) => {
        const file = event.target.files[0]; event.target.value = ""; if (!file) return;
        void perform(async () => {
          if (file.size > 6 * 1024 * 1024) throw new Error("共享附件最大 6 MiB。");
          const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("文件读取失败")); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(file); });
          await operate("write-buffer", file.name, data); await load();
        });
      } }),
      h(Button, { disabled: busy, onClick: () => void perform(load) }, "刷新共享资料"),
      ...files.map((file) => h("div", { key: file.relative_path }, file.relative_path,
        h(Button, { disabled: busy, onClick: () => void perform(async () => {
          const encoded = await operate("read-buffer", file.relative_path);
          const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))]));
          const anchor = document.createElement("a"); anchor.href = url; anchor.download = file.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }) }, "下载资料"))), error ? h("p", { role: "alert" }, error) : null);
  }
  function SharedChat({ conversation }) {
    const [messages, setMessages] = React.useState([]);
    const [body, setBody] = React.useState("");
    const [askAI, setAskAI] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    React.useEffect(() => {
      const controller = new AbortController();
      let loading = false;
      const load = async () => {
        if (loading) return;
        loading = true;
        try {
          // Read every page so long conversations do not silently lose their tail.
          let after = 0;
          const rows = [];
          for (;;) {
            const value = await request(`${root}/shared-messages?conversation_id=${id(conversation.id)}&after=${after}&limit=200`, { signal: controller.signal });
            rows.push(...value.messages);
            if (value.messages.length < 200) break;
            after = value.messages.at(-1).seq;
          }
          if (!controller.signal.aborted) { setMessages(rows); setError(""); }
        } catch (reason) { if (!controller.signal.aborted) setError(friendlyError(reason.message)); }
        finally { loading = false; }
      };
      void load();
      const events = new EventSource(`${root}/shared-events`);
      events.onmessage = () => void load();
      events.onopen = () => void load();
      const timer = setInterval(load, 15000);
      return () => { controller.abort(); events.close(); clearInterval(timer); };
    }, [conversation.id]);
    return h("section", { className: "workagent-shared-chat", "aria-label": "共享对话" },
      h("h3", null, conversation.name),
      h("p", null, "成员可发送消息；勾选“请助手回复”后由项目负责人的助手执行。"),
      h("div", { className: "workagent-shared-messages", "aria-live": "polite" }, ...messages.map((message) => h("article", { key: message.id },
        h("small", null, `${message.author_name || (message.kind === "assistant" ? "助手" : "系统")} · ${new Date(message.created_at).toLocaleString()}`),
        h(Markdown, null, message.body)))),
      h("form", { className: "workagent-form", onSubmit: async (event) => {
        event.preventDefault(); if (busy || !body.trim()) return;
        setBusy(true); setError("");
        try {
          const value = await request(`${root}/shared-messages`, json({ conversation_id: conversation.id, body, mentions: askAI ? [{ kind: "assistant", id: conversation.assistant_id }] : [], attachments: [] }));
          setMessages((current) => current.some((item) => item.id === value.message.id) ? current : [...current, value.message]);
          setBody("");
          if (askAI && !value.ai_started) setError("消息已发送，但助手尚未开始执行，请检查运行状态后重试。");
        } catch (reason) { setError(friendlyError(reason.message)); }
        finally { setBusy(false); }
      } },
        h("label", null, "共享消息", h("textarea", { "aria-label": "共享消息", value: body, onChange: (event) => setBody(event.target.value), required: true, maxLength: 100000, rows: 4 })),
        h("label", null, h("input", { type: "checkbox", checked: askAI, onChange: (event) => setAskAI(event.target.checked) }), "请助手回复"),
        h(Button, { type: "submit", disabled: busy }, busy ? "发送中…" : "发送消息"),
        h(Button, { disabled: busy, onClick: async () => {
          setBusy(true);
          try { await request(`${root}/shared-runs/cancel`, json({ conversation_id: conversation.id })); }
          catch (reason) { setError(friendlyError(reason.message)); }
          finally { setBusy(false); }
        } }, "停止助手")),
      error ? h("p", { role: "alert" }, error) : null);
  }
  function SharedPage() {
    const [projects, reloadProjects] = useResource(`${root}/shared-projects?include_hidden=true`, (value) => value.projects);
    const [invites, reloadInvites] = useResource(`${root}/shared-invites`, (value) => value.invites);
    const [conversations, reloadConversations] = useResource(`${root}/shared-conversations?include_hidden=true`, (value) => value.conversations);
    const [presets] = useResource(`${apiRoot}/presets`);
    const [models] = useResource(`${apiRoot}/model-options`);
    const [projectId, setProjectId] = React.useState("");
    const [conversationId, setConversationId] = React.useState("");
    const [members, setMembers] = React.useState([]);
    const [name, setName] = React.useState("");
    const [target, setTarget] = React.useState("");
    const [token, setToken] = React.useState("");
    const [link, setLink] = React.useState(null);
    const [chatName, setChatName] = React.useState("");
    const [presetId, setPresetId] = React.useState("");
    const [modelId, setModelId] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [revision, setRevision] = React.useState(0);
    const project = projects.rows.find((item) => item.id === projectId);
    const conversation = conversations.rows.find((item) => item.id === conversationId && item.project_id === projectId);
    React.useEffect(() => {
      setMembers([]); setLink(null);
      if (!projectId) return;
      const controller = new AbortController();
      request(`${root}/shared-projects/${id(projectId)}/members`, { signal: controller.signal }).then((value) => {
        if (!controller.signal.aborted) setMembers(value.members);
      }).catch((reason) => { if (!controller.signal.aborted) setError(friendlyError(reason.message)); });
      return () => controller.abort();
    }, [projectId, revision]);
    const mutate = async (path, body, method = "POST", done) => {
      if (busy) return;
      setBusy(true); setError("");
      try {
        const value = await request(`${root}/${path}`, body === undefined ? { method } : json(body, method));
        await Promise.all([reloadProjects(), reloadInvites(), reloadConversations()]);
        setRevision((value) => value + 1);
        done?.(value);
      } catch (reason) { setError(friendlyError(reason.message)); }
      finally { setBusy(false); }
    };
    const action = (label, path, body, method = "POST", confirm = false, done) => h(Button, { disabled: busy, onClick: () => {
      if (confirm && !window.confirm(`确认${label}？`)) return;
      void mutate(path, body, method, done);
    } }, label);
    return h(Section, { title: "共享项目" },
      h("p", null, "与同事共享项目资料和对话。成员权限由项目负责人管理。"),
      [error, projects.error, invites.error, conversations.error].filter(Boolean).map((value, index) => h("p", { role: "alert", key: index }, value)),
      h("form", { className: "workagent-form", onSubmit: (event) => { event.preventDefault(); void mutate("shared-projects", { name }, "POST", (value) => { setName(""); setProjectId(value.project.id); }); } },
        h(SharedInput, { "aria-label": "共享项目名称", value: name, onChange: (event) => setName(event.target.value), required: true }),
        h(Button, { type: "submit", disabled: busy }, "创建共享项目")),
      h("form", { className: "workagent-form", onSubmit: (event) => { event.preventDefault(); void mutate("shared-invite-links/accept", { token }, "POST", () => setToken("")); } },
        h(SharedInput, { "aria-label": "邀请令牌", value: token, onChange: (event) => setToken(event.target.value), required: true }),
        h(Button, { type: "submit", disabled: busy }, "接受链接邀请")),
      h("h3", null, "收到的邀请"),
      ...invites.rows.filter((item) => item.status === "pending").map((item) => h("div", { key: item.id }, `${item.inviterName} 邀请你加入 ${item.projectName} · ${new Date(item.expiresAt).toLocaleString()}`,
        action("接受", `shared-invites/${id(item.id)}/accept`, {}), action("拒绝", `shared-invites/${id(item.id)}/decline`, {}))),
      h(Select, { "aria-label": "选择共享项目", value: projectId, onChange: (event) => { setProjectId(event.target.value); setConversationId(""); } },
        h("option", { value: "" }, "选择共享项目"), ...projects.rows.map((item) => h("option", { key: item.id, value: item.id }, `${item.name}${item.hidden ? "（已隐藏）" : ""}`))),
      project ? h("div", { className: "workagent-shared-project" },
        h("h3", null, project.name), h("p", null, project.currentRole === "owner" ? "你是项目负责人" : "你是项目成员"),
        h(SharedFiles, { key: project.id, projectId: project.id }),
        action(project.hidden ? "显示项目" : "隐藏项目", `shared-projects/${id(project.id)}`, { hidden: !project.hidden }, "PATCH"),
        project.currentRole === "owner" ? h(React.Fragment, null,
          h("form", { key: `${project.id}-${project.name}`, className: "workagent-form", onSubmit: (event) => { event.preventDefault(); const value = String(new FormData(event.currentTarget).get("name") || "").trim(); if (value) void mutate(`shared-projects/${id(project.id)}`, { name: value }, "PATCH"); } },
            h(SharedInput, { name: "name", "aria-label": "修改共享项目名称", defaultValue: project.name, required: true, maxLength: 120 }),
            h(Button, { type: "submit", disabled: busy }, "重命名项目")),
          h("form", { className: "workagent-form", onSubmit: (event) => { event.preventDefault(); void mutate(`shared-projects/${id(project.id)}/invites`, { targetUsername: target, expiresInHours: 72 }, "POST", () => setTarget("")); } },
            h(SharedInput, { "aria-label": "邀请同事用户名", value: target, onChange: (event) => setTarget(event.target.value), required: true }), h(Button, { type: "submit", disabled: busy }, "邀请同事")),
          action("生成一次性邀请令牌", `shared-projects/${id(project.id)}/invite-links`, { expiresInHours: 72, singleUse: true }, "POST", false, (value) => setLink(value.link)),
          link ? h("div", null, h("code", null, link.token), h("p", null, "72 小时内有效，接收人登录后在此页输入令牌。"), action("撤销此邀请令牌", `shared-projects/${id(project.id)}/invite-links/${id(link.token)}`, undefined, "DELETE", true, () => setLink(null))) : null
        ) : action("退出项目", `shared-projects/${id(project.id)}/members/me`, undefined, "DELETE", true, () => setProjectId("")),
        h("h4", null, "项目成员"), ...members.map((member) => h("div", { key: member.userId }, `${member.displayName || member.username || `成员 ${member.userId}`} · ${member.role === "owner" ? "负责人" : "成员"}`,
          project.currentRole === "owner" && member.role !== "owner" ? h(React.Fragment, null,
            action("移除成员", `shared-projects/${id(project.id)}/members/${member.userId}`, undefined, "DELETE", true),
            action("转移所有权", `shared-projects/${id(project.id)}/ownership`, { targetUserId: member.userId }, "POST", true)) : null)),
        h("h4", null, "共享对话"),
        h("form", { className: "workagent-form", onSubmit: (event) => {
          event.preventDefault();
          const preset = presets.rows.find((item) => item.id === presetId);
          if (!preset || !modelId) return;
          void mutate("shared-conversations", { project_id: project.id, name: chatName, assistant_id: preset.id, assistant_backend: preset.engine, model_id: modelId, thinking_effort: "low" }, "POST", (value) => { setConversationId(value.conversation.id); setChatName(""); });
        } }, h(SharedInput, { "aria-label": "共享对话名称", value: chatName, onChange: (event) => setChatName(event.target.value), required: true }),
          h(Select, { "aria-label": "共享助手", value: presetId, onChange: (event) => { setPresetId(event.target.value); setModelId(""); }, required: true }, h("option", { value: "" }, "选择助手"), ...presets.rows.filter((item) => item.enabled && ["codex", "kimi"].includes(item.engine)).map((item) => h("option", { key: item.id, value: item.id }, item.name))),
          h(Select, { "aria-label": "共享模型", value: modelId, onChange: (event) => setModelId(event.target.value), required: true }, h("option", { value: "" }, "选择模型"), ...models.rows.filter((group) => group.engine === presets.rows.find((item) => item.id === presetId)?.engine).flatMap((group) => group.models.map((item) => h("option", { key: item.id, value: item.id }, item.name)))),
          h(Button, { type: "submit", disabled: busy }, "创建共享对话")),
        ...conversations.rows.filter((item) => item.project_id === project.id).map((item) => h("div", { key: item.id }, h(Button, { onClick: () => setConversationId(item.id) }, `${item.name}${item.pinned ? " · 已置顶" : ""}${item.hidden ? " · 已隐藏" : ""}`),
          action(item.pinned ? "取消置顶" : "置顶", "shared-conversations", { conversation_id: item.id, pinned: !item.pinned }, "PATCH"),
          action(item.hidden ? "显示对话" : "隐藏对话", "shared-conversations", { conversation_id: item.id, hidden: !item.hidden }, "PATCH"))),
        conversation ? h(SharedChat, { key: conversation.id, conversation }) : null) : null);
  }
  return SharedPage;
}
