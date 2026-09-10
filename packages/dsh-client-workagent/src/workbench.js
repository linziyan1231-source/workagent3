// Feature adapters consume WorkAgent's authenticated ports and DSH's public atoms.
// Keep this factory free of host services: main and side conversations own their state.
export function createWorkbench({
  React,
  navigate = (href) => location.assign(href),
  friendlyError = (value) => value,
  reasoningLabel = (option) => option.name || option.id,
  primitives,
  request,
  apiRoot,
  fileURL,
  nativeSessionAction,
  uploadFile,
  Icon,
}) {
  const h = React.createElement;
  const button = (label, onClick, props = {}) =>
    h("button", { type: "button", onClick, ...props }, label);
  const readStored = (store, key, fallback) => {
    try {
      return JSON.parse(store.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const saveStored = (store, key, value) => {
    try {
      store.setItem(key, JSON.stringify(value));
    } catch {
      /* Private browsing/storage quota must not prevent composing. */
    }
  };
  function useDraft(sessionId, authorized = true) {
    const key = authorized ? `workagent.draft.${sessionId}` : null;
    const [state, update] = React.useState(() => ({
      key,
      text: key ? readStored(sessionStorage, key, "") : "",
    }));
    const text =
      state.key === key
        ? state.text
        : key
          ? readStored(sessionStorage, key, "")
          : "";
    const set = React.useCallback(
      (value) =>
        update((current) => {
          if (!key) return current;
          const previous =
            current.key === key
              ? current.text
              : readStored(sessionStorage, key, "");
          const next = typeof value === "function" ? value(previous) : value;
          saveStored(sessionStorage, key, next);
          return { key, text: next };
        }),
      [key],
    );
    return [text, set];
  }
  function clearDrafts() {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (
        key?.startsWith("workagent.draft.") ||
        key?.startsWith("workagent.file-draft.")
      )
        sessionStorage.removeItem(key);
    }
  }
  let mermaidPromise;
  function Mermaid({ code }) {
    const [result, setResult] = React.useState(null);
    const [source, setSource] = React.useState(false);
    const [theme, setTheme] = React.useState(() =>
      document.body.hasAttribute("data-ds-dark-theme") ? "dark" : "default",
    );
    React.useEffect(() => {
      const observer = new MutationObserver(() =>
        setTheme(
          document.body.hasAttribute("data-ds-dark-theme") ? "dark" : "default",
        ),
      );
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ["data-ds-dark-theme"],
      });
      return () => observer.disconnect();
    }, []);
    const id = React.useId().replaceAll(":", "");
    React.useEffect(() => {
      let live = true;
      setResult(null);
      const mermaidURL =
        "/plugins/@workagent/dsh-client/mermaid/mermaid.esm.min.mjs";
      mermaidPromise ??= import(/* @vite-ignore */ mermaidURL)
        .then(({ default: mermaid }) => {
          return mermaid;
        })
        .catch((error) => {
          mermaidPromise = undefined;
          throw error;
        });
      mermaidPromise
        .then((mermaid) => {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            suppressErrorRendering: true,
            theme,
          });
          return mermaid.render(`wa-diagram-${id}`, code);
        })
        .then((value) => {
          if (live) setResult({ svg: value.svg });
        })
        .catch(() => {
          if (live) setResult({ error: "图表暂时无法显示，可查看源码。" });
        });
      return () => {
        live = false;
      };
    }, [code, id, theme]);
    return h(
      "figure",
      { className: "workagent-diagram" },
      button(source ? "图表" : "Mermaid 源码", () => setSource(!source)),
      source || result?.error
        ? h(primitives.CodeBlock, { code, lang: "mermaid" })
        : result?.svg
          ? h("div", { dangerouslySetInnerHTML: { __html: result.svg } })
          : h("p", { role: "status" }, "正在绘制图表…"),
      result?.error ? h("figcaption", null, result.error) : null,
    );
  }
  // Only relative workspace destinations are rewritten. Remote URLs retain DSH's
  // allowlist; absolute machine paths never become cross-workspace download links.
  function workspaceDestination(value, workspaceId) {
    if (!workspaceId || !value || /^(?:[a-z][a-z\d+.-]*:|[/\\#])/i.test(value))
      return null;
    let path;
    try {
      path = decodeURIComponent(value).replaceAll("\\", "/");
    } catch {
      return null;
    }
    if (path.split("/").includes("..") || path.includes(":")) return null;
    const anchor = /#L?(\d+)(?:[-:]\d+)?$/.exec(path);
    if (anchor) path = path.slice(0, anchor.index);
    return new URL(
      fileURL(workspaceId, path.replace(/^\.\//, ""), true) +
        (anchor ? `#L${anchor[1]}` : ""),
      location.origin,
    ).href;
  }
  function Markdown({ children, streaming = false, workspaceId }) {
    const [error, setError] = React.useState("");
    const text = String(children || "");
    // Leave code fences untouched; handle explicitly closed Mermaid fences only.
    const chunks = text.split(
      /(^ {0,3}(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}(?:`{3,}|~{3,})\s*$)/gm,
    );
    const diagrams = [];
    const rendered = chunks
      .map((chunk, index) => {
        const diagram =
          /^ {0,3}(`{3,}|~{3,})mermaid\s*\n([\s\S]*?)\n {0,3}\1\s*$/.exec(
            chunk,
          );
        if (diagram && !streaming)
          diagrams.push(h(Mermaid, { key: index, code: diagram[2] }));
        if (index % 2) return chunk;
        return chunk.replace(
          /(`+)[\s\S]*?\1|(!?\[[^\]\n]*\]\()([^\s)]+)(\))/g,
          (match, codeDelimiter, start, destination, end) => {
            if (codeDelimiter) return match;
            const url = workspaceDestination(destination, workspaceId);
            return url ? `${start}${url}${end}` : match;
          },
        );
      })
      .join("");
    return h(
      "div",
      {
        className: "workagent-markdown",
        onClick: async (event) => {
          const anchor = event.target.closest?.("a[href]");
          if (
            !anchor ||
            !workspaceId ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          const url = new URL(anchor.href, location.origin);
          const base = new URL(fileURL(workspaceId, "", true), location.origin);
          if (
            url.origin !== base.origin ||
            url.pathname !== base.pathname ||
            !url.searchParams.has("path")
          )
            return;
          event.preventDefault();
          try {
            const entry = await request(
              `${apiRoot}/workspaces/${encodeURIComponent(workspaceId)}/locate?path=${encodeURIComponent(url.searchParams.get("path"))}`,
            );
            const line = /^#L(\d+)$/.exec(url.hash);
            window.dispatchEvent(
              new CustomEvent("workagent:file-open", {
                detail: {
                  workspaceId,
                  entry: {
                    ...entry,
                    ...(line ? { line: Number(line[1]) } : {}),
                  },
                },
              }),
            );
            setError("");
          } catch (reason) {
            setError(friendlyError(reason.message));
          }
        },
      },
      h(primitives.MarkdownText, {
        text: rendered,
        streaming,
        codeLabels: { copyLabel: "复制代码", copiedLabel: "已复制" },
      }),
      ...diagrams,
      error ? h("small", { role: "alert" }, error) : null,
    );
  }

  function FileLocation({ workspaceId, path, line }) {
    const [error, setError] = React.useState("");
    return h(
      "span",
      null,
      button(`${path}${line ? `:${line}` : ""}`, async () => {
        try {
          const entry = await request(
            `${apiRoot}/workspaces/${encodeURIComponent(workspaceId)}/locate?path=${encodeURIComponent(path)}`,
          );
          window.dispatchEvent(
            new CustomEvent("workagent:file-open", {
              detail: {
                workspaceId,
                entry: {
                  ...entry,
                  line:
                    Number.isSafeInteger(line) && line > 0 ? line : undefined,
                },
              },
            }),
          );
        } catch (reason) {
          setError(friendlyError(reason.message));
        }
      }),
      error ? h("small", { role: "alert" }, error) : null,
    );
  }
  function Artifacts({ sessionId, workspaceId, revision }) {
    const [rows, setRows] = React.useState([]);
    React.useEffect(() => {
      if (!workspaceId || !sessionId) return;
      const controller = new AbortController();
      request(
        `${apiRoot}/workspaces/${encodeURIComponent(workspaceId)}/assets?sessionId=${encodeURIComponent(sessionId)}`,
        { signal: controller.signal },
      )
        .then((value) => {
          if (!controller.signal.aborted)
            setRows(value.filter((row) => row.kind === "artifact"));
        })
        .catch(() => {});
      return () => controller.abort();
    }, [sessionId, workspaceId, revision]);
    return rows.length
      ? h(
          "details",
          { className: "workagent-artifacts" },
          h("summary", null, `会话产物 · ${rows.length}`),
          ...rows.map((row) =>
            h(
              "div",
              { key: row.id },
              h(FileLocation, { workspaceId, path: row.path }),
              h(
                "a",
                { href: fileURL(workspaceId, row.path), download: row.name },
                "下载",
              ),
            ),
          ),
        )
      : null;
  }
  function Tools({ tools = {}, workspaceId }) {
    const rows = Object.values(tools);
    if (!rows.length) return null;
    return h(
      "details",
      { className: "workagent-tool-history" },
      h("summary", null, `工具过程 · ${rows.length}`),
      rows.map((tool) =>
        h(
          "details",
          { key: tool.toolCallId },
          h(
            "summary",
            null,
            `${tool.tool || "工具"} · ${tool.type === "tool.completed" ? (tool.failed ? "失败" : "完成") : "未返回完成结果"}`,
          ),
          workspaceId && Array.isArray(tool.locations)
            ? tool.locations
                .filter((item) => typeof item?.path === "string")
                .map((item, index) =>
                  h(FileLocation, {
                    key: index,
                    workspaceId,
                    path: item.path,
                    line: item.line,
                  }),
                )
            : null,
          ["input", "output", "result", "locations", "raw"]
            .filter((key) => tool[key] !== undefined)
            .map((key) =>
              h(
                "section",
                { key },
                h("strong", null, key),
                h(primitives.CodeBlock, {
                  code:
                    typeof tool[key] === "string"
                      ? tool[key]
                      : JSON.stringify(tool[key], null, 2),
                  lang: typeof tool[key] === "string" ? "text" : "json",
                }),
              ),
            ),
        ),
      ),
    );
  }
  function Process({ items }) {
    const rows = Object.values(items || {});
    if (!rows.length) return null;
    return h(
      "details",
      { className: "workagent-process" },
      h("summary", null, "计划与过程"),
      ...rows.map((row) =>
        h(
          "section",
          { key: row.processId },
          h("h4", null, row.kind === "plan" ? "执行计划" : "引擎过程摘要"),
          row.text
            ? h("p", { style: { whiteSpace: "pre-wrap" } }, row.text)
            : null,
          Array.isArray(row.data)
            ? h(
                "ol",
                null,
                ...row.data.map((entry, index) =>
                  h(
                    "li",
                    { key: index },
                    `${{ pending: "待开始", in_progress: "进行中", completed: "已完成" }[entry.status] || entry.status || ""} · ${entry.step || entry.content || ""}`,
                  ),
                ),
              )
            : null,
        ),
      ),
    );
  }
  function SessionReminder({ sessionId }) {
    const [state, setState] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    React.useEffect(() => {
      const controller = new AbortController();
      request(`${apiRoot}/completion-notifications`, {
        signal: controller.signal,
      })
        .then((value) => {
          if (!controller.signal.aborted) setState(value);
        })
        .catch((reason) => {
          if (!controller.signal.aborted)
            setError(friendlyError(reason.message));
        });
      return () => controller.abort();
    }, [sessionId]);
    return h(
      "div",
      { className: "workagent-session-reminder" },
      h(
        "label",
        null,
        "当前会话的渠道提醒",
        h(
          "select",
          {
            "aria-label": "当前会话渠道提醒",
            disabled: !state || busy,
            value: state?.mutedSessions?.includes(sessionId)
              ? "off"
              : "inherit",
            onChange: async (event) => {
              setBusy(true);
              setError("");
              try {
                setState(
                  await request(`${apiRoot}/completion-notifications/session`, {
                    method: "PUT",
                    body: JSON.stringify({
                      sessionId,
                      enabled: event.target.value !== "off",
                    }),
                  }),
                );
              } catch (reason) {
                setError(friendlyError(reason.message));
              } finally {
                setBusy(false);
              }
            },
          },
          h("option", { value: "inherit" }, "跟随全局设置"),
          h("option", { value: "off" }, "此会话不提醒"),
        ),
      ),
      error ? h("small", { role: "alert" }, error) : null,
    );
  }
  function Controls({ ctx, session, busy, cancel }) {
    const [permission, setPermission] = React.useState(
      session?.permissionMode || "",
    );
    React.useEffect(
      () => setPermission(session?.permissionMode || ""),
      [session?.permissionMode, session?.id],
    );
    const [catalog, setCatalog] = React.useState(null);
    const [pending, setPending] = React.useState([]);
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState("");
    const sessionId = session?.id;
    React.useEffect(() => {
      if (!sessionId || !ctx?.sessions?.binding) return;
      let live = true;
      Promise.all([
        nativeSessionAction(ctx, sessionId, "models"),
        session.permissionMode
          ? Promise.resolve({ permissionMode: session.permissionMode })
          : request(
              `${apiRoot}/sessions/${encodeURIComponent(sessionId)}/configuration`,
            ),
      ])
        .then(([value, configuration]) => {
          if (live) {
            setCatalog(value);
            setPermission(configuration.permissionMode || "");
          }
        })
        .catch((reason) => {
          if (live) setError(friendlyError(reason.message));
        });
      return () => {
        live = false;
      };
    }, [ctx, sessionId, busy, session?.permissionMode]);
    React.useEffect(() => {
      if (!sessionId) return;
      let live = true,
        timer;
      const refresh = async () => {
        try {
          const rows = await request(
            `${apiRoot}/interactions?sessionId=${encodeURIComponent(sessionId)}`,
          );
          if (live) setPending(rows);
        } catch (reason) {
          if (live && busy) setError(friendlyError(reason.message));
        } finally {
          if (live) timer = setTimeout(refresh, 1500);
        }
      };
      void refresh();
      return () => {
        live = false;
        clearTimeout(timer);
      };
    }, [sessionId, busy]);
    const select = async (selection) => {
      setSaving(true);
      setError("");
      try {
        await nativeSessionAction(ctx, sessionId, "selectModel", selection);
        setCatalog(await nativeSessionAction(ctx, sessionId, "models"));
      } catch (reason) {
        setError(friendlyError(reason.message));
      } finally {
        setSaving(false);
      }
    };
    const decide = async (item, decision) => {
      setSaving(true);
      setError("");
      try {
        await request(
          `${apiRoot}/interactions/${encodeURIComponent(item.id)}/respond`,
          { method: "POST", body: JSON.stringify({ decision }) },
        );
        setPending((rows) => rows.filter((row) => row.id !== item.id));
      } catch (reason) {
        setError(friendlyError(reason.message));
      } finally {
        setSaving(false);
      }
    };
    const groups = catalog?.groups || [];
    const current = catalog?.current;
    const model = groups
      .flatMap((group) => group.models)
      .find((row) => row.id === current?.model);
    return h(
      "div",
      { className: "workagent-session-controls" },
      current
        ? h(
            "label",
            { className: "workagent-model-choice", title: model?.name },
            h(
              "span",
              {
                className: "workagent-model-choice-label",
                "aria-hidden": true,
              },
              model?.name || current.model,
            ),
            h(
              "select",
              {
                "aria-label": "当前会话模型",
                disabled: busy || saving,
                value: `${current.provider}/${current.model}`,
                onChange: (event) => {
                  const [provider, ...rest] = event.target.value.split("/");
                  void select({ provider, model: rest.join("/") });
                },
              },
              groups.map((group) =>
                h(
                  "optgroup",
                  { key: group.id, label: group.name },
                  group.models.map((row) =>
                    h(
                      "option",
                      { key: row.id, value: `${group.id}/${row.id}` },
                      row.name,
                    ),
                  ),
                ),
              ),
            ),
          )
        : null,
      model?.reasoning
        ? h(
            "label",
            null,
            h(
              "select",
              {
                "aria-label": "当前会话思考强度",
                disabled: busy || saving,
                value:
                  current.reasoningEffort ||
                  model.reasoning.defaultEffort ||
                  "",
                onChange: (event) => {
                  const { reasoningEffort: _old, ...base } = current;
                  void select({
                    ...base,
                    ...(event.target.value
                      ? { reasoningEffort: event.target.value }
                      : {}),
                  });
                },
              },
              !current.reasoningEffort && !model.reasoning.defaultEffort
                ? h(
                    "option",
                    { value: "", disabled: true, hidden: true },
                    "思考强度",
                  )
                : null,
              h(
                "optgroup",
                { label: "思考强度" },
                model.reasoning.efforts.map((row) =>
                  h(
                    "option",
                    { key: row.id, value: row.id },
                    reasoningLabel(row),
                  ),
                ),
              ),
            ),
          )
        : null,
      h(
        "label",
        null,
        h(
          "select",
          {
            "aria-label": "当前会话权限",
            value: permission,
            disabled:
              busy || saving || !session?.id || session.engine === "harness",
            onChange: async (event) => {
              const next = event.target.value;
              setSaving(true);
              setError("");
              try {
                const value = await request(
                  `${apiRoot}/sessions/${encodeURIComponent(session.id)}/configuration`,
                  {
                    method: "PATCH",
                    body: JSON.stringify({ permissionMode: next }),
                  },
                );
                setPermission(value.permissionMode);
              } catch (reason) {
                setError(friendlyError(reason.message));
              } finally {
                setSaving(false);
              }
            },
          },
          !permission
            ? h("option", { value: "", disabled: true, hidden: true }, "权限")
            : null,
          permission === "manual_approval"
            ? h(
                "option",
                { value: "manual_approval", disabled: true, hidden: true },
                "逐次确认",
              )
            : null,
          h(
            "optgroup",
            { label: "权限" },
            h("option", { value: "read_only" }, "只读"),
            h("option", { value: "workspace_write" }, "项目内读写"),
            h("option", { value: "full_access" }, "完全访问"),
          ),
        ),
      ),
      pending.map((item) =>
        h(
          "section",
          {
            className: "workagent-approval",
            key: item.id,
            "aria-label": "等待授权",
          },
          h("strong", null, `需要授权 · ${item.tool}`),
          h("p", null, item.summary),
          item.input !== undefined
            ? h(
                "details",
                null,
                h("summary", null, "操作详情"),
                h(primitives.CodeBlock, {
                  code: JSON.stringify(item.input, null, 2),
                  lang: "json",
                }),
              )
            : null,
          button("允许本次", () => void decide(item, "allow"), {
            disabled: saving,
          }),
          button("拒绝", () => void decide(item, "reject"), {
            disabled: saving,
          }),
          button("停止任务", cancel, { disabled: saving }),
        ),
      ),
      error ? h("span", { role: "alert" }, error) : null,
    );
  }
  function usePins() {
    const key = "workagent.session-pins.v1";
    const [pins, setPins] = React.useState(() =>
      readStored(localStorage, key, []),
    );
    React.useEffect(() => {
      const update = (event) => {
        if (event.key === key || event.key === null)
          setPins(readStored(localStorage, key, []));
      };
      window.addEventListener("storage", update);
      return () => window.removeEventListener("storage", update);
    }, []);
    const save = (next) => {
      setPins(next);
      saveStored(localStorage, key, next);
    };
    return {
      pins,
      toggle: (id) =>
        save(
          pins.includes(id)
            ? pins.filter((value) => value !== id)
            : [...pins, id],
        ),
      move: (id, target) => {
        if (id === target || !pins.includes(id) || !pins.includes(target))
          return;
        const next = pins.filter((value) => value !== id);
        next.splice(next.indexOf(target), 0, id);
        save(next);
      },
    };
  }
  function Notifications({ sessions = [], settings = true }) {
    const [enabled, setEnabled] = React.useState(() =>
      readStored(localStorage, "workagent.browser-notifications", false),
    );
    const [error, setError] = React.useState("");
    const known = React.useRef(new Map());
    React.useEffect(() => {
      const sync = () =>
        setEnabled(
          readStored(localStorage, "workagent.browser-notifications", false),
        );
      window.addEventListener("storage", sync);
      window.addEventListener("workagent:notifications-changed", sync);
      return () => {
        window.removeEventListener("storage", sync);
        window.removeEventListener("workagent:notifications-changed", sync);
      };
    }, []);
    React.useEffect(() => {
      if (!enabled || settings) return;
      let live = true,
        timer;
      async function pollApprovals() {
        try {
          const rows = await request(`${apiRoot}/interactions`);
          if (
            !live ||
            !(document.hidden || !document.hasFocus()) ||
            typeof Notification === "undefined" ||
            Notification.permission !== "granted"
          )
            return;
          for (const item of rows) {
            const key = `workagent.approval-notified.${item.id}`;
            if (readStored(localStorage, key, false)) continue;
            const notice = new Notification("WorkAgent · 等待确认", {
              body: item.summary || "任务需要你确认后继续",
              tag: `workagent-approval-${item.id}`,
            });
            saveStored(localStorage, key, true);
            notice.onclick = () => {
              window.focus();
              navigate(
                `/?frontend=dsh&session=${encodeURIComponent(item.sessionId)}`,
              );
              notice.close();
            };
          }
        } catch {
          // A disconnected runtime is retried without manufacturing a notification.
        } finally {
          if (live) timer = setTimeout(pollApprovals, 3000);
        }
      }
      void pollApprovals();
      return () => {
        live = false;
        clearTimeout(timer);
      };
    }, [enabled, settings]);
    React.useEffect(() => {
      for (const session of sessions) {
        const turn = session.lastTurn;
        const previous = known.current.get(session.id);
        const current = `${turn?.id || ""}:${turn?.status || ""}`;
        known.current.set(session.id, current);
        if (
          !enabled ||
          previous === undefined ||
          previous === current ||
          !turn ||
          turn.status !== "completed" ||
          !(document.hidden || !document.hasFocus())
        )
          continue;
        if (
          typeof Notification === "undefined" ||
          Notification.permission !== "granted"
        )
          continue;
        const key = `workagent.notified.${session.id}`;
        if (readStored(localStorage, key, "") === turn.id) continue;
        saveStored(localStorage, key, turn.id);
        const notice = new Notification("WorkAgent · 任务完成", {
          body: session.title || "对话已完成",
          tag: `workagent-${session.id}`,
        });
        notice.onclick = () => {
          window.focus();
          navigate(`/?frontend=dsh&session=${encodeURIComponent(session.id)}`);
          notice.close();
        };
      }
    }, [sessions, enabled]);
    if (!settings) return null;
    return h(
      "div",
      { className: "workagent-browser-notifications" },
      button(enabled ? "关闭桌面提醒" : "开启桌面提醒", async () => {
        setError("");
        if (enabled) {
          setEnabled(false);
          saveStored(localStorage, "workagent.browser-notifications", false);
          window.dispatchEvent(new Event("workagent:notifications-changed"));
          return;
        }
        if (typeof Notification === "undefined") {
          setError("此浏览器不支持桌面提醒。");
          return;
        }
        try {
          const granted =
            (await Notification.requestPermission()) === "granted";
          setEnabled(granted);
          saveStored(localStorage, "workagent.browser-notifications", granted);
          window.dispatchEvent(new Event("workagent:notifications-changed"));
          if (!granted) setError("请在浏览器站点设置中允许通知。");
        } catch {
          setError("无法开启桌面提醒。");
        }
      }),
      error ? h("small", { role: "status" }, error) : null,
    );
  }
  function ComposerTools({
    session,
    input,
    setInput,
    onError,
    disabled,
    onBusyChange,
  }) {
    const uploadInput = React.useRef(null);
    const uploadControl = React.useRef(null);
    const [uploadProgress, setUploadProgress] = React.useState(null);
    const [uploading, setUploading] = React.useState(false);
    const [directory, setDirectory] = React.useState("");
    const [entries, setEntries] = React.useState([]);
    const [filesOpen, setFilesOpen] = React.useState(false);
    const [commandsOpen, setCommandsOpen] = React.useState(false);
    const mention = /(?:^|\s)@([^\s]*)$/.exec(input)?.[1];
    const showingFiles = filesOpen || mention !== undefined;
    const workspaceId = session?.workspaceId;
    const live = React.useRef(true);
    React.useEffect(() => {
      live.current = true;
      return () => {
        live.current = false;
        uploadControl.current?.abort();
      };
    }, []);
    React.useEffect(() => {
      if (!showingFiles || !workspaceId) return;
      const abort = new AbortController();
      request(
        `${apiRoot}/workspaces/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(directory)}`,
        { signal: abort.signal },
      )
        .then((rows) => {
          if (!abort.signal.aborted) setEntries(rows);
        })
        .catch((error) => {
          if (!abort.signal.aborted) onError(error.message);
        });
      return () => abort.abort();
    }, [workspaceId, showingFiles, directory]);
    const insert = (path) =>
      setInput(
        (value) =>
          `${value.replace(/(?:^|\s)@[^\s]*$/, "")}${value && !/\s$/.test(value) ? "\n" : ""}项目文件：${JSON.stringify(path)}\n`,
      );
    const upload = async (files) => {
      if (!workspaceId || uploading || disabled) return;
      setUploading(true);
      const controller = new AbortController();
      uploadControl.current = controller;
      onBusyChange?.(true);
      onError("");
      try {
        for (const file of files) {
          if (file.size > 1024 * 1024 * 1024)
            throw new Error(`${file.name}：超过 1 GB`);
          const name = file.name.replace(/[\\/:*?"<>|]/g, "_");
          const prefix = `.attachments/${session.id}/`;
          const path = `${prefix}${crypto.randomUUID()}/${name}`;
          const savedPath = await uploadFile(workspaceId, path, file, {
            signal: controller.signal,
            resumePrefix: prefix,
            onProgress: (bytes) => {
              if (live.current)
                setUploadProgress({ name: file.name, bytes, size: file.size });
            },
          });
          if (live.current) insert(savedPath);
        }
        window.dispatchEvent(new Event("workagent:files-changed"));
      } catch (error) {
        if (live.current) onError(error.message);
      } finally {
        uploadControl.current = null;
        window.dispatchEvent(new Event("workagent:files-changed"));
        if (live.current) {
          setUploading(false);
          setUploadProgress(null);
          onBusyChange?.(false);
        }
      }
    };
    React.useEffect(() => {
      // Scoped to the adjacent textarea so side-chat paste never edits the main draft.
      const form = uploadInput.current?.closest("form");
      if (!form) return;
      const paste = (event) => {
        const files = [...(event.clipboardData?.files || [])];
        if (files.length) {
          event.preventDefault();
          void upload(files);
        }
      };
      const drop = (event) => {
        if (!event.dataTransfer?.files.length) return;
        event.preventDefault();
        void upload([...event.dataTransfer.files]);
      };
      const over = (event) => {
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
      };
      form.addEventListener("paste", paste);
      form.addEventListener("drop", drop);
      form.addEventListener("dragover", over);
      return () => {
        form.removeEventListener("paste", paste);
        form.removeEventListener("drop", drop);
        form.removeEventListener("dragover", over);
      };
    }, [workspaceId, uploading, disabled, setInput]);
    const skills = session?.preset?.resolvedSnapshot?.skillIds || [];
    const slash = /^\/([^\s]*)$/.exec(input);
    const commands = [
      { id: "btw", label: "发起侧聊", text: "/btw " },
      ...skills.map((id) => ({
        id,
        label: `使用已加载技能 ${id}`,
        text: `请使用当前助手已加载的技能 ${JSON.stringify(id)} 处理以下任务：\n`,
      })),
    ].filter(
      (row) => !slash || row.id.toLowerCase().includes(slash[1].toLowerCase()),
    );
    React.useEffect(() => {
      const form = uploadInput.current?.closest("form");
      if (!form) return;
      const navigate = (event) => {
        if (
          event.target.tagName !== "TEXTAREA" ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          !["Tab", "ArrowDown"].includes(event.key)
        )
          return;
        const first = form.querySelector(".workagent-composer-menu button");
        if (!first) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Tab" && !event.shiftKey) first.click();
        else first.focus();
      };
      form.addEventListener("keydown", navigate, true);
      return () => form.removeEventListener("keydown", navigate, true);
    }, []);
    return h(
      "div",
      { className: "workagent-composer-tools" },
      h("input", {
        ref: uploadInput,
        type: "file",
        multiple: true,
        hidden: true,
        "aria-label": "选择会话附件",
        onChange: (event) => {
          const files = [...event.target.files];
          event.target.value = "";
          void upload(files);
        },
      }),
      button(
        Icon ? h(Icon, { name: "plus", size: 18 }) : "+",
        () => uploadInput.current.click(),
        {
          disabled: disabled || uploading || !workspaceId,
          "aria-label": uploading ? "正在上传…" : "附件",
          className: "workagent-attachment-button",
          title: "上传到当前项目并引用文件路径；支持粘贴和拖放",
        },
      ),
      h(Voice, { setInput, onError, disabled: disabled || uploading }),
      uploadProgress
        ? h(
            "div",
            null,
            uploadProgress.name,
            h("progress", {
              max: uploadProgress.size || 1,
              value: uploadProgress.bytes,
            }),
            button("暂停上传", () => uploadControl.current?.abort()),
          )
        : null,
      showingFiles
        ? h(
            "div",
            {
              className: "workagent-composer-menu",
              "aria-label": "引用项目文件",
            },
            directory
              ? button("上级目录", () =>
                  setDirectory(directory.split("/").slice(0, -1).join("/")),
                )
              : null,
            entries
              .filter(
                (entry) =>
                  mention === undefined ||
                  entry.name.toLowerCase().includes(mention.toLowerCase()),
              )
              .map((entry) =>
                button(
                  `${entry.kind === "directory" ? "▸ " : ""}${entry.name}`,
                  () => {
                    if (entry.kind === "directory") setDirectory(entry.path);
                    else {
                      insert(entry.path);
                      setFilesOpen(false);
                    }
                  },
                  { key: entry.path },
                ),
              ),
            entries.length ? null : h("span", null, "此目录没有文件"),
          )
        : null,
      slash || commandsOpen
        ? h(
            "div",
            {
              className: "workagent-composer-menu",
              "aria-label": "命令与已加载技能",
            },
            commands.map((command) =>
              button(
                `/${command.id} · ${command.label}`,
                () => {
                  setInput((value) =>
                    slash
                      ? command.text
                      : `${value}${value ? "\n" : ""}${command.text}`,
                  );
                  setCommandsOpen(false);
                },
                { key: command.id },
              ),
            ),
          )
        : null,
    );
  }
  // The managed adapter accepts a multipart file. MediaRecorder's browser format
  // stays explicit; no provider secret or employee configuration is sent by UI.
  function Voice({ setInput, onError, disabled }) {
    const [capability, setCapability] = React.useState(null);
    const [state, setState] = React.useState("idle");
    const recording = React.useRef(null);
    const live = React.useRef(true);
    React.useEffect(() => {
      live.current = true;
      request("/api/speech/capability")
        .then((value) => {
          if (live.current) setCapability(value);
        })
        .catch(() => {});
      return () => {
        live.current = false;
        recording.current?.stop();
      };
    }, []);
    const start = async () => {
      if (state === "recording") {
        recording.current?.stop();
        return;
      }
      setState("starting");
      onError("");
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!live.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const recorder = new MediaRecorder(stream);
        const parts = [];
        let timer;
        const stop = () => {
          clearTimeout(timer);
          if (recorder.state !== "inactive") recorder.stop();
          stream.getTracks().forEach((track) => track.stop());
        };
        recording.current = { stop };
        recorder.ondataavailable = (event) => {
          if (event.data.size) parts.push(event.data);
        };
        recorder.onstop = async () => {
          clearTimeout(timer);
          stream.getTracks().forEach((track) => track.stop());
          recording.current = null;
          if (!live.current) return;
          setState("transcribing");
          try {
            const blob = new Blob(parts, { type: recorder.mimeType });
            if (
              capability.maxAudioBytes &&
              blob.size > capability.maxAudioBytes
            )
              throw new Error("录音超过大小限制，请缩短后重试。");
            const data = new FormData();
            data.append(
              "file",
              blob,
              recorder.mimeType.includes("mp4")
                ? "recording.mp4"
                : "recording.webm",
            );
            const response = await fetch("/api/stt", {
              method: "POST",
              credentials: "same-origin",
              body: data,
            });
            const result = await response.json();
            if (!response.ok || result.success === false)
              throw new Error(result.error || "语音转写失败");
            const text = result.data?.text ?? result.text;
            if (typeof text !== "string")
              throw new Error("转写服务没有返回文字。");
            if (live.current)
              setInput((value) => `${value}${value ? "\n" : ""}${text}`);
          } catch (error) {
            if (live.current) onError(error.message);
          } finally {
            if (live.current) setState("idle");
          }
        };
        recorder.start();
        setState("recording");
        timer = setTimeout(
          stop,
          Math.min(capability.maxStreamSeconds || 60, 300) * 1000,
        );
      } catch (error) {
        stream?.getTracks().forEach((track) => track.stop());
        if (live.current) {
          setState("idle");
          onError(error.message);
        }
      }
    };
    if (!capability?.enabled) return null;
    const available = Boolean(
      navigator.mediaDevices?.getUserMedia &&
        typeof MediaRecorder !== "undefined",
    );
    return button(
      {
        idle: "语音输入",
        starting: "正在开启麦克风…",
        recording: "停止并转写",
        transcribing: "正在转写…",
      }[state],
      () => void start(),
      {
        disabled:
          !available ||
          disabled ||
          ["starting", "transcribing"].includes(state),
        title: available
          ? "转写后填入草稿，由你确认发送"
          : "请使用支持麦克风的 HTTPS 或本机浏览器连接",
        "aria-pressed": state === "recording",
      },
    );
  }
  function TextEditor({
    workspaceId,
    path,
    original,
    onSaved,
    onCancel,
    onDirty,
  }) {
    const key = `workagent.file-draft.${workspaceId}.${path}`;
    // The parent mounts editors only after the authenticated file read succeeds.
    const [draft] = React.useState(() => readStored(sessionStorage, key, null));
    const [base] = React.useState(draft?.base ?? original);
    const [text, setText] = React.useState(draft?.text ?? original);
    const [diff, setDiff] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const dirty = text !== base;
    React.useEffect(() => {
      if (dirty) saveStored(sessionStorage, key, { base, text });
      else sessionStorage.removeItem(key);
      onDirty?.(dirty);
    }, [key, base, text, dirty, onDirty]);
    React.useEffect(() => {
      if (!dirty) return;
      const warn = (event) => {
        event.preventDefault();
        event.returnValue = "";
      };
      window.addEventListener("beforeunload", warn);
      return () => window.removeEventListener("beforeunload", warn);
    }, [dirty]);
    return h(
      "div",
      { className: "workagent-text-editor" },
      h(
        "p",
        { role: "status" },
        dirty ? "有未保存修改 · 草稿保存在当前浏览器标签页" : "尚无修改",
      ),
      base !== original
        ? h(
            "p",
            { role: "alert" },
            "文件已在其他位置修改。保留了你的草稿；保存时会检查冲突。",
          )
        : null,
      h(
        "div",
        { className: "workagent-editor-body" },
        diff
          ? h(primitives.DiffBlock, {
              diffs: [{ path, oldText: base, newText: text }],
              maxLines: 80,
            })
          : null,
        h("textarea", {
          hidden: diff,
          "aria-label": "编辑文件内容",
          value: text,
          onChange: (event) => setText(event.target.value),
          spellCheck: false,
        }),
      ),
      h(
        "div",
        { className: "workagent-editor-actions" },
        button(diff ? "返回编辑" : "查看修改对比", () => setDiff(!diff)),
        button(
          busy ? "正在保存…" : "保存文件",
          async () => {
            setBusy(true);
            setError("");
            try {
              await request(fileURL(workspaceId, path), {
                method: "PATCH",
                body: JSON.stringify({ original: base, text }),
              });
              sessionStorage.removeItem(key);
              onDirty?.(false);
              onSaved(text);
              window.dispatchEvent(new Event("workagent:files-changed"));
            } catch (reason) {
              setError(friendlyError(reason.message));
            } finally {
              setBusy(false);
            }
          },
          { disabled: busy },
        ),
        button(
          "取消编辑",
          () => {
            if (dirty && !window.confirm("放弃此文件的未保存修改？")) return;
            sessionStorage.removeItem(key);
            onDirty?.(false);
            onCancel();
          },
          { disabled: busy },
        ),
      ),
      error ? h("p", { role: "alert" }, error) : null,
    );
  }
  return {
    Artifacts,
    Process,
    Markdown,
    Controls,
    Tools,
    useDraft,
    clearDrafts,
    usePins,
    Notifications,
    SessionReminder,
    ComposerTools,
    TextEditor,
    workspaceDestination,
  };
}
