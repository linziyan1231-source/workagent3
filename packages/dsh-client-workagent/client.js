window.__ModuleLoader__.load({
  id: "@workagent/dsh-client",
  factory: (require) => {
    const module = { exports: {} };
    const React = require("react");
    const h = React.createElement;
    const pluginScript = document.currentScript?.src;
    const apiRoot = "/api/runtime/v1";

    async function request(path, init) {
      const response = await fetch(path, {
        credentials: "same-origin",
        ...init,
        headers:
          init?.body === undefined
            ? init?.headers
            : { "Content-Type": "application/json", ...init.headers },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      if (response.status === 204) return undefined;
      const type = response.headers.get("content-type") || "";
      return type.includes("json") ? response.json() : response.text();
    }

    function installAssets() {
      if (!document.getElementById("workagent-dsw-tokens")) {
        const link = document.createElement("link");
        link.id = "workagent-dsw-tokens";
        link.rel = "stylesheet";
        link.href = pluginScript
          ? pluginScript.replace(/client\.js(?:\?.*)?$/, "tokens.css")
          : "/plugins/@workagent/dsh-client/tokens.css";
        document.head.append(link);
      }
      document.title = "WorkAgent";
    }

    function useResource(endpoint, select = (value) => value) {
      const [state, setState] = React.useState({
        loading: true,
        rows: [],
        error: "",
      });
      const load = React.useCallback(
        async (signal) => {
          setState((value) => ({ ...value, loading: true, error: "" }));
          try {
            const value = await request(endpoint, { signal });
            if (signal?.aborted) return;
            const selected = select(value);
            setState({
              loading: false,
              rows: Array.isArray(selected)
                ? selected
                : selected == null
                  ? []
                  : [selected],
              error: "",
            });
          } catch (error) {
            if (error.name !== "AbortError")
              setState({ loading: false, rows: [], error: error.message });
          }
        },
        [endpoint],
      );
      React.useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
      }, [load]);
      return [state, () => load()];
    }

    function Field({ label, children }) {
      return h("label", null, label, children);
    }
    function Input(props) {
      return h("input", { ...props });
    }
    function Select({ options, ...props }) {
      return h(
        "select",
        props,
        ...options.map(([value, label]) =>
          h("option", { value, key: value }, label),
        ),
      );
    }
    function Button({ children, ...props }) {
      return h(
        "button",
        { type: "button", className: "workagent-button", ...props },
        children,
      );
    }
    function Status({ state }) {
      if (state.loading)
        return h("p", { className: "workagent-muted" }, "Loading…");
      if (state.error)
        return h(
          "p",
          { role: "alert", className: "workagent-error" },
          state.error,
        );
      if (state.rows.length === 0)
        return h("p", { className: "workagent-muted" }, "No entries");
      return null;
    }
    function Card({ title, detail, children, ...props }) {
      return h(
        "article",
        {
          ...props,
          className: ["workagent-card", props.className]
            .filter(Boolean)
            .join(" "),
        },
        h("strong", null, title),
        detail ? h("div", { className: "workagent-muted" }, detail) : null,
        children
          ? h("div", { className: "workagent-actions" }, children)
          : null,
      );
    }
    function Section({ title, children }) {
      return h(
        "section",
        { className: "workagent-section", "data-workagent-section": title },
        h("h2", null, title),
        children,
      );
    }
    async function mutate(refresh, setError, path, method, value) {
      try {
        await request(path, {
          method,
          body: value === undefined ? undefined : JSON.stringify(value),
        });
        await refresh();
      } catch (error) {
        setError(error.message);
      }
    }

    function BrandMark({ size = 28 }) {
      return h(
        "span",
        {
          style: {
            width: size,
            height: size,
            display: "grid",
            placeItems: "center",
            borderRadius: "var(--dsw-radius)",
            background: "var(--dsw-color-accent)",
            color: "var(--dsw-color-panel)",
            fontWeight: 700,
          },
        },
        "W",
      );
    }
    function BrandName() {
      return h("strong", null, "WorkAgent");
    }

    function MCPSection() {
      const endpoint = `${apiRoot}/mcp-servers`;
      const [state, refresh] = useResource(endpoint);
      const [error, setError] = React.useState("");
      const [transport, setTransport] = React.useState("http");
      const submit = async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const values = new FormData(form);
        const target = String(values.get("target") || "").trim();
        const body = {
          name: String(values.get("name") || "").trim(),
          source: "user",
          enabled: true,
          transport:
            transport === "stdio"
              ? {
                  kind: "stdio",
                  command: target,
                  args: [],
                  environmentCredentialIds: {},
                }
              : { kind: transport, url: target, headerCredentialIds: {} },
          toolPolicy: "all",
          allowedTools: [],
          oauthState: "none",
        };
        await mutate(refresh, setError, endpoint, "POST", body);
        form.reset();
      };
      const oauth = async (row) => {
        try {
          const value = await request(
            `${endpoint}/${encodeURIComponent(row.id)}/oauth/start`,
            {
              method: "POST",
              body: JSON.stringify({
                redirectUri: `${location.origin}/oauth/mcp/callback`,
              }),
            },
          );
          sessionStorage.setItem(
            "workagent.mcp.oauth",
            JSON.stringify({ id: row.id, ...value }),
          );
          location.assign(value.authorizationUrl);
        } catch (reason) {
          setError(reason.message);
        }
      };
      return h(
        Section,
        { title: "MCP servers" },
        h(
          "form",
          { className: "workagent-form", onSubmit: submit },
          h(
            Field,
            { label: "Name" },
            h(Input, { name: "name", required: true }),
          ),
          h(
            Field,
            { label: "Transport" },
            h(Select, {
              value: transport,
              onChange: (e) => setTransport(e.target.value),
              options: [
                ["http", "HTTP"],
                ["sse", "SSE"],
                ["stdio", "Command"],
              ],
            }),
          ),
          h(
            Field,
            { label: transport === "stdio" ? "Command" : "Endpoint" },
            h(Input, {
              name: "target",
              required: true,
              type: transport === "stdio" ? "text" : "url",
            }),
          ),
          h(
            "button",
            { className: "workagent-button", type: "submit" },
            "Add server",
          ),
        ),
        error
          ? h("p", { role: "alert", className: "workagent-error" }, error)
          : null,
        h(Status, { state }),
        ...state.rows.map((row) =>
          h(
            Card,
            {
              key: row.id,
              title: row.name,
              detail: `${row.health || "unknown"} · ${row.oauthState || "none"}`,
            },
            row.source === "user"
              ? h(
                  Button,
                  {
                    onClick: () =>
                      mutate(
                        refresh,
                        setError,
                        `${endpoint}/${encodeURIComponent(row.id)}`,
                        "PATCH",
                        { enabled: !row.enabled },
                      ),
                  },
                  row.enabled ? "Disable" : "Enable",
                )
              : null,
            row.oauthState === "needs_auth"
              ? h(Button, { onClick: () => oauth(row) }, "Authorize")
              : null,
            row.source === "user"
              ? h(
                  Button,
                  {
                    onClick: () =>
                      mutate(
                        refresh,
                        setError,
                        `${endpoint}/${encodeURIComponent(row.id)}`,
                        "DELETE",
                      ),
                  },
                  "Delete",
                )
              : null,
          ),
        ),
      );
    }

    function SkillsSection() {
      const endpoint = `${apiRoot}/skills`;
      const [state, refresh] = useResource(endpoint);
      const [market, reloadMarket] = useResource(
        "/api/portal/skill-market",
        (value) => value.skills || [],
      );
      const [selected, setSelected] = React.useState("");
      const [error, setError] = React.useState("");
      const install = async () => {
        if (!selected) return;
        await mutate(
          async () => {
            await refresh();
            await reloadMarket();
          },
          setError,
          "/api/portal/skill-market/install",
          "POST",
          { id: selected },
        );
      };
      return h(
        Section,
        { title: "Skills" },
        h(
          "div",
          { className: "workagent-form" },
          h(
            Field,
            { label: "Managed skill" },
            h(Select, {
              value: selected,
              onChange: (e) => setSelected(e.target.value),
              options: [
                ["", "Choose a reviewed skill"],
                ...market.rows.map((item) => [
                  item.id,
                  `${item.name} ${item.version || ""}`,
                ]),
              ],
            }),
          ),
          h(Button, { onClick: install, disabled: !selected }, "Install"),
        ),
        h(
          "p",
          { className: "workagent-muted" },
          `Import history: ${state.rows.filter((row) => row.source === "market" || row.source === "user").length} installed`,
        ),
        error
          ? h("p", { role: "alert", className: "workagent-error" }, error)
          : null,
        h(Status, { state }),
        ...state.rows.map((row) =>
          h(
            Card,
            {
              key: row.id,
              title: row.name,
              detail: `${row.source} · ${row.health || (row.enabled ? "ready" : "disabled")}`,
            },
            row.source === "user" || row.source === "market"
              ? h(
                  Button,
                  {
                    onClick: () =>
                      mutate(
                        refresh,
                        setError,
                        `${endpoint}/${encodeURIComponent(row.id)}`,
                        "PATCH",
                        { enabled: !row.enabled },
                      ),
                  },
                  row.enabled ? "Disable" : "Enable",
                )
              : null,
          ),
        ),
      );
    }

    const defaultPreset = {
      enabled: true,
      description: "",
      avatar: null,
      modelId: null,
      systemPrompt: "",
      workspacePolicy: "optional",
      skillIds: [],
      mcpServerIds: [],
      toolAllowlist: [],
      approvalPolicy: "on_risk",
    };
    function PresetsSection() {
      const endpoint = `${apiRoot}/presets`;
      const [state, refresh] = useResource(endpoint);
      const [editing, setEditing] = React.useState(null);
      const [error, setError] = React.useState("");
      const submit = async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const values = new FormData(form);
        const csv = (name) =>
          String(values.get(name) || "")
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
        const body = {
          ...defaultPreset,
          name: String(values.get("name")),
          engine: String(values.get("engine")),
          modelId: String(values.get("modelId") || "") || null,
          systemPrompt: String(values.get("systemPrompt") || ""),
          skillIds: csv("skillIds"),
          mcpServerIds: csv("mcpServerIds"),
        };
        await mutate(
          refresh,
          setError,
          editing ? `${endpoint}/${encodeURIComponent(editing.id)}` : endpoint,
          editing ? "PATCH" : "POST",
          body,
        );
        setEditing(null);
        form.reset();
      };
      return h(
        Section,
        { title: "Presets" },
        h(
          "form",
          {
            className: "workagent-form",
            onSubmit: submit,
            key: `preset-form-${editing?.id || "new"}`,
          },
          h(
            Field,
            { label: "Name" },
            h(Input, {
              name: "name",
              required: true,
              defaultValue: editing?.name || "",
            }),
          ),
          h(
            Field,
            { label: "Engine" },
            h(Select, {
              name: "engine",
              defaultValue: editing?.engine || "harness",
              options: [
                ["harness", "Harness"],
                ["codex", "Codex"],
                ["kimi", "Kimi"],
              ],
            }),
          ),
          h(
            Field,
            { label: "Model" },
            h(Input, { name: "modelId", defaultValue: editing?.modelId || "" }),
          ),
          h(
            Field,
            { label: "Skill IDs (comma separated)" },
            h(Input, {
              name: "skillIds",
              defaultValue: editing?.skillIds?.join(", ") || "",
            }),
          ),
          h(
            Field,
            { label: "MCP IDs (comma separated)" },
            h(Input, {
              name: "mcpServerIds",
              defaultValue: editing?.mcpServerIds?.join(", ") || "",
            }),
          ),
          h(
            Field,
            { label: "System prompt" },
            h("textarea", {
              name: "systemPrompt",
              defaultValue: editing?.systemPrompt || "",
            }),
          ),
          h(
            "button",
            { className: "workagent-button", type: "submit" },
            editing ? "Save preset" : "Create preset",
          ),
          editing
            ? h(Button, { onClick: () => setEditing(null) }, "Cancel edit")
            : null,
        ),
        error
          ? h("p", { role: "alert", className: "workagent-error" }, error)
          : null,
        h(Status, { state }),
        ...state.rows.map((row) =>
          h(
            Card,
            {
              key: row.id,
              title: row.name,
              detail: `${row.engine} · ${row.modelId || "default model"}`,
            },
            row.source === "user"
              ? h(Button, { onClick: () => setEditing(row) }, "Edit")
              : null,
            row.source === "user"
              ? h(
                  Button,
                  {
                    onClick: () =>
                      mutate(
                        refresh,
                        setError,
                        `${endpoint}/${encodeURIComponent(row.id)}`,
                        "DELETE",
                      ),
                  },
                  "Delete",
                )
              : null,
          ),
        ),
      );
    }

    function ModelsSection() {
      const [state] = useResource(`${apiRoot}/models`);
      return h(
        Section,
        { title: "Models" },
        h(
          "p",
          { className: "workagent-muted" },
          "Model credentials are managed centrally; this view never accepts keys.",
        ),
        h(Status, { state }),
        ...state.rows.map((row) =>
          h(Card, {
            key: row.id,
            title: row.displayName || row.id,
            detail: row.authorization?.authorized
              ? `ready · ${row.health}`
              : `needs_setup · ${row.authorization?.reason || "not authorized"}`,
          }),
        ),
      );
    }

    function EnginesSection() {
      const [status] = useResource("/api/system/capabilities", (value) => {
        const capabilities = value.engines || {};
        return ["harness", "codex", "kimi"].map((id) => ({
          id,
          capabilities: capabilities[id],
          available: Boolean(capabilities[id]),
        }));
      });
      return h(
        Section,
        { title: "Engines" },
        h(Status, { state: status }),
        h(
          "div",
          { className: "workagent-grid" },
          ...status.rows.map((row) =>
            h(
              Card,
              {
                key: row.id,
                title: row.id,
                detail: row.available
                  ? "ready"
                  : "unavailable · credential_needs_auth or engine not configured",
              },
              row.capabilities
                ? h(
                    "span",
                    null,
                    Object.entries(row.capabilities)
                      .filter(([, enabled]) => enabled)
                      .map(([name]) => name)
                      .join(" · "),
                  )
                : null,
            ),
          ),
        ),
      );
    }

    const extensionTabs = [
      ["Message channels", "/api/channels/connectors", (value) => value],
      ["Usage quota", "/api/quota/gateway-usage", (value) => [value]],
      [
        "Runtime components",
        "/api/system/status",
        (value) => value.components || [],
      ],
      [
        "Data migration",
        `${apiRoot}/migrations/skills-mcp`,
        (value) => value.items || value,
      ],
    ];
    function ExtensionsSection() {
      const [tab, setTab] = React.useState(0);
      const [label, endpoint, select] = extensionTabs[tab];
      const [state] = useResource(endpoint, select);
      return h(
        Section,
        { title: "Extensions" },
        h(
          "nav",
          { className: "workagent-tabs", "aria-label": "Extension categories" },
          ...extensionTabs.map(([name], index) =>
            h(
              Button,
              {
                key: name,
                "aria-pressed": tab === index,
                onClick: () => setTab(index),
              },
              name,
            ),
          ),
        ),
        h("h3", null, `Current: ${label}`),
        h(Status, { state }),
        ...state.rows.map((row, index) =>
          h(Card, {
            key: row.id || row.model || index,
            title: row.display_name || row.name || row.id || row.model || label,
            detail:
              row.status ||
              (row.state?.running && "healthy") ||
              row.disposition ||
              (row.dailyTokens !== undefined
                ? `Daily ${row.dailyTokens} · Weekly ${row.weeklyTokens}`
                : "ready"),
          }),
        ),
      );
    }

    function NotificationsPage() {
      const endpoint = "/api/portal/me/notifications";
      const [state, refresh] = useResource(
        endpoint,
        (value) => value.notifications || [],
      );
      const [error, setError] = React.useState("");
      const unread = state.rows.filter((row) => !row.read_at).length;
      const open = async (row) => {
        try {
          if (!row.read_at)
            await request(`${endpoint}/${encodeURIComponent(row.id)}/read`, {
              method: "POST",
            });
          await request(
            `${endpoint}/${encodeURIComponent(row.id)}/acknowledge`,
            { method: "POST" },
          );
          await refresh();
          if (row.deep_link) location.assign(row.deep_link);
        } catch (reason) {
          setError(reason.message);
        }
      };
      return h(
        Section,
        { title: "Notifications" },
        h(
          "p",
          null,
          "Unread ",
          h("span", { className: "workagent-badge" }, unread),
        ),
        error
          ? h("p", { role: "alert", className: "workagent-error" }, error)
          : null,
        h(Status, { state }),
        ...state.rows.map((row) =>
          h(
            Card,
            { key: row.id, title: row.title || row.kind, detail: row.message },
            h(
              Button,
              { onClick: () => open(row) },
              row.deep_link ? "Open and acknowledge" : "Acknowledge",
            ),
          ),
        ),
      );
    }

    function AutomationsPage() {
      const endpoint = `${apiRoot}/automations`;
      const [state, refresh] = useResource(endpoint);
      const [runs, setRuns] = React.useState({});
      const [error, setError] = React.useState("");
      const submit = async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const values = new FormData(form);
        const body = {
          name: String(values.get("name")),
          enabled: true,
          schedule: {
            kind: "interval",
            everyMinutes: Number(values.get("minutes")),
          },
          presetId: String(values.get("presetId")),
          engine: String(values.get("engine")),
          workspaceId: String(values.get("workspaceId")),
          input: String(values.get("input")),
          notificationPolicy: "always",
          executionMode: "new_conversation",
          conversationId: null,
        };
        await mutate(refresh, setError, endpoint, "POST", body);
        form.reset();
      };
      const history = async (id) => {
        try {
          const historyRows = await request(
            `${endpoint}/${encodeURIComponent(id)}/runs`,
          );
          setRuns((value) => ({ ...value, [id]: historyRows }));
        } catch (reason) {
          setError(reason.message);
        }
      };
      return h(
        Section,
        { title: "Scheduled tasks" },
        h(
          "form",
          { className: "workagent-form", onSubmit: submit },
          ...[
            ["name", "Name"],
            ["presetId", "Preset ID"],
            ["workspaceId", "Workspace ID"],
            ["input", "Input"],
          ].map(([name, label]) =>
            h(Field, { label, key: name }, h(Input, { name, required: true })),
          ),
          h(
            Field,
            { label: "Engine" },
            h(Select, {
              name: "engine",
              options: [
                ["harness", "Harness"],
                ["codex", "Codex"],
                ["kimi", "Kimi"],
              ],
            }),
          ),
          h(
            Field,
            { label: "Every minutes" },
            h(Input, {
              name: "minutes",
              type: "number",
              min: 1,
              defaultValue: 60,
              required: true,
            }),
          ),
          h(
            "button",
            { type: "submit", className: "workagent-button" },
            "Create task",
          ),
        ),
        error
          ? h("p", { role: "alert", className: "workagent-error" }, error)
          : null,
        h(Status, { state }),
        ...state.rows.map((row) =>
          h(
            Card,
            {
              key: row.id,
              title: row.name,
              detail: row.nextRunAt || "No next run",
            },
            h(
              Button,
              {
                onClick: () =>
                  mutate(
                    refresh,
                    setError,
                    `${endpoint}/${encodeURIComponent(row.id)}/run`,
                    "POST",
                  ),
              },
              "Run now",
            ),
            h(Button, { onClick: () => history(row.id) }, "Run history"),
            ...(runs[row.id] || []).map((run) =>
              h(
                Button,
                {
                  key: run.id,
                  disabled: !["pending", "running"].includes(run.status),
                  onClick: () =>
                    mutate(
                      () => history(row.id),
                      setError,
                      `${endpoint}/${encodeURIComponent(row.id)}/runs/${encodeURIComponent(run.id)}/cancel`,
                      "POST",
                    ),
                },
                `${run.status}: cancel`,
              ),
            ),
            h(
              Button,
              {
                onClick: () =>
                  mutate(
                    refresh,
                    setError,
                    `${endpoint}/${encodeURIComponent(row.id)}`,
                    "DELETE",
                  ),
              },
              "Delete",
            ),
          ),
        ),
      );
    }

    function TeamsPage() {
      const endpoint = `${apiRoot}/teams`;
      const [state, refresh] = useResource(endpoint);
      const [details, setDetails] = React.useState({});
      const [selectedTeam, setSelectedTeam] = React.useState(null);
      const [teamAction, setTeamAction] = React.useState(null);
      const [teamActionValue, setTeamActionValue] = React.useState("");
      const [memberEngine, setMemberEngine] = React.useState("codex");
      const [memberPresetId, setMemberPresetId] = React.useState("");
      const [error, setError] = React.useState("");
      React.useEffect(() => {
        if (!selectedTeam || typeof EventSource === "undefined") return;
        const source = new EventSource(
          `${endpoint}/${encodeURIComponent(selectedTeam.id)}/events`,
          { withCredentials: true },
        );
        const receive = (event) => {
          try {
            const next = JSON.parse(event.data);
            setDetails((value) => {
              const current = value[selectedTeam.id];
              if (
                !current ||
                current.events.some((item) => item.id === next.id)
              )
                return value;
              return {
                ...value,
                [selectedTeam.id]: {
                  ...current,
                  events: [...current.events, next],
                },
              };
            });
          } catch {
            // The next valid event or a manual refresh repairs the view.
          }
        };
        for (const type of [
          "team.updated",
          "member.added",
          "task.queued",
          "task.started",
          "task.completed",
          "task.failed",
          "task.cancelled",
          "mail.received",
        ])
          source.addEventListener(type, receive);
        return () => source.close();
      }, [selectedTeam]);
      const submit = async (event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        await mutate(refresh, setError, endpoint, "POST", {
          name: String(values.get("name")),
          workspaceId: String(values.get("workspaceId")),
          lead: {
            name: String(values.get("lead")),
            engine: String(values.get("engine")),
            presetId: String(values.get("presetId")),
          },
        });
      };
      const loadDetails = async (team) => {
        setSelectedTeam(team);
        try {
          const [tasks, messages, events] = await Promise.all(
            ["tasks", "messages", "events"].map((name) =>
              request(`${endpoint}/${encodeURIComponent(team.id)}/${name}`),
            ),
          );
          setDetails((value) => ({
            ...value,
            [team.id]: { tasks, messages, events },
          }));
        } catch (reason) {
          setError(reason.message);
        }
      };
      const beginTeamAction = (kind, team) => {
        setTeamAction({ kind, team });
        setTeamActionValue("");
        setMemberEngine("codex");
        setMemberPresetId(team.members[0].presetId);
      };
      const submitTeamAction = async (event) => {
        event.preventDefault();
        const value = teamActionValue.trim();
        if (!value || !teamAction) return;
        const { kind, team } = teamAction;
        const action = {
          member: {
            suffix: "members",
            refresh,
            body: {
              name: value,
              engine: memberEngine,
              presetId: memberPresetId,
            },
          },
          task: {
            suffix: "tasks",
            refresh: () => loadDetails(team),
            body: {
              memberId: team.members[0].id,
              title: value,
              input: value,
            },
          },
          mail: {
            suffix: "messages",
            refresh: () => loadDetails(team),
            body: { fromMemberId: null, toMemberId: null, body: value },
          },
        }[kind];
        await mutate(
          action.refresh,
          setError,
          `${endpoint}/${encodeURIComponent(team.id)}/${action.suffix}`,
          "POST",
          action.body,
        );
        setTeamAction(null);
      };
      const cancelTask = (team, taskEntry) =>
        mutate(
          () => loadDetails(team),
          setError,
          `${endpoint}/${encodeURIComponent(team.id)}/tasks/${encodeURIComponent(taskEntry.id)}/cancel`,
          "POST",
        );
      return h(
        Section,
        { title: "Teams" },
        h(
          "form",
          { className: "workagent-form", onSubmit: submit },
          ...[
            ["name", "Team name"],
            ["workspaceId", "Workspace ID"],
            ["lead", "Lead name"],
            ["presetId", "Preset ID"],
          ].map(([name, label]) =>
            h(Field, { label, key: name }, h(Input, { name, required: true })),
          ),
          h(
            Field,
            { label: "Lead engine" },
            h(Select, {
              name: "engine",
              options: [
                ["harness", "Harness"],
                ["codex", "Codex"],
                ["kimi", "Kimi"],
              ],
            }),
          ),
          h(
            "button",
            { type: "submit", className: "workagent-button" },
            "Create team",
          ),
        ),
        error
          ? h("p", { role: "alert", className: "workagent-error" }, error)
          : null,
        h(Status, { state }),
        ...state.rows.map((team, teamIndex) =>
          h(
            Card,
            {
              key: `${team.id}-${teamIndex}`,
              title: team.name,
              detail: `${team.members.length} members · ${team.sessionMode || "independent sessions"}`,
            },
            h(
              Button,
              { onClick: () => beginTeamAction("member", team) },
              "Add member",
            ),
            h(
              Button,
              { onClick: () => beginTeamAction("task", team) },
              "Dispatch task",
            ),
            h(
              Button,
              { onClick: () => loadDetails(team) },
              "Mailbox and events",
            ),
            h(
              Button,
              { onClick: () => beginTeamAction("mail", team) },
              "Send team mail",
            ),
            details[team.id]
              ? h(
                  "div",
                  { className: "workagent-stack" },
                  h(
                    "span",
                    null,
                    `${details[team.id].tasks.length} tasks · ${details[team.id].messages.length} messages · ${details[team.id].events.length} events`,
                  ),
                  ...details[team.id].tasks.map((taskEntry) =>
                    h(
                      Button,
                      {
                        key: `task-${taskEntry.id}`,
                        disabled: !["queued", "running"].includes(
                          taskEntry.status,
                        ),
                        onClick: () => cancelTask(team, taskEntry),
                      },
                      `${taskEntry.title}: ${taskEntry.status}`,
                    ),
                  ),
                  ...details[team.id].messages.map((message) =>
                    h("span", { key: `mail-${message.id}` }, message.body),
                  ),
                  ...details[team.id].events.map((event) =>
                    h(
                      "span",
                      {
                        key: `event-${event.id}`,
                        className: "workagent-muted",
                      },
                      event.type,
                    ),
                  ),
                )
              : null,
          ),
        ),
        teamAction
          ? h(
              "form",
              { className: "workagent-form", onSubmit: submitTeamAction },
              h(
                Field,
                {
                  label: {
                    member: "Member name",
                    task: "Task title",
                    mail: "Message to the team",
                  }[teamAction.kind],
                },
                h(Input, {
                  "aria-label": "Team action value",
                  value: teamActionValue,
                  onChange: (event) => setTeamActionValue(event.target.value),
                  required: true,
                }),
              ),
              h(Button, { type: "submit" }, "Confirm"),
              h(Button, { onClick: () => setTeamAction(null) }, "Cancel"),
              teamAction.kind === "member"
                ? h(
                    React.Fragment,
                    null,
                    h(
                      Field,
                      { label: "Member engine" },
                      h(Select, {
                        "aria-label": "Member engine",
                        value: memberEngine,
                        onChange: (event) =>
                          setMemberEngine(event.target.value),
                        options: [
                          ["harness", "Harness"],
                          ["codex", "Codex"],
                          ["kimi", "Kimi"],
                        ],
                      }),
                    ),
                    h(
                      Field,
                      { label: "Member preset ID" },
                      h(Input, {
                        "aria-label": "Member preset ID",
                        value: memberPresetId,
                        onChange: (event) =>
                          setMemberPresetId(event.target.value),
                        required: true,
                      }),
                    ),
                  )
                : null,
            )
          : null,
      );
    }

    function WorkspacesPage() {
      const endpoint = `${apiRoot}/workspaces`;
      const [state] = useResource(endpoint);
      const [selected, setSelected] = React.useState(null);
      const [files, setFiles] = React.useState([]);
      const [preview, setPreview] = React.useState(null);
      const [error, setError] = React.useState("");
      const openWorkspace = async (workspace) => {
        setSelected(workspace);
        try {
          setFiles(
            await request(
              `${endpoint}/${encodeURIComponent(workspace.id)}/files`,
            ),
          );
        } catch (reason) {
          setError(reason.message);
        }
      };
      const openFile = async (entry) => {
        const path = `${endpoint}/${encodeURIComponent(selected.id)}/content?path=${encodeURIComponent(entry.path)}&preview=1`;
        const extension = entry.name.toLowerCase().split(".").pop();
        if (["png", "jpg", "jpeg", "gif", "webp", "pdf"].includes(extension))
          setPreview({
            path,
            media: extension === "pdf" ? "pdf" : "image",
            name: entry.name,
          });
        else {
          try {
            setPreview({
              text: await request(path),
              media: "text",
              name: entry.name,
            });
          } catch (reason) {
            setError(reason.message);
          }
        }
      };
      return h(
        Section,
        { title: "Workspace files" },
        error
          ? h("p", { role: "alert", className: "workagent-error" }, error)
          : null,
        h(Status, { state }),
        h(
          "div",
          { className: "workagent-grid" },
          ...state.rows.map((workspace) =>
            h(
              Card,
              { key: workspace.id, title: workspace.name },
              h(Button, { onClick: () => openWorkspace(workspace) }, "Browse"),
            ),
          ),
        ),
        selected
          ? h(
              "div",
              { className: "workagent-stack" },
              h("h3", null, selected.name),
              ...files.map((entry) =>
                h(
                  Card,
                  { key: entry.path, title: entry.name, detail: entry.kind },
                  entry.kind === "file"
                    ? h(Button, { onClick: () => openFile(entry) }, "Preview")
                    : null,
                ),
              ),
            )
          : null,
        preview?.media === "image"
          ? h("img", {
              className: "workagent-preview",
              src: preview.path,
              alt: preview.name,
            })
          : preview?.media === "pdf"
            ? h("iframe", {
                className: "workagent-preview",
                src: preview.path,
                title: preview.name,
                sandbox: "allow-same-origin",
              })
            : preview?.media === "text"
              ? h("pre", { className: "workagent-card" }, preview.text)
              : null,
      );
    }

    function ConversationUtilities({ sessionId, session }) {
      const id = sessionId || session?.id;
      const [query, setQuery] = React.useState("");
      const [results, setResults] = React.useState([]);
      const [error, setError] = React.useState("");
      const [editing, setEditing] = React.useState(null);
      const [replacement, setReplacement] = React.useState("");
      const locateMessage = React.useCallback((messageId, content) => {
        const escaped = globalThis.CSS?.escape
          ? globalThis.CSS.escape(messageId)
          : messageId.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
        let target = document.querySelector(
          `[data-message-id="${escaped}"], #message-${escaped}`,
        );
        if (!target && content) {
          const candidates = document.querySelectorAll(
            "[data-turn], [data-turn-tail], article, [role='article']",
          );
          target = [...candidates].find((node) =>
            node.textContent?.includes(content),
          );
        }
        if (!target) return false;
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("workagent-message-highlight");
        globalThis.setTimeout(
          () => target.classList.remove("workagent-message-highlight"),
          3000,
        );
        return true;
      }, []);
      React.useEffect(() => {
        const messageId = new URLSearchParams(location.search).get("message");
        if (!messageId) return;
        const content = sessionStorage.getItem(
          `workagent.message.${messageId}`,
        );
        let attempts = 0;
        const timer = globalThis.setInterval(() => {
          attempts += 1;
          if (locateMessage(messageId, content) || attempts >= 40)
            globalThis.clearInterval(timer);
        }, 100);
        return () => globalThis.clearInterval(timer);
      }, [id, locateMessage]);
      const search = async (event) => {
        event.preventDefault();
        try {
          const value = await request(
            `${apiRoot}/messages/search?keyword=${encodeURIComponent(query)}&session_id=${encodeURIComponent(id || "")}&page_size=20`,
          );
          setResults(value.items || value.results || value);
        } catch (reason) {
          setError(reason.message);
        }
      };
      const beginEdit = (result) => {
        setEditing(result);
        setReplacement(result.message?.content || result.message?.text || "");
      };
      const edit = async (event) => {
        event.preventDefault();
        const replacementContent = replacement.trim();
        if (!replacementContent || !id || !editing) return;
        try {
          const fork = await request(
            `${apiRoot}/sessions/${encodeURIComponent(id)}/fork`,
            {
              method: "POST",
              body: JSON.stringify({
                messageId: editing.message.id,
                replacementContent,
              }),
            },
          );
          location.assign(
            `/?session=${encodeURIComponent(fork.id || fork.sessionId)}`,
          );
        } catch (reason) {
          setError(reason.message);
        }
      };
      const openResult = (result) => {
        const targetSession = result.session?.id || id;
        const messageId = result.message?.id;
        const content = result.message?.content || result.message?.text || "";
        if (messageId)
          sessionStorage.setItem(`workagent.message.${messageId}`, content);
        if (targetSession === id && locateMessage(messageId, content)) return;
        location.assign(
          `/?session=${encodeURIComponent(targetSession)}&message=${encodeURIComponent(messageId)}`,
        );
      };
      return h(
        "div",
        { className: "workagent-search" },
        h(
          "div",
          { className: "workagent-actions" },
          h(Button, { onClick: () => history.back() }, "Back"),
          h(Button, { onClick: () => history.forward() }, "Forward"),
          h(
            Button,
            {
              onClick: () =>
                location.assign(
                  "mailto:support@workagent.invalid?subject=WorkAgent%20feedback",
                ),
            },
            "Feedback",
          ),
          h(
            Button,
            { onClick: () => location.assign("/?workagent=workspaces") },
            "Workspace",
          ),
        ),
        h(
          "form",
          { onSubmit: search },
          h(Input, {
            "aria-label": "Search messages",
            value: query,
            onChange: (e) => setQuery(e.target.value),
            placeholder: "Search this conversation",
          }),
        ),
        error ? h("span", { className: "workagent-error" }, error) : null,
        ...results.map((result) =>
          h(
            Card,
            {
              key: result.message?.id,
              "data-message-role": result.message?.role,
              title:
                result.message?.content ||
                result.message?.text ||
                "Search result",
              detail: result.session?.title,
            },
            h(
              Button,
              {
                onClick: () => openResult(result),
              },
              "Open result",
            ),
            h(Button, { onClick: () => beginEdit(result) }, "Edit and resend"),
          ),
        ),
        editing
          ? h(
              "form",
              { className: "workagent-form", onSubmit: edit },
              h(
                Field,
                { label: "Edit message" },
                h("textarea", {
                  "aria-label": "Edit message",
                  value: replacement,
                  onChange: (event) => setReplacement(event.target.value),
                }),
              ),
              h(Button, { type: "submit" }, "Resend"),
              h(Button, { onClick: () => setEditing(null) }, "Cancel"),
            )
          : null,
      );
    }

    const pages = {
      assistants: PresetsSection,
      automations: AutomationsPage,
      teams: TeamsPage,
      notifications: NotificationsPage,
      workspaces: WorkspacesPage,
    };
    function WorkAgentOverlay() {
      const params = new URLSearchParams(location.search);
      const target = params.get("workagent");
      const sessionId = params.get("session");
      const Page = pages[target];
      if (!Page && !sessionId) return null;
      const label = Page ? target : "message search";
      return h(
        "div",
        {
          role: "dialog",
          "aria-label": label,
          className: "workagent-overlay",
        },
        h(
          "div",
          { className: "workagent-actions" },
          h(Button, { onClick: () => history.back() }, "Back"),
          h(Button, { onClick: () => history.forward() }, "Forward"),
          h(Button, { onClick: () => location.assign("/") }, "Close"),
          h(
            Button,
            {
              onClick: () =>
                location.assign(
                  "mailto:support@workagent.invalid?subject=WorkAgent%20feedback",
                ),
            },
            "Feedback",
          ),
          h(
            Button,
            { onClick: () => location.assign("/?workagent=workspaces") },
            "Workspace",
          ),
        ),
        Page ? h(Page) : h(ConversationUtilities, { sessionId }),
      );
    }

    function NotificationFooter({ wide }) {
      const [state] = useResource(
        "/api/portal/me/notifications",
        (value) => value.notifications || [],
      );
      const unread = state.rows.filter((row) => !row.read_at).length;
      return h(
        "button",
        {
          type: "button",
          className: "workagent-footer",
          title: "Notifications",
          "aria-label": "Notifications",
          onClick: () => location.assign("/?workagent=notifications"),
        },
        wide ? "Notifications" : "N",
        unread > 0 ? h("span", { className: "workagent-badge" }, unread) : null,
      );
    }

    function FooterAction({ wide, kind, theme }) {
      if (kind === "notifications") return h(NotificationFooter, { wide });
      const navigate = (page) => () => location.assign(`/?workagent=${page}`);
      const actions = {
        assistants: ["Assistants", navigate("assistants")],
        tasks: ["Scheduled tasks", navigate("automations")],
        chatgpt: ["ChatGPT", () => location.assign("/chatgpt/")],
        teams: ["Teams", navigate("teams")],
        workspace: ["Workspace", navigate("workspaces")],
        theme: [
          "Theme",
          () => {
            const current = theme.getTheme();
            const next =
              (current.preference || current.resolved) === "dark"
                ? "light"
                : "dark";
            theme.setTheme(next);
          },
        ],
        logout: [
          "Log out",
          async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            location.assign("/");
          },
        ],
      };
      const [label, action] = actions[kind];
      return h(
        "button",
        {
          type: "button",
          className: "workagent-footer",
          title: label,
          "aria-label": label,
          onClick: action,
        },
        wide ? label : label.slice(0, 1),
      );
    }

    const sections = [
      ["workagent-mcp", 30, "MCP servers", MCPSection],
      ["workagent-skills", 31, "Skills", SkillsSection],
      ["workagent-engines", 32, "Engines", EnginesSection],
      ["workagent-presets", 33, "Presets", PresetsSection],
      ["workagent-models", 34, "Models", ModelsSection],
      ["workagent-extensions", 35, "Extensions", ExtensionsSection],
    ];
    const inject = ["slots", "theme"];
    function apply(ctx) {
      installAssets();
      ctx.slots.inject("sidebar.brand.mark", () =>
        ctx.slots.inject("sidebar.brand.name", function* () {
          yield ctx.slots.register({ name: "sidebar.brand.mark" }, BrandMark);
          yield ctx.slots.register({ name: "sidebar.brand.name" }, BrandName);
        }),
      );
      for (const [id, order, label, Component] of sections)
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            { name: "settings.section", id, order, label },
            Component,
          ),
        );
      for (const [order, kind] of [
        "assistants",
        "tasks",
        "chatgpt",
        "teams",
        "notifications",
        "workspace",
        "theme",
        "logout",
      ].entries())
        ctx.slots.inject("sidebar.footer.action", () =>
          ctx.slots.register(
            {
              name: "sidebar.footer.action",
              id: `workagent-${kind}`,
              order: 100 + order,
            },
            (props) => h(FooterAction, { ...props, kind, theme: ctx.theme }),
          ),
        );
      ctx.slots.inject("conversation.session.header.utilities", () =>
        ctx.slots.register(
          {
            name: "conversation.session.header.utilities",
            id: "workagent-message-search",
            order: 80,
          },
          ConversationUtilities,
        ),
      );
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "workagent-page", order: 10 },
          WorkAgentOverlay,
        ),
      );
    }
    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  },
});
