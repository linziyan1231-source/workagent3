export function createImports({
  React,
  request,
  apiRoot,
  Field,
  Input,
  Button,
  friendlyError,
  useResource,
}) {
  const h = React.createElement;
  function Results({ rows }) {
    return h(
      "ul",
      null,
      ...rows.map((row, i) =>
        h(
          "li",
          { key: i },
          `${row.name || "未命名"}：${row.error ? friendlyError(row.error) : "已导入"}`,
        ),
      ),
    );
  }
  function SkillImport({ onImported }) {
    const [format, setFormat] = React.useState("directory");
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [result, setResult] = React.useState([]);
    async function submit(e) {
      e.preventDefault();
      const form = e.currentTarget;
      const data = new FormData(form);
      const files = [...form.elements.files.files];
      if (!files.length) return;
      if (
        files.reduce((total, file) => total + file.size, 0) >
        48 * 1024 * 1024
      )
        return setError("技能包不能超过 48 MB");
      data.set("format", format);
      data.set(
        "paths",
        JSON.stringify(
          files.map((file) => file.webkitRelativePath || file.name),
        ),
      );
      setBusy(true);
      setError("");
      try {
        const response = await fetch(`${apiRoot}/imports/skill`, {
          method: "POST",
          credentials: "same-origin",
          body: data,
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error);
        setResult([value]);
        onImported();
        if (!value.error) form.reset();
      } catch (reason) {
        setError(friendlyError(reason.message));
      } finally {
        setBusy(false);
      }
    }
    return h(
      "details",
      null,
      h("summary", null, "导入本地技能"),
      h(
        "form",
        { className: "workagent-form", onSubmit: submit },
        h(
          Field,
          { label: "导入技能名称" },
          h(Input, { name: "name", required: true, maxLength: 120 }),
        ),
        h(
          Field,
          { label: "技能描述" },
          h(Input, { name: "description", maxLength: 4000 }),
        ),
        h(
          Field,
          { label: "技能来源" },
          h(
            "select",
            { value: format, onChange: (e) => setFormat(e.target.value) },
            h("option", { value: "directory" }, "本地目录"),
            h("option", { value: "zip" }, "ZIP 包"),
          ),
        ),
        h(
          Field,
          { label: "选择技能文件" },
          h("input", {
            key: format,
            name: "files",
            type: "file",
            required: true,
            ...(format === "directory"
              ? { webkitdirectory: "", multiple: true }
              : { accept: ".zip" }),
          }),
        ),
        h(
          "p",
          null,
          "目录或 ZIP 包须包含 SKILL.md 和依赖文件，最多 48 MB。导入后可为助手启用。",
        ),
        h(
          Button,
          { type: "submit", disabled: busy },
          busy ? "导入中…" : "导入技能",
        ),
        error ? h("p", { role: "alert" }, error) : null,
        h(Results, { rows: result }),
      ),
    );
  }
  function MCPImport({ onImported }) {
    const [text, setText] = React.useState("");
    const [busy, setBusy] = React.useState(false);
    const [rows, setRows] = React.useState([]);
    const [error, setError] = React.useState("");
    async function submit(e) {
      e.preventDefault();
      setBusy(true);
      setError("");
      try {
        const parsed = JSON.parse(text);
        const rows = await request(`${apiRoot}/imports/mcp`, {
          method: "POST",
          body: JSON.stringify(parsed),
        });
        setRows(rows);
        setText("");
        onImported();
      } catch (reason) {
        setError(friendlyError(reason.message));
      } finally {
        setBusy(false);
      }
    }
    return h(
      "details",
      null,
      h("summary", null, "批量导入 MCP JSON"),
      h(
        "form",
        { className: "workagent-form", onSubmit: submit },
        h(
          Field,
          { label: "MCP JSON 配置" },
          h("textarea", {
            value: text,
            onChange: (e) => setText(e.target.value),
            required: true,
            rows: 8,
            autoComplete: "off",
            spellCheck: false,
            placeholder:
              '{"mcpServers":{"example":{"command":"...","args":[]}}}',
          }),
        ),
        h(
          "p",
          null,
          "支持 command/args/env 和 url/headers。密钥保存到当前员工的凭据库，导入记录不保留原始配置。",
        ),
        h(
          Button,
          { type: "submit", disabled: busy },
          busy ? "导入中…" : "导入 MCP",
        ),
        error ? h("p", { role: "alert" }, error) : null,
        h(Results, { rows }),
      ),
    );
  }
  function History() {
    const [state, refresh] = useResource(`${apiRoot}/imports`);
    return h(
      "section",
      null,
      h("h3", null, "能力导入记录"),
      h(Button, { onClick: refresh }, "刷新导入记录"),
      state.error
        ? h("p", { role: "alert" }, friendlyError(state.error))
        : null,
      ...state.rows
        .slice()
        .reverse()
        .map((row, i) =>
          h(
            "p",
            { key: i },
            `${new Date(row.at).toLocaleString()} · ${row.kind} · ${row.name} · ${row.error ? friendlyError(row.error) : "已导入"}`,
          ),
        ),
    );
  }
  return { SkillImport, MCPImport, History };
}
