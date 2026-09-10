// HTTP installations expose getRandomValues but may lack randomUUID. DSH RPC
// bindings need this API as well as our attachment uploader.
if (typeof globalThis.crypto.randomUUID !== "function") {
  globalThis.crypto.randomUUID = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  };
}
window.__ModuleLoader__.load({
  id: "@workagent/dsh-client",
  factory: (require) => {
    const module = { exports: {} };
    const React = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    // Feature adapters consume WorkAgent's authenticated ports and DSH's public atoms.
    // Keep this factory free of host services: main and side conversations own their state.
    function createWorkbench({
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
              const next =
                typeof value === "function" ? value(previous) : value;
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
              document.body.hasAttribute("data-ds-dark-theme")
                ? "dark"
                : "default",
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
        if (
          !workspaceId ||
          !value ||
          /^(?:[a-z][a-z\d+.-]*:|[/\\#])/i.test(value)
        )
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
              const base = new URL(
                fileURL(workspaceId, "", true),
                location.origin,
              );
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
                        Number.isSafeInteger(line) && line > 0
                          ? line
                          : undefined,
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
                    {
                      href: fileURL(workspaceId, row.path),
                      download: row.name,
                    },
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
                      await request(
                        `${apiRoot}/completion-notifications/session`,
                        {
                          method: "PUT",
                          body: JSON.stringify({
                            sessionId,
                            enabled: event.target.value !== "off",
                          }),
                        },
                      ),
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
                  busy ||
                  saving ||
                  !session?.id ||
                  session.engine === "harness",
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
                ? h(
                    "option",
                    { value: "", disabled: true, hidden: true },
                    "权限",
                  )
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
              readStored(
                localStorage,
                "workagent.browser-notifications",
                false,
              ),
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
              navigate(
                `/?frontend=dsh&session=${encodeURIComponent(session.id)}`,
              );
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
              saveStored(
                localStorage,
                "workagent.browser-notifications",
                false,
              );
              window.dispatchEvent(
                new Event("workagent:notifications-changed"),
              );
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
              saveStored(
                localStorage,
                "workagent.browser-notifications",
                granted,
              );
              window.dispatchEvent(
                new Event("workagent:notifications-changed"),
              );
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
                    setUploadProgress({
                      name: file.name,
                      bytes,
                      size: file.size,
                    });
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
            if (event.dataTransfer?.types.includes("Files"))
              event.preventDefault();
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
          (row) =>
            !slash || row.id.toLowerCase().includes(slash[1].toLowerCase()),
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
                        if (entry.kind === "directory")
                          setDirectory(entry.path);
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
        const [draft] = React.useState(() =>
          readStored(sessionStorage, key, null),
        );
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
                if (dirty && !window.confirm("放弃此文件的未保存修改？"))
                  return;
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

    function createAutomations({
      React,
      request,
      apiRoot,
      useResource,
      Section,
      Field,
      Input,
      Select,
      Button,
      Card,
      Status,
      friendlyError,
    }) {
      const h = React.createElement;
      const endpoint = `${apiRoot}/automations`;
      const runLabels = {
        pending: "等待",
        running: "运行中",
        succeeded: "成功",
        failed: "失败",
        cancelled: "已取消",
      };
      function SkillSuggestion({ row, run, saved }) {
        const [text, setText] = React.useState(null);
        const [name, setName] = React.useState(`${row.name}执行流程`);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState("");
        const [ignored, setIgnored] = React.useState(false);
        const [installedId, setInstalledId] = React.useState(null);
        if (ignored || row.skillId) return null;
        return h(
          "section",
          {
            className: "workagent-skill-suggestion",
            "aria-label": "可复用技能建议",
          },
          h("strong", null, "本次执行生成了技能建议"),
          h(
            Button,
            {
              disabled: busy,
              onClick: async () => {
                setBusy(true);
                setError("");
                try {
                  setText(
                    await request(
                      `${apiRoot}/workspaces/${encodeURIComponent(run.definitionSnapshot.workspaceId)}/content?path=${encodeURIComponent(run.skillSuggestionPath)}`,
                    ),
                  );
                } catch (reason) {
                  setError(friendlyError(reason.message));
                } finally {
                  setBusy(false);
                }
              },
            },
            "预览技能建议",
          ),
          h(
            Button,
            { disabled: busy, onClick: () => setIgnored(true) },
            "忽略建议",
          ),
          text !== null
            ? h(
                "form",
                {
                  className: "workagent-form",
                  onSubmit: async (event) => {
                    event.preventDefault();
                    setBusy(true);
                    setError("");
                    try {
                      let skillId = installedId;
                      if (!skillId) {
                        const data = new FormData();
                        data.set("name", name);
                        data.set(
                          "description",
                          `来自定时任务 ${row.name} 的执行流程`,
                        );
                        data.set("format", "directory");
                        data.set("paths", JSON.stringify(["SKILL.md"]));
                        data.append(
                          "files",
                          new File([text], "SKILL.md", {
                            type: "text/markdown",
                          }),
                        );
                        const response = await fetch(
                          `${apiRoot}/imports/skill`,
                          {
                            method: "POST",
                            credentials: "same-origin",
                            body: data,
                          },
                        );
                        const result = await response.json();
                        if (!response.ok || result.error || !result.resourceId)
                          throw new Error(result.error || "技能导入失败");
                        skillId = result.resourceId;
                        setInstalledId(skillId);
                      }
                      await request(
                        `${endpoint}/${encodeURIComponent(row.id)}`,
                        {
                          method: "PATCH",
                          body: JSON.stringify({
                            version: row.version,
                            skillId,
                          }),
                        },
                      );
                      saved();
                    } catch (reason) {
                      setError(friendlyError(reason.message));
                    } finally {
                      setBusy(false);
                    }
                  },
                },
                h(
                  "label",
                  null,
                  "建议技能名称",
                  h(Input, {
                    "aria-label": "建议技能名称",
                    value: name,
                    onChange: (event) => setName(event.target.value),
                    required: true,
                    maxLength: 120,
                  }),
                ),
                h(
                  "label",
                  null,
                  "建议技能内容",
                  h("textarea", {
                    "aria-label": "建议技能内容",
                    value: text,
                    onChange: (event) => setText(event.target.value),
                    rows: 16,
                    maxLength: 128 * 1024,
                  }),
                ),
                h(
                  "p",
                  null,
                  installedId
                    ? "技能已保存；若任务版本冲突，请刷新任务后重新绑定。"
                    : "请检查适用范围和执行步骤。保存后，下次运行会使用此技能。",
                ),
                h(
                  Button,
                  { type: "submit", disabled: busy },
                  "保存技能并绑定任务",
                ),
              )
            : null,
          error ? h("p", { role: "alert" }, error) : null,
        );
      }
      function Editor({
        row,
        presets,
        skills,
        workspaces,
        sessions,
        saved,
        cancel,
      }) {
        const [kind, setKind] = React.useState(
          row?.schedule.kind || "interval",
        );
        const [mode, setMode] = React.useState(
          row?.executionMode || "new_conversation",
        );
        const [presetId, setPresetId] = React.useState(row?.presetId || "");
        const [workspaceId, setWorkspaceId] = React.useState(
          row?.workspaceId || "",
        );
        const [error, setError] = React.useState("");
        const [busy, setBusy] = React.useState(false);
        const engine = presets.find((p) => p.id === presetId)?.engine;
        async function submit(event) {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const [hour, minute] = String(form.get("time") || "09:00")
            .split(":")
            .map(Number);
          const timezone = String(form.get("timezone") || "UTC");
          const schedule =
            kind === "interval"
              ? { kind, everyMinutes: Number(form.get("minutes")) }
              : kind === "weekly"
                ? {
                    kind,
                    daysOfWeek: form.getAll("days").map(Number),
                    hour,
                    minute,
                    timezone,
                  }
                : {
                    kind,
                    expression: String(form.get("expression")).trim(),
                    timezone,
                  };
          if (kind === "weekly" && !schedule.daysOfWeek.length)
            return setError("请选择至少一个执行日");
          setBusy(true);
          setError("");
          try {
            await request(
              row ? `${endpoint}/${encodeURIComponent(row.id)}` : endpoint,
              {
                method: row ? "PATCH" : "POST",
                body: JSON.stringify({
                  ...(row ? { version: row.version } : {}),
                  name: String(form.get("name")).trim(),
                  enabled: form.get("enabled") === "on",
                  schedule,
                  presetId,
                  engine,
                  workspaceId,
                  input: String(form.get("input")),
                  notificationPolicy: String(form.get("notificationPolicy")),
                  skillId: String(form.get("skillId") || "") || null,
                  executionMode: mode,
                  conversationId:
                    mode === "existing"
                      ? String(form.get("conversationId"))
                      : null,
                }),
              },
            );
            saved();
          } catch (reason) {
            setError(friendlyError(reason.message));
          } finally {
            setBusy(false);
          }
        }
        const field = (label, child) => h(Field, { label }, child);
        return h(
          "form",
          {
            className: "workagent-form workagent-automation-form",
            onSubmit: submit,
          },
          h(
            "h3",
            { className: "workagent-automation-wide" },
            row ? "编辑定时任务" : "新建定时任务",
          ),
          field(
            "任务名称",
            h(Input, {
              name: "name",
              required: true,
              maxLength: 200,
              defaultValue: row?.name || "",
            }),
          ),
          field(
            "执行助手",
            h(Select, {
              name: "presetId",
              required: true,
              value: presetId,
              onChange: (e) => setPresetId(e.target.value),
              options: [
                ["", "选择一个助手"],
                ...presets
                  .filter((p) => p.enabled || p.id === presetId)
                  .map((p) => [p.id, p.name]),
              ],
            }),
          ),
          field(
            "所属项目",
            h(Select, {
              name: "workspaceId",
              required: true,
              value: workspaceId,
              onChange: (e) => setWorkspaceId(e.target.value),
              options: [
                ["", "选择一个项目"],
                ...workspaces.map((w) => [w.id, w.name]),
              ],
            }),
          ),
          field(
            "绑定技能",
            h(Select, {
              name: "skillId",
              defaultValue: row?.skillId || "",
              options: [
                ["", "不绑定，执行后可生成建议"],
                ...skills
                  .filter((skill) => skill.enabled || skill.id === row?.skillId)
                  .map((skill) => [skill.id, skill.name]),
              ],
            }),
          ),
          field(
            "任务内容",
            h("textarea", {
              name: "input",
              required: true,
              rows: 4,
              maxLength: 64000,
              defaultValue: row?.input || "",
            }),
          ),
          field(
            "执行频率",
            h(Select, {
              value: kind,
              onChange: (e) => setKind(e.target.value),
              options: [
                ["interval", "固定间隔"],
                ["weekly", "每周"],
                ["cron", "Cron 表达式"],
              ],
            }),
          ),
          kind === "interval"
            ? field(
                "执行间隔（分钟）",
                h(Input, {
                  name: "minutes",
                  type: "number",
                  min: 1,
                  max: 525600,
                  required: true,
                  defaultValue: row?.schedule.everyMinutes || 60,
                }),
              )
            : h(
                React.Fragment,
                null,
                field(
                  "时区",
                  h(Input, {
                    name: "timezone",
                    required: true,
                    defaultValue:
                      row?.schedule.timezone ||
                      Intl.DateTimeFormat().resolvedOptions().timeZone ||
                      "UTC",
                  }),
                ),
                kind === "cron"
                  ? field(
                      "Cron 表达式",
                      h(Input, {
                        name: "expression",
                        required: true,
                        placeholder: "0 9 * * 1-5",
                        defaultValue: row?.schedule.expression || "",
                      }),
                    )
                  : h(
                      React.Fragment,
                      null,
                      h(
                        "fieldset",
                        null,
                        h("legend", null, "执行日"),
                        ...["日", "一", "二", "三", "四", "五", "六"].map(
                          (day, index) =>
                            h(
                              "label",
                              { key: day },
                              h("input", {
                                type: "checkbox",
                                name: "days",
                                value: index,
                                defaultChecked: (
                                  row?.schedule.daysOfWeek || [1]
                                ).includes(index),
                              }),
                              `周${day}`,
                            ),
                        ),
                      ),
                      field(
                        "执行时间",
                        h(Input, {
                          type: "time",
                          name: "time",
                          required: true,
                          defaultValue: `${String(row?.schedule.hour ?? 9).padStart(2, "0")}:${String(row?.schedule.minute ?? 0).padStart(2, "0")}`,
                        }),
                      ),
                    ),
              ),
          field(
            "执行方式",
            h(Select, {
              value: mode,
              onChange: (e) => setMode(e.target.value),
              options: [
                ["new_conversation", "每次新建对话"],
                ["existing", "继续已有对话"],
              ],
            }),
          ),
          mode === "existing"
            ? field(
                "继续的对话",
                h(Select, {
                  name: "conversationId",
                  required: true,
                  defaultValue: row?.conversationId || "",
                  options: [
                    ["", "选择同项目、同引擎的对话"],
                    ...sessions
                      .filter(
                        (s) =>
                          s.workspaceId === workspaceId &&
                          s.engine === engine &&
                          !s.parentSessionId,
                      )
                      .map((s) => [s.id, s.title || s.id]),
                  ],
                }),
              )
            : null,
          field(
            "结果通知",
            h(Select, {
              name: "notificationPolicy",
              defaultValue: row?.notificationPolicy || "always",
              options: [
                ["always", "每次通知"],
                ["on_failure", "仅失败时通知"],
                ["none", "不通知"],
              ],
            }),
          ),
          h(
            "label",
            null,
            h("input", {
              name: "enabled",
              type: "checkbox",
              defaultChecked: row?.enabled ?? true,
            }),
            "启用任务",
          ),
          error
            ? h("p", { role: "alert", className: "workagent-error" }, error)
            : null,
          h(
            "footer",
            { className: "workagent-automation-form-footer" },
            h(
              Button,
              { type: "button", onClick: cancel, disabled: busy },
              "取消",
            ),
            h(
              Button,
              {
                type: "submit",
                disabled: busy,
                className: "workagent-button workagent-automation-create",
              },
              busy ? "保存中…" : row ? "保存任务" : "创建任务",
            ),
          ),
        );
      }
      function Page() {
        const [state, refresh] = useResource(endpoint);
        const [presets] = useResource(`${apiRoot}/presets`);
        const [skills] = useResource(`${apiRoot}/skills`);
        const [workspaces] = useResource(`${apiRoot}/workspaces`);
        const [sessions] = useResource(`${apiRoot}/sessions`);
        const [editing, setEditing] = React.useState(undefined);
        const [editorRevision, setEditorRevision] = React.useState(0);
        const [history, setHistory] = React.useState({});
        const [error, setError] = React.useState("");
        const [busy, setBusy] = React.useState(false);
        async function action(path, method, body) {
          setBusy(true);
          setError("");
          try {
            await request(path, {
              method,
              ...(body ? { body: JSON.stringify(body) } : {}),
            });
            refresh();
          } catch (reason) {
            setError(friendlyError(reason.message));
          } finally {
            setBusy(false);
          }
        }
        async function loadHistory(id) {
          try {
            const rows = await request(
              `${endpoint}/${encodeURIComponent(id)}/runs`,
            );
            setHistory((current) => ({ ...current, [id]: rows }));
          } catch (reason) {
            setError(friendlyError(reason.message));
          }
        }
        return h(
          Section,
          { title: "定时任务" },
          h(
            "header",
            { className: "workagent-automation-intro" },
            h(
              "div",
              null,
              h("h3", null, "让日常工作，自动进行"),
              h("p", null, "按间隔、每周或 Cron 执行，可持续使用同一对话。"),
            ),
          ),
          editing !== null
            ? h(Editor, {
                key: editing?.id || `new-${editorRevision}`,
                row: editing,
                presets: presets.rows,
                skills: skills.rows,
                workspaces: workspaces.rows,
                sessions: sessions.rows,
                saved: () => {
                  refresh();
                  setEditing(editing ? null : undefined);
                  setEditorRevision((value) => value + 1);
                },
                cancel: () => setEditing(null),
              })
            : h(
                Button,
                {
                  className:
                    "workagent-button workagent-automation-create workagent-automation-new",
                  onClick: () => setEditing(undefined),
                },
                "新建定时任务",
              ),
          h(Status, { state }),
          error
            ? h("p", { role: "alert", className: "workagent-error" }, error)
            : null,
          ...state.rows.map((row) =>
            h(
              Card,
              {
                key: row.id,
                className: "workagent-automation-card",
                "data-enabled": row.enabled,
                title: row.name,
                detail: h(
                  React.Fragment,
                  null,
                  h(
                    "span",
                    { className: "workagent-automation-state" },
                    row.enabled ? "已启用" : "已暂停",
                  ),
                  h(
                    "span",
                    null,
                    row.nextRunAt
                      ? `下次运行 ${new Date(row.nextRunAt).toLocaleString()}`
                      : "暂无下次运行时间",
                  ),
                ),
              },
              h(
                Button,
                { disabled: busy, onClick: () => setEditing(row) },
                "编辑任务",
              ),
              h(
                Button,
                {
                  disabled: busy,
                  className: "workagent-button workagent-automation-toggle",
                  onClick: () =>
                    action(
                      `${endpoint}/${encodeURIComponent(row.id)}`,
                      "PATCH",
                      {
                        version: row.version,
                        enabled: !row.enabled,
                      },
                    ),
                },
                row.enabled ? "暂停" : "启用",
              ),
              h(
                Button,
                {
                  disabled: busy,
                  className: "workagent-button workagent-automation-run",
                  onClick: async () => {
                    await action(
                      `${endpoint}/${encodeURIComponent(row.id)}/run`,
                      "POST",
                    );
                    await loadHistory(row.id);
                  },
                },
                "立即运行",
              ),
              h(
                Button,
                {
                  className: "workagent-button workagent-automation-history",
                  onClick: () => loadHistory(row.id),
                },
                "运行记录",
              ),
              h(
                Button,
                {
                  disabled: busy,
                  className: "workagent-button workagent-automation-delete",
                  onClick: () => {
                    if (window.confirm(`删除定时任务“${row.name}”？`))
                      action(
                        `${endpoint}/${encodeURIComponent(row.id)}`,
                        "DELETE",
                      );
                  },
                },
                "删除",
              ),
              history[row.id]
                ? h(
                    "div",
                    { className: "workagent-run-history" },
                    history[row.id].length
                      ? history[row.id].map((run) =>
                          h(
                            "article",
                            { key: run.id },
                            h(
                              "strong",
                              null,
                              runLabels[run.status] || run.status,
                            ),
                            " · ",
                            new Date(run.createdAt).toLocaleString(),
                            run.sessionId
                              ? h(
                                  "a",
                                  {
                                    href: `/?frontend=dsh&session=${encodeURIComponent(run.sessionId)}`,
                                  },
                                  "打开执行对话",
                                )
                              : null,
                            run.error
                              ? h(
                                  "p",
                                  { className: "workagent-error" },
                                  friendlyError(run.error),
                                )
                              : null,
                            run.result
                              ? h(
                                  "details",
                                  null,
                                  h("summary", null, "执行结果"),
                                  h("pre", null, run.result),
                                )
                              : null,
                            run.skillSuggestionPath
                              ? h(SkillSuggestion, { row, run, saved: refresh })
                              : null,
                            ["pending", "running"].includes(run.status)
                              ? h(
                                  Button,
                                  {
                                    disabled: busy,
                                    onClick: async () => {
                                      await action(
                                        `${endpoint}/${encodeURIComponent(row.id)}/runs/${encodeURIComponent(run.id)}/cancel`,
                                        "POST",
                                      );
                                      await loadHistory(row.id);
                                    },
                                  },
                                  "取消执行",
                                )
                              : null,
                          ),
                        )
                      : h("p", null, "暂无运行记录"),
                  )
                : null,
            ),
          ),
        );
      }
      return Page;
    }

    function createImports({
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

    function createUploads({ React, request, apiRoot, friendlyError }) {
      const h = React.createElement;
      const endpoint = (id) =>
        `${apiRoot}/workspaces/${encodeURIComponent(id)}/uploads`;
      function chunk(url, blob, offset, signal, onProgress) {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PATCH", url);
          xhr.withCredentials = true;
          xhr.setRequestHeader("Upload-Offset", String(offset));
          xhr.setRequestHeader("Content-Type", "application/octet-stream");
          const abort = () => xhr.abort();
          const finish = (error, value) => {
            signal?.removeEventListener("abort", abort);
            error ? reject(error) : resolve(value);
          };
          xhr.upload.onprogress = (event) => onProgress(offset + event.loaded);
          xhr.onerror = () =>
            finish(new Error("网络中断，可重新选择同一文件继续上传"));
          xhr.onabort = () => finish(new Error("上传已暂停，可继续或取消"));
          xhr.onload = () => {
            let value;
            try {
              value = JSON.parse(xhr.responseText);
            } catch {
              finish(new Error(`HTTP ${xhr.status}`));
              return;
            }
            finish(
              xhr.status >= 200 && xhr.status < 300
                ? null
                : new Error(value.error || `HTTP ${xhr.status}`),
              value,
            );
          };
          if (signal?.aborted) {
            reject(new Error("上传已暂停"));
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
          xhr.send(blob);
        });
      }
      async function uploadFile(
        workspaceId,
        path,
        file,
        { signal, onProgress = () => {}, resumePrefix } = {},
      ) {
        if (file.size > 1024 ** 3) throw new Error("文件超过 1 GB");
        const base = endpoint(workspaceId);
        const pending = await request(base, { signal });
        let row = pending.find(
          (row) =>
            (row.path === path ||
              (resumePrefix && row.path.startsWith(resumePrefix))) &&
            row.name === file.name &&
            row.size === file.size &&
            row.lastModified === file.lastModified,
        );
        if (!row)
          row = await request(base, {
            method: "POST",
            signal,
            body: JSON.stringify({
              path,
              name: file.name,
              size: file.size,
              lastModified: file.lastModified,
            }),
          });
        onProgress(row.offset);
        while (row.offset < row.size) {
          row = await chunk(
            `${base}/${row.id}`,
            file.slice(
              row.offset,
              Math.min(row.offset + 8 * 1024 * 1024, row.size),
            ),
            row.offset,
            signal,
            onProgress,
          );
        }
        await request(`${base}/${row.id}/complete`, { method: "POST", signal });
        window.dispatchEvent(new Event("workagent:files-changed"));
        return row.path;
      }
      function Panel({ workspaceId, onChanged }) {
        const [rows, setRows] = React.useState([]);
        const [progress, setProgress] = React.useState({});
        const [error, setError] = React.useState("");
        const [active, setActive] = React.useState(null);
        const control = React.useRef(null);
        async function refresh() {
          try {
            setRows(await request(endpoint(workspaceId)));
            setError("");
          } catch (reason) {
            setError(friendlyError(reason.message));
          }
        }
        React.useEffect(() => {
          let live = true;
          request(endpoint(workspaceId))
            .then((rows) => {
              if (live) setRows(rows);
            })
            .catch(() => {});
          const changed = () => refresh();
          window.addEventListener("workagent:files-changed", changed);
          return () => {
            live = false;
            control.current?.abort();
            window.removeEventListener("workagent:files-changed", changed);
          };
        }, [workspaceId]);
        async function resume(row, file) {
          if (!file) return;
          if (
            file.name !== row.name ||
            file.size !== row.size ||
            file.lastModified !== row.lastModified
          ) {
            setError("请选择原来上传的同一个文件");
            return;
          }
          const controller = new AbortController();
          control.current = controller;
          setActive(row.id);
          setError("");
          try {
            await uploadFile(workspaceId, row.path, file, {
              signal: controller.signal,
              onProgress: (bytes) =>
                setProgress((p) => ({ ...p, [row.id]: bytes })),
            });
            onChanged?.();
          } catch (reason) {
            setError(friendlyError(reason.message));
          } finally {
            setActive(null);
            control.current = null;
            await refresh();
          }
        }
        if (!rows.length && !error) return null;
        return h(
          "details",
          { className: "workagent-upload-sessions" },
          h(
            "summary",
            null,
            h("span", null, "待继续上传"),
            h("small", null, rows.length),
          ),
          h("button", { type: "button", onClick: refresh }, "刷新上传列表"),
          h("p", null, "重新选择原文件可继续；未完成上传保留 7 天。"),
          error ? h("p", { role: "alert" }, error) : null,
          ...rows.map((row) =>
            h(
              "article",
              { key: row.id },
              h("strong", null, row.name),
              h("progress", {
                max: row.size || 1,
                value: progress[row.id] ?? row.offset,
                "aria-label": `${row.name} 上传进度`,
              }),
              h(
                "span",
                null,
                `${Math.round((100 * (progress[row.id] ?? row.offset)) / (row.size || 1))}%`,
              ),
              h(
                "label",
                null,
                "继续上传",
                h("input", {
                  type: "file",
                  className: "workagent-upload-resume-input",
                  "aria-label": `继续上传 ${row.name}`,
                  disabled: !!active,
                  onChange: (e) => {
                    void resume(row, e.target.files[0]);
                    e.target.value = "";
                  },
                }),
              ),
              active === row.id
                ? h(
                    "button",
                    { type: "button", onClick: () => control.current?.abort() },
                    "暂停上传",
                  )
                : h(
                    "button",
                    {
                      type: "button",
                      disabled: !!active,
                      onClick: async () => {
                        try {
                          await request(`${endpoint(workspaceId)}/${row.id}`, {
                            method: "DELETE",
                          });
                          await refresh();
                        } catch (reason) {
                          setError(friendlyError(reason.message));
                        }
                      },
                    },
                    "取消上传",
                  ),
            ),
          ),
        );
      }
      return { uploadFile, Panel };
    }

    function createShared({
      React,
      request,
      apiRoot,
      useResource,
      Section,
      Button,
      Input,
      Markdown,
      friendlyError,
    }) {
      const h = React.createElement;
      const Select = ({ children, ...props }) =>
        h(
          "label",
          { className: "workagent-shared-field" },
          h("span", null, props["aria-label"]),
          h("select", props, children),
        );
      const SharedInput = (props) =>
        h(
          "label",
          { className: "workagent-shared-field" },
          h("span", null, props["aria-label"]),
          h(Input, props),
        );
      const root = "/api/portal";
      const id = encodeURIComponent;
      const json = (body, method = "POST") => ({
        method,
        body: JSON.stringify(body),
      });
      function SharedFiles({ projectId }) {
        const [files, setFiles] = React.useState([]);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState("");
        const operate = async (operation, path, data) =>
          (
            await request(
              `${root}/shared-files`,
              json({ project_id: projectId, operation, path, data }),
            )
          ).data;
        const load = async () => setFiles(await operate("list"));
        React.useEffect(() => {
          const controller = new AbortController();
          request(`${root}/shared-files`, {
            ...json({ project_id: projectId, operation: "list" }),
            signal: controller.signal,
          })
            .then((value) => {
              if (!controller.signal.aborted) setFiles(value.data);
            })
            .catch((reason) => {
              if (!controller.signal.aborted)
                setError(friendlyError(reason.message));
            });
          return () => controller.abort();
        }, [projectId]);
        const perform = async (callback) => {
          setBusy(true);
          setError("");
          try {
            await callback();
          } catch (reason) {
            setError(friendlyError(reason.message));
          } finally {
            setBusy(false);
          }
        };
        return h(
          "section",
          { "aria-label": "共享资料" },
          h("h4", null, "共享资料"),
          h(
            "p",
            null,
            "上传到共享项目根目录，单个最大 6 MiB；同名文件不会被覆盖。",
          ),
          h("input", {
            type: "file",
            "aria-label": "上传共享资料",
            disabled: busy,
            onChange: (event) => {
              const file = event.target.files[0];
              event.target.value = "";
              if (!file) return;
              void perform(async () => {
                if (file.size > 6 * 1024 * 1024)
                  throw new Error("共享附件最大 6 MiB。");
                const data = await new Promise((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onerror = () => reject(new Error("文件读取失败"));
                  reader.onload = () =>
                    resolve(String(reader.result).split(",")[1]);
                  reader.readAsDataURL(file);
                });
                await operate("write-buffer", file.name, data);
                await load();
              });
            },
          }),
          h(
            Button,
            { disabled: busy, onClick: () => void perform(load) },
            "刷新共享资料",
          ),
          ...files.map((file) =>
            h(
              "div",
              { key: file.relative_path },
              file.relative_path,
              h(
                Button,
                {
                  disabled: busy,
                  onClick: () =>
                    void perform(async () => {
                      const encoded = await operate(
                        "read-buffer",
                        file.relative_path,
                      );
                      const url = URL.createObjectURL(
                        new Blob([
                          Uint8Array.from(atob(encoded), (character) =>
                            character.charCodeAt(0),
                          ),
                        ]),
                      );
                      const anchor = document.createElement("a");
                      anchor.href = url;
                      anchor.download = file.name;
                      anchor.click();
                      setTimeout(() => URL.revokeObjectURL(url), 1000);
                    }),
                },
                "下载资料",
              ),
            ),
          ),
          error ? h("p", { role: "alert" }, error) : null,
        );
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
                const value = await request(
                  `${root}/shared-messages?conversation_id=${id(conversation.id)}&after=${after}&limit=200`,
                  { signal: controller.signal },
                );
                rows.push(...value.messages);
                if (value.messages.length < 200) break;
                after = value.messages.at(-1).seq;
              }
              if (!controller.signal.aborted) {
                setMessages(rows);
                setError("");
              }
            } catch (reason) {
              if (!controller.signal.aborted)
                setError(friendlyError(reason.message));
            } finally {
              loading = false;
            }
          };
          void load();
          const events = new EventSource(`${root}/shared-events`);
          events.onmessage = () => void load();
          events.onopen = () => void load();
          const timer = setInterval(load, 15000);
          return () => {
            controller.abort();
            events.close();
            clearInterval(timer);
          };
        }, [conversation.id]);
        return h(
          "section",
          { className: "workagent-shared-chat", "aria-label": "共享对话" },
          h("h3", null, conversation.name),
          h(
            "p",
            null,
            "成员可发送消息；勾选“请助手回复”后由项目负责人的助手执行。",
          ),
          h(
            "div",
            { className: "workagent-shared-messages", "aria-live": "polite" },
            ...messages.map((message) =>
              h(
                "article",
                { key: message.id },
                h(
                  "small",
                  null,
                  `${message.author_name || (message.kind === "assistant" ? "助手" : "系统")} · ${new Date(message.created_at).toLocaleString()}`,
                ),
                h(Markdown, null, message.body),
              ),
            ),
          ),
          h(
            "form",
            {
              className: "workagent-form",
              onSubmit: async (event) => {
                event.preventDefault();
                if (busy || !body.trim()) return;
                setBusy(true);
                setError("");
                try {
                  const value = await request(
                    `${root}/shared-messages`,
                    json({
                      conversation_id: conversation.id,
                      body,
                      mentions: askAI
                        ? [{ kind: "assistant", id: conversation.assistant_id }]
                        : [],
                      attachments: [],
                    }),
                  );
                  setMessages((current) =>
                    current.some((item) => item.id === value.message.id)
                      ? current
                      : [...current, value.message],
                  );
                  setBody("");
                  if (askAI && !value.ai_started)
                    setError(
                      "消息已发送，但助手尚未开始执行，请检查运行状态后重试。",
                    );
                } catch (reason) {
                  setError(friendlyError(reason.message));
                } finally {
                  setBusy(false);
                }
              },
            },
            h(
              "label",
              null,
              "共享消息",
              h("textarea", {
                "aria-label": "共享消息",
                value: body,
                onChange: (event) => setBody(event.target.value),
                required: true,
                maxLength: 100000,
                rows: 4,
              }),
            ),
            h(
              "label",
              null,
              h("input", {
                type: "checkbox",
                checked: askAI,
                onChange: (event) => setAskAI(event.target.checked),
              }),
              "请助手回复",
            ),
            h(
              Button,
              { type: "submit", disabled: busy },
              busy ? "发送中…" : "发送消息",
            ),
            h(
              Button,
              {
                disabled: busy,
                onClick: async () => {
                  setBusy(true);
                  try {
                    await request(
                      `${root}/shared-runs/cancel`,
                      json({ conversation_id: conversation.id }),
                    );
                  } catch (reason) {
                    setError(friendlyError(reason.message));
                  } finally {
                    setBusy(false);
                  }
                },
              },
              "停止助手",
            ),
          ),
          error ? h("p", { role: "alert" }, error) : null,
        );
      }
      function SharedPage() {
        const [projects, reloadProjects] = useResource(
          `${root}/shared-projects?include_hidden=true`,
          (value) => value.projects,
        );
        const [invites, reloadInvites] = useResource(
          `${root}/shared-invites`,
          (value) => value.invites,
        );
        const [conversations, reloadConversations] = useResource(
          `${root}/shared-conversations?include_hidden=true`,
          (value) => value.conversations,
        );
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
        const conversation = conversations.rows.find(
          (item) => item.id === conversationId && item.project_id === projectId,
        );
        React.useEffect(() => {
          setMembers([]);
          setLink(null);
          if (!projectId) return;
          const controller = new AbortController();
          request(`${root}/shared-projects/${id(projectId)}/members`, {
            signal: controller.signal,
          })
            .then((value) => {
              if (!controller.signal.aborted) setMembers(value.members);
            })
            .catch((reason) => {
              if (!controller.signal.aborted)
                setError(friendlyError(reason.message));
            });
          return () => controller.abort();
        }, [projectId, revision]);
        const mutate = async (path, body, method = "POST", done) => {
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            const value = await request(
              `${root}/${path}`,
              body === undefined ? { method } : json(body, method),
            );
            await Promise.all([
              reloadProjects(),
              reloadInvites(),
              reloadConversations(),
            ]);
            setRevision((value) => value + 1);
            done?.(value);
          } catch (reason) {
            setError(friendlyError(reason.message));
          } finally {
            setBusy(false);
          }
        };
        const action = (
          label,
          path,
          body,
          method = "POST",
          confirm = false,
          done,
        ) =>
          h(
            Button,
            {
              disabled: busy,
              onClick: () => {
                if (confirm && !window.confirm(`确认${label}？`)) return;
                void mutate(path, body, method, done);
              },
            },
            label,
          );
        return h(
          Section,
          { title: "共享项目" },
          h("p", null, "与同事共享项目资料和对话。成员权限由项目负责人管理。"),
          [error, projects.error, invites.error, conversations.error]
            .filter(Boolean)
            .map((value, index) =>
              h("p", { role: "alert", key: index }, value),
            ),
          h(
            "form",
            {
              className: "workagent-form",
              onSubmit: (event) => {
                event.preventDefault();
                void mutate("shared-projects", { name }, "POST", (value) => {
                  setName("");
                  setProjectId(value.project.id);
                });
              },
            },
            h(SharedInput, {
              "aria-label": "共享项目名称",
              value: name,
              onChange: (event) => setName(event.target.value),
              required: true,
            }),
            h(Button, { type: "submit", disabled: busy }, "创建共享项目"),
          ),
          h(
            "form",
            {
              className: "workagent-form",
              onSubmit: (event) => {
                event.preventDefault();
                void mutate(
                  "shared-invite-links/accept",
                  { token },
                  "POST",
                  () => setToken(""),
                );
              },
            },
            h(SharedInput, {
              "aria-label": "邀请令牌",
              value: token,
              onChange: (event) => setToken(event.target.value),
              required: true,
            }),
            h(Button, { type: "submit", disabled: busy }, "接受链接邀请"),
          ),
          h("h3", null, "收到的邀请"),
          ...invites.rows
            .filter((item) => item.status === "pending")
            .map((item) =>
              h(
                "div",
                { key: item.id },
                `${item.inviterName} 邀请你加入 ${item.projectName} · ${new Date(item.expiresAt).toLocaleString()}`,
                action("接受", `shared-invites/${id(item.id)}/accept`, {}),
                action("拒绝", `shared-invites/${id(item.id)}/decline`, {}),
              ),
            ),
          h(
            Select,
            {
              "aria-label": "选择共享项目",
              value: projectId,
              onChange: (event) => {
                setProjectId(event.target.value);
                setConversationId("");
              },
            },
            h("option", { value: "" }, "选择共享项目"),
            ...projects.rows.map((item) =>
              h(
                "option",
                { key: item.id, value: item.id },
                `${item.name}${item.hidden ? "（已隐藏）" : ""}`,
              ),
            ),
          ),
          project
            ? h(
                "div",
                { className: "workagent-shared-project" },
                h("h3", null, project.name),
                h(
                  "p",
                  null,
                  project.currentRole === "owner"
                    ? "你是项目负责人"
                    : "你是项目成员",
                ),
                h(SharedFiles, { key: project.id, projectId: project.id }),
                action(
                  project.hidden ? "显示项目" : "隐藏项目",
                  `shared-projects/${id(project.id)}`,
                  { hidden: !project.hidden },
                  "PATCH",
                ),
                project.currentRole === "owner"
                  ? h(
                      React.Fragment,
                      null,
                      h(
                        "form",
                        {
                          key: `${project.id}-${project.name}`,
                          className: "workagent-form",
                          onSubmit: (event) => {
                            event.preventDefault();
                            const value = String(
                              new FormData(event.currentTarget).get("name") ||
                                "",
                            ).trim();
                            if (value)
                              void mutate(
                                `shared-projects/${id(project.id)}`,
                                { name: value },
                                "PATCH",
                              );
                          },
                        },
                        h(SharedInput, {
                          name: "name",
                          "aria-label": "修改共享项目名称",
                          defaultValue: project.name,
                          required: true,
                          maxLength: 120,
                        }),
                        h(
                          Button,
                          { type: "submit", disabled: busy },
                          "重命名项目",
                        ),
                      ),
                      h(
                        "form",
                        {
                          className: "workagent-form",
                          onSubmit: (event) => {
                            event.preventDefault();
                            void mutate(
                              `shared-projects/${id(project.id)}/invites`,
                              { targetUsername: target, expiresInHours: 72 },
                              "POST",
                              () => setTarget(""),
                            );
                          },
                        },
                        h(SharedInput, {
                          "aria-label": "邀请同事用户名",
                          value: target,
                          onChange: (event) => setTarget(event.target.value),
                          required: true,
                        }),
                        h(
                          Button,
                          { type: "submit", disabled: busy },
                          "邀请同事",
                        ),
                      ),
                      action(
                        "生成一次性邀请令牌",
                        `shared-projects/${id(project.id)}/invite-links`,
                        { expiresInHours: 72, singleUse: true },
                        "POST",
                        false,
                        (value) => setLink(value.link),
                      ),
                      link
                        ? h(
                            "div",
                            null,
                            h("code", null, link.token),
                            h(
                              "p",
                              null,
                              "72 小时内有效，接收人登录后在此页输入令牌。",
                            ),
                            action(
                              "撤销此邀请令牌",
                              `shared-projects/${id(project.id)}/invite-links/${id(link.token)}`,
                              undefined,
                              "DELETE",
                              true,
                              () => setLink(null),
                            ),
                          )
                        : null,
                    )
                  : action(
                      "退出项目",
                      `shared-projects/${id(project.id)}/members/me`,
                      undefined,
                      "DELETE",
                      true,
                      () => setProjectId(""),
                    ),
                h("h4", null, "项目成员"),
                ...members.map((member) =>
                  h(
                    "div",
                    { key: member.userId },
                    `${member.displayName || member.username || `成员 ${member.userId}`} · ${member.role === "owner" ? "负责人" : "成员"}`,
                    project.currentRole === "owner" && member.role !== "owner"
                      ? h(
                          React.Fragment,
                          null,
                          action(
                            "移除成员",
                            `shared-projects/${id(project.id)}/members/${member.userId}`,
                            undefined,
                            "DELETE",
                            true,
                          ),
                          action(
                            "转移所有权",
                            `shared-projects/${id(project.id)}/ownership`,
                            { targetUserId: member.userId },
                            "POST",
                            true,
                          ),
                        )
                      : null,
                  ),
                ),
                h("h4", null, "共享对话"),
                h(
                  "form",
                  {
                    className: "workagent-form",
                    onSubmit: (event) => {
                      event.preventDefault();
                      const preset = presets.rows.find(
                        (item) => item.id === presetId,
                      );
                      if (!preset || !modelId) return;
                      void mutate(
                        "shared-conversations",
                        {
                          project_id: project.id,
                          name: chatName,
                          assistant_id: preset.id,
                          assistant_backend: preset.engine,
                          model_id: modelId,
                          thinking_effort: "low",
                        },
                        "POST",
                        (value) => {
                          setConversationId(value.conversation.id);
                          setChatName("");
                        },
                      );
                    },
                  },
                  h(SharedInput, {
                    "aria-label": "共享对话名称",
                    value: chatName,
                    onChange: (event) => setChatName(event.target.value),
                    required: true,
                  }),
                  h(
                    Select,
                    {
                      "aria-label": "共享助手",
                      value: presetId,
                      onChange: (event) => {
                        setPresetId(event.target.value);
                        setModelId("");
                      },
                      required: true,
                    },
                    h("option", { value: "" }, "选择助手"),
                    ...presets.rows
                      .filter(
                        (item) =>
                          item.enabled &&
                          ["codex", "kimi"].includes(item.engine),
                      )
                      .map((item) =>
                        h(
                          "option",
                          { key: item.id, value: item.id },
                          item.name,
                        ),
                      ),
                  ),
                  h(
                    Select,
                    {
                      "aria-label": "共享模型",
                      value: modelId,
                      onChange: (event) => setModelId(event.target.value),
                      required: true,
                    },
                    h("option", { value: "" }, "选择模型"),
                    ...models.rows
                      .filter(
                        (group) =>
                          group.engine ===
                          presets.rows.find((item) => item.id === presetId)
                            ?.engine,
                      )
                      .flatMap((group) =>
                        group.models.map((item) =>
                          h(
                            "option",
                            { key: item.id, value: item.id },
                            item.name,
                          ),
                        ),
                      ),
                  ),
                  h(Button, { type: "submit", disabled: busy }, "创建共享对话"),
                ),
                ...conversations.rows
                  .filter((item) => item.project_id === project.id)
                  .map((item) =>
                    h(
                      "div",
                      { key: item.id },
                      h(
                        Button,
                        { onClick: () => setConversationId(item.id) },
                        `${item.name}${item.pinned ? " · 已置顶" : ""}${item.hidden ? " · 已隐藏" : ""}`,
                      ),
                      action(
                        item.pinned ? "取消置顶" : "置顶",
                        "shared-conversations",
                        { conversation_id: item.id, pinned: !item.pinned },
                        "PATCH",
                      ),
                      action(
                        item.hidden ? "显示对话" : "隐藏对话",
                        "shared-conversations",
                        { conversation_id: item.id, hidden: !item.hidden },
                        "PATCH",
                      ),
                    ),
                  ),
                conversation
                  ? h(SharedChat, { key: conversation.id, conversation })
                  : null,
              )
            : null,
        );
      }
      return SharedPage;
    }

    // One document owns the runtime; routes only select its visible workspace.
    function createNavigation(React, onNavigate = () => {}) {
      const subscribe = (notify) => {
        window.addEventListener("popstate", notify);
        return () => window.removeEventListener("popstate", notify);
      };
      const snapshot = () => location.search;
      const useSearch = () => React.useSyncExternalStore(subscribe, snapshot);
      function isAppURL(url) {
        return (
          url.origin === location.origin &&
          url.pathname === "/" &&
          (!url.searchParams.has("frontend") ||
            url.searchParams.get("frontend") === "dsh")
        );
      }
      function navigate(href) {
        const url = new URL(href, location.href);
        if (!isAppURL(url)) return location.assign(url.href);
        url.searchParams.set("frontend", "dsh");
        onNavigate();
        if (url.href === location.href) return;
        history.pushState(null, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
      function install() {
        const onClick = (event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          const anchor = event.target.closest?.("a[href]");
          if (
            !anchor ||
            anchor.hasAttribute("download") ||
            (anchor.target && anchor.target !== "_self")
          )
            return;
          const url = new URL(anchor.href, location.href);
          if (
            !isAppURL(url) ||
            (!url.searchParams.has("session") &&
              !url.searchParams.has("workagent") &&
              !url.searchParams.has("project"))
          )
            return;
          event.preventDefault();
          navigate(url.href);
        };
        document.addEventListener("click", onClick);
        return () => document.removeEventListener("click", onClick);
      }
      return { navigate, useSearch, install };
    }

    // Cache data, not mounted conversations or subscriptions. Bound by sessions and
    // serialized size so a handful of large transcripts cannot grow without limit.
    function createConversationCache(limit = 12, maxBytes = 16 * 1024 * 1024) {
      const sessions = new Map();
      let bytes = 0;
      function remove(id) {
        const entry = sessions.get(id);
        if (entry) bytes -= entry.bytes;
        sessions.delete(id);
      }
      function get(id, key) {
        const entry = sessions.get(id);
        if (!entry) return;
        sessions.delete(id);
        sessions.set(id, entry);
        return entry.values.get(key)?.value;
      }
      function set(id, key, value) {
        const size = JSON.stringify(value).length * 2;
        if (size > maxBytes) {
          remove(id);
          return;
        }
        const entry = sessions.get(id) || { values: new Map(), bytes: 0 };
        const change = size - (entry.values.get(key)?.bytes || 0);
        entry.bytes += change;
        bytes += change;
        entry.values.set(key, { value, bytes: size });
        sessions.delete(id);
        sessions.set(id, entry);
        while (sessions.size > limit || bytes > maxBytes)
          remove(sessions.keys().next().value);
      }
      return { get, set, remove };
    }

    const h = React.createElement;
    let layout;
    function closeMobileSidebar() {
      if (
        window.matchMedia("(max-width: 760px)").matches &&
        document.querySelector(".hHd-Xa_root:not(.hHd-Xa_collapsed)")
      )
        layout.toggleSidebar();
    }
    const navigation = createNavigation(React, closeMobileSidebar);
    const conversationCache = createConversationCache();
    const pluginScript = document.currentScript?.src;
    const apiRoot = "/api/runtime/v1";
    const maxUploadBytes = 1024 * 1024 * 1024;

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
        const error = new Error(body.error || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
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
      document.documentElement.lang = "zh-CN";
      applyFontSize(readFontSize());
      const localizeShell = () => {
        if (!globalThis.document) return;
        for (const button of document.querySelectorAll(".VOzbGW_navCell")) {
          if (button.textContent.trim() === "General")
            button.textContent = "通用设置";
          if (["Plugins", "插件"].includes(button.textContent.trim()))
            button.hidden = true;
        }
        const placeholders = {
          选择一个工作区开始: "发消息，描述你想完成的任务…",
        };
        const labels = {
          "New Session": "新建会话",
          新会话: "新建会话",
          Settings: "设置",
          "Workspace Write": "项目内读写",
          "Read Only": "只读",
          "Read only": "只读",
          "Full Access": "完全访问",
          "Full access": "完全访问",
          探索未至之境: "今天有什么安排？",
          "Into the Unknown": "今天有什么安排？",
        };
        const brandButton = globalThis.document.querySelector(
          ".hHd-Xa_brand[aria-label='新建会话']",
        );
        if (brandButton) {
          brandButton.setAttribute("aria-label", "返回首页");
          brandButton.setAttribute("title", "返回首页");
        }
        const bindHomeNavigation = (button) => {
          if (!button || button.dataset.workagentHomeNavigation) return;
          button.dataset.workagentHomeNavigation = "true";
          button.addEventListener(
            "click",
            (event) => {
              event.preventDefault();
              event.stopImmediatePropagation();
              navigation.navigate("/?frontend=dsh");
            },
            true,
          );
        };
        bindHomeNavigation(brandButton);
        bindHomeNavigation(
          globalThis.document.querySelector(".hHd-Xa_newSession"),
        );
        for (const field of globalThis.document.querySelectorAll(
          "input, textarea",
        )) {
          const replacement = placeholders[field.placeholder];
          if (replacement) field.placeholder = replacement;
        }
        for (const button of globalThis.document.querySelectorAll("button")) {
          if (
            ["Open Config", "打开配置文件"].includes(button.textContent.trim())
          )
            button.remove();
        }
        const walker = globalThis.document.createTreeWalker(
          globalThis.document.body,
          4,
        );
        let node;
        while ((node = walker.nextNode())) {
          const value = node.data.trim();
          if (labels[value])
            node.data = node.data.replace(value, labels[value]);
        }
      };
      localizeShell();
      if (!globalThis.__workagentLocalizationObserver) {
        globalThis.__workagentLocalizationObserver = new MutationObserver(
          localizeShell,
        );
        globalThis.__workagentLocalizationObserver.observe(document.body, {
          childList: true,
          subtree: true,
        });
      }
    }

    function useResource(endpoint, select = (value) => value) {
      const cachedSession = endpoint?.match(
        /^\/api\/runtime\/v1\/sessions\/([^/?]+)(?:\/(messages|queue))?$/,
      )?.[1];
      const cached = () =>
        cachedSession && conversationCache.get(cachedSession, endpoint);
      const [state, setState] = React.useState(
        () =>
          cached() || {
            loading: true,
            rows: [],
            error: "",
          },
      );
      const resourceGeneration = React.useRef(0);
      const load = React.useCallback(
        async (signal, quiet = false) => {
          if (!endpoint) return;
          const generation = ++resourceGeneration.current;
          if (!quiet && !cached())
            setState((value) => ({ ...value, loading: true, error: "" }));
          try {
            const value = await request(endpoint, { signal });
            if (signal?.aborted || generation !== resourceGeneration.current)
              return;
            const selected = select(value);
            const next = {
              loading: false,
              rows: Array.isArray(selected)
                ? selected
                : selected == null
                  ? []
                  : [selected],
              error: "",
            };
            if (cachedSession)
              conversationCache.set(cachedSession, endpoint, next);
            setState(next);
          } catch (error) {
            if (signal?.aborted || generation !== resourceGeneration.current)
              return;
            if (cachedSession && [401, 403, 404].includes(error.status))
              conversationCache.remove(cachedSession);
            if (error.name !== "AbortError")
              setState((value) => ({
                loading: false,
                rows:
                  quiet && ![401, 403, 404].includes(error.status)
                    ? value.rows
                    : [],
                error: error.message,
              }));
          }
        },
        [endpoint],
      );
      React.useEffect(() => {
        const controller = new AbortController();
        setState(cached() || { loading: true, rows: [], error: "" });
        void load(controller.signal);
        return () => {
          resourceGeneration.current += 1;
          controller.abort();
        };
      }, [load]);
      const refresh = React.useCallback(() => load(undefined, true), [load]);
      React.useEffect(() => {
        if (endpoint !== `${apiRoot}/presets`) return;
        const reload = () => void refresh();
        window.addEventListener("workagent:presets-changed", reload);
        return () =>
          window.removeEventListener("workagent:presets-changed", reload);
      }, [endpoint, refresh]);
      return [state, refresh];
    }

    function Field({ label, children }) {
      return h("label", null, label, children);
    }
    function Input(props) {
      return h("input", { ...props });
    }
    function submitComposerOnEnter(event, submit) {
      if (
        event.key !== "Enter" ||
        event.shiftKey ||
        event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === 229
      )
        return;
      event.preventDefault();
      if (submit) submit(event);
      event.currentTarget.form?.requestSubmit();
    }
    function Select({ options, heading, ...props }) {
      const choices = options.map(([value, label]) =>
        h("option", { value, key: value }, label),
      );
      return h(
        "select",
        props,
        ...(heading ? [h("optgroup", { label: heading }, choices)] : choices),
      );
    }
    function ComposerInput(props) {
      const ref = React.useRef(null);
      React.useLayoutEffect(() => {
        const input = ref.current;
        const resize = () => {
          input.style.height = "auto";
          if (input.value) input.style.height = `${input.scrollHeight}px`;
        };
        resize();
        let width = input.clientWidth;
        const observer = new ResizeObserver(() => {
          if (input.clientWidth !== width) {
            width = input.clientWidth;
            resize();
          }
        });
        observer.observe(input);
        window.addEventListener("resize", resize);
        return () => {
          observer.disconnect();
          window.removeEventListener("resize", resize);
        };
      }, [props.value]);
      return h("textarea", { ...props, ref, rows: 1 });
    }
    function ComposerForm({ children, className, ...props }) {
      const [expanded, setExpanded] = React.useState(false);
      const formRef = React.useRef(null);
      React.useLayoutEffect(() => {
        const form = formRef.current;
        const container = form.parentElement;
        const measure = () =>
          container.style.setProperty(
            "--workagent-composer-height",
            `${form.getBoundingClientRect().height}px`,
          );
        const observer = new ResizeObserver(measure);
        observer.observe(form);
        measure();
        return () => {
          observer.disconnect();
          container.style.removeProperty("--workagent-composer-height");
        };
      }, []);
      return h(
        "form",
        {
          ...props,
          ref: formRef,
          className: `${className} workagent-compact-composer`,
          "data-options-open": expanded,
        },
        children,
        h(
          "button",
          {
            type: "button",
            className: "workagent-composer-settings",
            "aria-label": "模型与权限设置",
            "aria-expanded": expanded,
            onClick: () => setExpanded(!expanded),
          },
          h(Icon, { name: "settings", size: 18 }),
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

    const valueLabels = {
      builtin: "系统内置",
      user: "用户添加",
      market: "技能市场",
      ready: "可用",
      healthy: "运行正常",
      unknown: "未知状态",
      disabled: "已停用",
      unavailable: "不可用",
      none: "无需授权",
      needs_auth: "需要授权",
      needs_review: "需要确认",
      pending: "等待中",
      queued: "排队中",
      running: "运行中",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
      independent_sessions: "独立会话",
      harness: "通用引擎",
      codex: "Codex",
      kimi: "Kimi",
      "codex-native": "Codex 原生模型",
      "harness-default": "通用默认模型",
      "kimi-native": "Kimi 原生模型",
      "team.updated": "团队已更新",
      "member.added": "已添加成员",
      "task.queued": "任务已排队",
      "task.started": "任务已开始",
      "task.completed": "任务已完成",
      "task.failed": "任务失败",
      "task.cancelled": "任务已取消",
      "mail.received": "收到团队消息",
    };
    const displayValue = (value, fallback = "") =>
      valueLabels[value] || value || fallback;
    const displayModelName = (model) =>
      valueLabels[model.id] || model.displayName || model.id;
    const displayPresetName = (name) => (name === "General" ? "DSH" : name);
    const displayWorkspaceName = (name) => {
      if (name === "Personal workspace") return "个人项目";
      const qa = /^QA wa3acc-([a-z])$/i.exec(name);
      return qa ? `测试项目 ${qa[1].toUpperCase()}` : name;
    };
    const displaySessionTitle = (title) =>
      title === "General" ? "通用会话" : title;
    const plainSessionTitle = (value) =>
      String(value).replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
    const friendlyError = (value) => {
      const message = String(value || "");
      if (/high demand|overloaded|server.*busy/i.test(message))
        return "模型服务当前繁忙，请稍后重试，或在模型设置中选择其他模型。";
      if (message.startsWith("credential_needs_auth:codex"))
        return "Codex 尚未完成登录，请先在设置中连接 Codex。";
      if (message.startsWith("credential_needs_auth:kimi"))
        return "Kimi 尚未完成登录，请先在设置中连接 Kimi。";
      const labels = {
        session_close_failed: "对话暂时无法删除，请稍后重试。",
        engine_unavailable: "所选助手当前不可用，请检查引擎设置。",
        engine_start_failed: "助手启动失败，请检查引擎状态后重试。",
        engine_turn_rejected: "助手没有接受这条消息，请稍后重试。",
        quota_exceeded: "使用额度不足，请联系管理员调整额度，或等待下一周期。",
        quota_usage_stale: "用量统计服务暂不可用，请稍后重试。",
        quota_usage_pending: "上一轮用量正在结算，请稍后重试。",
        quota_not_configured: "此模型尚未配置使用额度，请联系管理员。",
        platform_quota_unconfigured: "额度服务尚未配置，请联系管理员。",
        engine_steer_rejected:
          "追加指令未被接受；任务可能已结束，请检查状态后重新发送。",
        no_active_turn: "当前任务已结束，请直接发送消息。",
        queued_message_not_found: "这条排队消息已发送或移除，请刷新列表。",
        session_input_pending: "当前会话正在处理另一条指令，请稍候。",
        edit_stop_timeout: "原任务仍在停止中，请等它结束后重试编辑。",
        fork_message_not_found: "找不到这条消息，请刷新会话后重试。",
        session_resume_failed: "恢复会话失败，请重新开始一个会话。",
        workspace_not_found: "所选项目不存在，请重新选择。",
        invalid_session: "会话参数无效，请重新选择助手和项目。",
        content_required: "请输入要发送的内容。",
        destination_exists: "同名文件已存在，请换一个名称。",
        workspace_directory_exists:
          "工作区中已存在同名文件夹，请换一个项目名称。",
        invalid_workspace_name:
          "项目名称不能包含路径或特殊字符，也不能使用系统保留名称。",
        file_changed: "文件已被其他操作修改。请重新打开文件，确认后再编辑。",
        unsupported_text_encoding:
          "在线编辑仅支持 UTF-8 文本，请下载后使用对应编码的编辑器修改。",
        file_not_found: "文件已不存在，请刷新列表。",
        invalid_relative_path: "文件名或路径无效。",
        workspace_operation_failed: "文件操作失败，请刷新后重试。",
        request_too_large: "文件过大，单个文件不能超过 1 GB。",
        path_outside_workspace: "文件路径必须位于当前项目内。",
        reparse_point_rejected: "无法操作链接到项目外的文件。",
        im_gateway_unavailable: "消息渠道服务暂未启用。",
        market_unavailable: "市场暂时不可用，请稍后重试。",
        market_version_exists: "这个名称和版本已经发布，请填写新的版本号。",
        market_credentials_required: "请填写所需的连接凭据。",
        market_source_not_found: "所选内容已不存在，请重新选择。",
        market_builtin_dependency_unavailable:
          "当前账号缺少内置依赖，请联系管理员配置后重试。",
        market_skill_dependency_missing: "助手引用的技能不存在，请先修复绑定。",
        market_mcp_dependency_missing: "引用的 MCP 服务不存在，请先修复绑定。",
        market_mcp_url_contains_credentials:
          "服务地址含有密钥或密码，请先改为使用独立连接凭据。",
        market_mcp_command_not_portable:
          "MCP 使用了本机绝对路径，请先改成可在其他成员环境中运行的命令。",
        market_publish_own_assistant_only: "请发布自己创建的助手。",
        market_publish_own_skill_only:
          "内置技能无需重复发布，可以作为助手依赖共享。",
        market_skill_snapshot_unavailable:
          "此技能的原发布包不可用，请重新获取后再发布。",
        market_bundle_too_large: "包含的技能文件超过 50 MB，请缩小发布包。",
        invalid_market_publish:
          "请完整填写发布内容和三段式版本号，例如 1.0.0。",
      };
      if (message?.startsWith("market_runtime_"))
        return "安装或发布未完成，请检查依赖配置后重试；已经完成的安装步骤会保留。";
      if (message?.startsWith("invalid_mcp_binding:"))
        return "绑定的 MCP 尚未就绪，请先测试连接或完成授权。";
      if (message?.startsWith("invalid_skill_binding:"))
        return "绑定的技能尚未就绪，请先启用技能并检查依赖。";
      return labels[message] || message || "操作失败，请稍后重试。";
    };

    const iconPaths = {
      settings: [
        "M8 12h10m8 0h14M8 24h22m8 0h2M8 36h4m8 0h20M18 7v10m12 2v10M12 31v10",
      ],
      assistants: [
        "M15 14H33A7 7 0 0 1 40 21V33A7 7 0 0 1 33 40H15A7 7 0 0 1 8 33V21A7 7 0 0 1 15 14Z",
        "M24 14V6H29",
        "M17 23V25M31 23V25",
        "M18 32Q24 37 30 32",
        "M3 23V31M45 23V31",
      ],
      tasks: [
        "M23.9998 44.3332C34.1251 44.3332 42.3332 36.1251 42.3332 25.9999C42.3332 15.8747 34.1251 7.66656 23.9998 7.66656C13.8746 7.66656 5.6665 15.8747 5.6665 25.9999C5.6665 36.1251 13.8746 44.3332 23.9998 44.3332Z",
        "M23.76 15.35V26.36L31.53 34.13",
        "M4 9L11 4",
        "M44 9L37 4",
      ],
      chatgpt: [
        "M4 6H44V36H29L24 41L19 36H4V6Z",
        "M13 21H15",
        "M23 21H25",
        "M33 21H35",
      ],
      teams: [
        "M18 26C23.5228 26 28 21.5228 28 16C28 10.4772 23.5228 6 18 6C12.4772 6 8 10.4772 8 16C8 21.5228 12.4772 26 18 26Z",
        "M30 10C34.4183 10 38 13.5817 38 18C38 22.4183 34.4183 26 30 26",
        "M2 42C2 34.268 8.26801 28 16 28H20C27.732 28 34 34.268 34 42",
        "M32 29C39.732 29 46 35.268 46 43",
      ],
      notifications: [
        "M8 19C8 10.1634 15.1634 3 24 3C32.8366 3 40 10.1634 40 19V31L44 38H4L8 31V19Z",
        "M18 42H30",
      ],
      workspace: [
        "M4 9V41L9 21H39.5V15C39.5 13.8954 38.6046 13 37.5 13H24L19 7H6C4.89543 7 4 7.89543 4 9Z",
        "M40 41L44 21H8.8125L4 41H40Z",
      ],
      theme: [
        "M42 29.5C39.5 39 30.9 44 21.5 42C10.9 39.8 4.1 29.4 6.3 18.8C8 10.7 14.6 4.5 22.6 3C17 9.8 17.9 19.8 24.8 25.5C29.7 29.5 36.2 30.7 42 29.5Z",
      ],
      logout: [
        "M24 44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44Z",
        "M29.6567 18.3432L18.343 29.6569",
        "M18.3433 18.3432L29.657 29.6569",
      ],
      harness: [
        "M12 18H36V34H12V18Z",
        "M18 25H20",
        "M28 25H30",
        "M24 18V11",
        "M20 39H28",
      ],
      back: ["M30 10L16 24L30 38"],
      close: ["M13 13L35 35", "M35 13L13 35"],
      trash: [
        "M8 12H40M18 12V6H30V12",
        "M12 12L15 42H33L36 12",
        "M20 20V33M28 20V33",
      ],
      search: [
        "M21 8C13.8203 8 8 13.8203 8 21C8 28.1797 13.8203 34 21 34C28.1797 34 34 28.1797 34 21C34 13.8203 28.1797 8 21 8Z",
        "M31 31L41 41",
      ],
      pin: ["M17 7H31L29 20L36 28H12L19 20Z", "M24 28V42"],
      shared: ["M5 14H20L25 20H43L39 40H5Z", "M25 8H41M33 3V13"],
      plus: ["M24 10V38", "M10 24H38"],
      send: ["M12 24L24 12L36 24", "M24 13V39"],
      chevronDown: ["M14 19L24 29L34 19"],
      chevronRight: ["M19 14L29 24L19 34"],
      check: ["M9 25L19 35L39 14"],
      list: ["M8 12H10M18 12H40", "M8 24H10M18 24H40", "M8 36H10M18 36H40"],
      edit: ["M30 8L40 18L19 39L7 41L9 29Z", "M25 13L35 23"],
      copy: ["M17 17H40V41H17Z", "M30 17V7H7V30H17"],
      branch: [
        "M12 16V32M12 26C12 20 36 28 36 16",
        "M12 6A5 5 0 1 0 12 16A5 5 0 1 0 12 6",
        "M12 32A5 5 0 1 0 12 42A5 5 0 1 0 12 32",
        "M36 6A5 5 0 1 0 36 16A5 5 0 1 0 36 6",
      ],
      refresh: ["M39 17A17 17 0 1 0 40 30", "M39 6V18H27"],
      file: ["M12 5H28L38 15V43H12Z", "M28 5V15H38", "M19 25H31M19 33H29"],
      upload: ["M24 32V6M14 16L24 6L34 16", "M8 31V42H40V31"],
      download: ["M24 6V32M14 22L24 32L34 22", "M8 35V42H40V35"],
      more: ["M10 24H11M23 24H24M36 24H37"],
      send: ["M24 39V9M10 23L24 9L38 23"],
      stop: ["M13 13H35V35H13Z"],
      steer: ["M10 39V29Q10 19 24 19H38M28 9L38 19L28 29"],
      expand: ["M7 19V7H19M29 7H41V19M41 29V41H29M19 41H7V29"],
    };

    function Icon({ name, size = 18, className = "" }) {
      return h(
        "svg",
        {
          className: ["workagent-icon", className].filter(Boolean).join(" "),
          width: size,
          height: size,
          viewBox: "0 0 48 48",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 3,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
        },
        ...(iconPaths[name] || iconPaths.harness).map((d, index) =>
          h("path", { d, key: index }),
        ),
      );
    }

    function EngineMark({ engine }) {
      return h(
        "span",
        {
          className: `workagent-engine-mark is-${engine}`,
          "aria-hidden": true,
        },
        engine === "codex"
          ? h(
              "svg",
              { viewBox: "0 0 24 24", "aria-hidden": true },
              h("circle", { cx: 12, cy: 12, r: 9 }),
              h("path", { d: "M8 9l3 3-3 3M13 15h3" }),
            )
          : engine === "kimi"
            ? h(
                "svg",
                { viewBox: "0 0 24 24", "aria-hidden": true },
                h("path", { d: "M6 4v16M18 4l-8 8 8 8M11 4l7 7" }),
              )
            : h(
                "svg",
                {
                  className: "workagent-deepseek-mark",
                  viewBox: "0 0 50 50",
                  "aria-hidden": true,
                },
                // DeepSeek mark from the bundled DSH frontend favicon.
                h("path", {
                  d: "M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z",
                }),
              ),
      );
    }

    async function copyMessageText(text) {
      if (navigator.clipboard && window.isSecureContext)
        return navigator.clipboard.writeText(text);
      const field = document.createElement("textarea");
      field.value = text;
      field.style.cssText = "position:fixed;left:-9999px;top:0";
      const focused = document.activeElement;
      document.body.append(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      focused?.focus();
      if (!copied) throw new Error("复制失败，请重试");
    }
    function MessageActions({ message, disabled, onEdit, onFork }) {
      const [copyState, setCopyState] = React.useState("");
      React.useEffect(() => {
        if (!copyState) return;
        const timer = setTimeout(() => setCopyState(""), 2000);
        return () => clearTimeout(timer);
      }, [copyState]);
      const action = (name, icon, onClick, unavailable = false) =>
        h(
          Button,
          {
            className: "workagent-button workagent-message-action",
            disabled: unavailable,
            "aria-label": name,
            "data-tooltip": name,
            onClick,
          },
          h(Icon, { name: icon, size: 16 }),
        );
      return h(
        "footer",
        { className: "workagent-message-actions" },
        onEdit ? action("编辑", "edit", onEdit, disabled) : null,
        onFork ? action("分支", "branch", onFork, disabled) : null,
        action(
          copyState || "复制",
          copyState === "已复制" ? "check" : "copy",
          async () => {
            try {
              await copyMessageText(message.text);
              setCopyState("已复制");
            } catch {
              setCopyState("复制失败，请重试");
            }
          },
        ),
        h(
          "span",
          { className: "workagent-sr-only", role: "status" },
          copyState,
        ),
      );
    }
    function Status({ state }) {
      if (state.loading)
        return h("p", { className: "workagent-muted" }, "加载中…");
      if (state.error)
        return h(
          "p",
          { role: "alert", className: "workagent-error" },
          friendlyError(state.error),
        );
      if (state.rows.length === 0)
        return h("p", { className: "workagent-muted" }, "暂无数据");
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
        setError("");
        await request(path, {
          method,
          body: value === undefined ? undefined : JSON.stringify(value),
        });
        await refresh();
        if (
          path === `${apiRoot}/presets` ||
          path.startsWith(`${apiRoot}/presets/`)
        )
          window.dispatchEvent(
            new window.CustomEvent("workagent:presets-changed"),
          );
        return true;
      } catch (error) {
        setError(error.message);
        return false;
      }
    }

    function BrandMark({ size = 28 }) {
      return h(
        "span",
        {
          className: "workagent-brand-mark",
          style: {
            width: size,
            height: size,
          },
        },
        h(
          "svg",
          {
            viewBox: "0 0 32 32",
            width: size,
            height: size,
            "aria-hidden": true,
          },
          h("path", {
            d: "M7.2 7.4 10.5 23h3.2L16 13.5 18.3 23h3.2l3.3-15.6h-3.3l-1.9 10-2.2-10h-2.8l-2.2 10-1.9-10Z",
            fill: "currentColor",
          }),
        ),
      );
    }
    function BrandName() {
      return h("strong", { className: "workagent-brand-name" }, "WorkAgent");
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
        { title: "MCP 服务" },
        h(imports.MCPImport, { onImported: refresh }),
        h(
          "form",
          { className: "workagent-form", onSubmit: submit },
          h(
            Field,
            { label: "名称" },
            h(Input, { name: "name", required: true }),
          ),
          h(
            Field,
            { label: "连接方式" },
            h(Select, {
              value: transport,
              onChange: (e) => setTransport(e.target.value),
              options: [
                ["http", "HTTP"],
                ["sse", "SSE"],
                ["stdio", "命令行"],
              ],
            }),
          ),
          h(
            Field,
            { label: transport === "stdio" ? "命令" : "服务地址" },
            h(Input, {
              name: "target",
              required: true,
              type: transport === "stdio" ? "text" : "url",
            }),
          ),
          h(
            "button",
            { className: "workagent-button", type: "submit" },
            "添加服务",
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
              detail: `${displayValue(row.health, "未知状态")} · ${displayValue(row.oauthState, "无需授权")}`,
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
                  row.enabled ? "停用" : "启用",
                )
              : null,
            row.oauthState === "needs_auth"
              ? h(Button, { onClick: () => oauth(row) }, "授权")
              : null,
            h(
              Button,
              {
                onClick: () =>
                  mutate(
                    refresh,
                    setError,
                    `${endpoint}/${encodeURIComponent(row.id)}/test`,
                    "POST",
                  ),
              },
              "测试连接",
            ),
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
                  "删除",
                )
              : null,
          ),
        ),
      );
    }

    function SkillsSection() {
      const endpoint = apiRoot + "/skills";
      const [state, refresh] = useResource(endpoint);
      const [error, setError] = React.useState("");
      return h(
        Section,
        { title: "技能" },
        h(imports.SkillImport, { onImported: refresh }),
        h(
          "p",
          { className: "workagent-muted" },
          "管理已安装的技能；更多能力可在市场中获取。",
        ),
        error ? h("p", { role: "alert" }, error) : null,
        h(Status, { state }),
        ...state.rows.map((row) =>
          h(
            Card,
            {
              key: row.id,
              title: row.name,
              detail:
                displayValue(row.source) +
                " · " +
                displayValue(
                  row.health || (row.enabled ? "ready" : "disabled"),
                ),
            },
            ["user", "market"].includes(row.source)
              ? h(
                  Button,
                  {
                    onClick: () =>
                      mutate(
                        refresh,
                        setError,
                        endpoint + "/" + encodeURIComponent(row.id),
                        "PATCH",
                        { enabled: !row.enabled },
                      ),
                  },
                  row.enabled ? "停用" : "启用",
                )
              : null,
          ),
        ),
      );
    }

    const marketKinds = { skill: "技能", mcp: "MCP", assistant: "助手" };
    function MarketplaceSection() {
      const endpoint = "/api/portal/marketplace";
      const [state, refresh] = useResource(
        endpoint,
        (value) => value.entries || [],
      );
      const [legacy] = useResource(
        "/api/portal/skill-market",
        (value) => value.skills || [],
      );
      const [kind, setKind] = React.useState("all");
      const [query, setQuery] = React.useState("");
      const [publishing, setPublishing] = React.useState(false);
      const [detail, setDetail] = React.useState(null);
      const [busy, setBusy] = React.useState("");
      const [error, setError] = React.useState("");
      const [notice, setNotice] = React.useState("");
      const get = async (row, credentials) => {
        setBusy(row.id);
        setError("");
        setNotice("");
        try {
          if (!row.legacy && !credentials) {
            const info = await request(
              `${endpoint}?id=${encodeURIComponent(row.id)}`,
            );
            if (info.bundle.mcp.some((m) => m.credentialNames.length)) {
              setDetail(info);
              return;
            }
          }
          const result = await request(
            row.legacy
              ? "/api/portal/skill-market/install"
              : `${endpoint}/install`,
            {
              method: "POST",
              body: JSON.stringify({
                id: row.id,
                ...(credentials ? { credentials } : {}),
              }),
            },
          );
          setDetail(null);
          await refresh();
          setNotice(
            result?.installation?.needsSetup
              ? "已获取，所需技能和 MCP 已一并安装。请先在 MCP 服务中完成连接测试或授权，再到助手中启用。"
              : "已获取，所需技能和 MCP 已一并安装。",
          );
        } catch (cause) {
          setError(friendlyError(cause.message));
        } finally {
          setBusy("");
        }
      };
      const entries = [
        ...state.rows,
        ...legacy.rows.map((row) => ({
          ...row,
          kind: "skill",
          publisher: row.publisher?.display_name || row.publisher?.username,
          legacy: true,
          skills: [],
          mcp: [],
        })),
      ].filter(
        (row) =>
          (kind === "all" || row.kind === kind) &&
          `${row.name} ${row.description} ${row.publisher}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      );
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
            { onClick: () => setPublishing(!publishing) },
            publishing ? "收起发布" : "发布到市场",
          ),
        ),
        h(
          "nav",
          { className: "workagent-tabs", "aria-label": "市场分类" },
          ...[["all", "全部"], ...Object.entries(marketKinds)].map(
            ([value, label]) =>
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
          ? h(MarketPublishForm, {
              onPublished: async () => {
                setPublishing(false);
                await refresh();
                setNotice("已发布，其他成员现在可以获取。");
              },
            })
          : null,
        error
          ? h("p", { role: "alert", className: "workagent-error" }, error)
          : null,
        notice ? h("p", { role: "status" }, notice) : null,
        h(Status, { state }),
        ...entries.map((row) =>
          h(
            Card,
            {
              key: row.id,
              title: row.name,
              detail: `${marketKinds[row.kind]} · ${row.version} · ${row.publisher || "共享市场"}`,
            },
            h("p", null, row.description),
            row.skills?.length
              ? h(
                  "p",
                  { className: "workagent-market-dependencies" },
                  "包含技能：",
                  row.skills.join("、"),
                )
              : null,
            row.mcp?.length
              ? h(
                  "p",
                  { className: "workagent-market-dependencies" },
                  "包含 MCP：",
                  row.mcp.join("、"),
                )
              : null,
            h(
              Button,
              { disabled: !!busy, onClick: () => void get(row) },
              busy === row.id
                ? "正在获取…"
                : row.installed
                  ? "重新获取"
                  : "获取",
            ),
            row.canDelete
              ? h(
                  Button,
                  {
                    disabled: !!busy,
                    onClick: () =>
                      mutate(
                        refresh,
                        setError,
                        `${endpoint}?id=${encodeURIComponent(row.id)}`,
                        "DELETE",
                      ),
                  },
                  "下架",
                )
              : null,
          ),
        ),
        !state.loading && !entries.length
          ? h(
              "p",
              { className: "workagent-muted" },
              "暂无匹配内容，可以发布自己的技能、MCP 或助手。",
            )
          : null,
        detail
          ? h(
              "form",
              {
                className: "workagent-market-credentials",
                onSubmit: (event) => {
                  event.preventDefault();
                  const values = new FormData(event.currentTarget);
                  const credentials = {};
                  for (const m of detail.bundle.mcp) {
                    credentials[m.id] = {};
                    for (const name of m.credentialNames)
                      credentials[m.id][name] = String(
                        values.get(`${m.id}:${name}`) || "",
                      );
                  }
                  void get(detail.entry, credentials);
                },
              },
              h("h3", null, `连接 ${detail.entry.name}`),
              h("p", null, "填写你自己的连接凭据。发布者的密钥不会共享。"),
              ...detail.bundle.mcp.flatMap((m) =>
                m.credentialNames.map((name) =>
                  h(
                    Field,
                    { key: `${m.id}:${name}`, label: `${m.name} · ${name}` },
                    h(Input, {
                      type: "password",
                      autoComplete: "new-password",
                      name: `${m.id}:${name}`,
                      required: true,
                    }),
                  ),
                ),
              ),
              h(
                Button,
                { type: "submit", disabled: !!busy },
                busy ? "正在获取…" : "保存并获取",
              ),
              h(Button, { onClick: () => setDetail(null) }, "取消"),
            )
          : null,
      );
    }
    function MarketPublishForm({ onPublished }) {
      const [kind, setKind] = React.useState("skill");
      const [sourceId, setSourceId] = React.useState("");
      const [query, setQuery] = React.useState("");
      const [error, setError] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [skills] = useResource(`${apiRoot}/skills`);
      const [mcp] = useResource(`${apiRoot}/mcp-servers`);
      const [assistants] = useResource(`${apiRoot}/presets`);
      const state = { skill: skills, mcp, assistant: assistants }[kind];
      const options = state.rows.filter(
        (row) =>
          (row.source === "user" ||
            (kind === "skill" && row.source === "market")) &&
          `${row.name} ${row.id}`.toLowerCase().includes(query.toLowerCase()),
      );
      const selected = state.rows.find((row) => row.id === sourceId);
      return h(
        "form",
        {
          className: "workagent-market-publish",
          onSubmit: async (event) => {
            event.preventDefault();
            setError("");
            setBusy(true);
            const values = new FormData(event.currentTarget);
            try {
              await request("/api/portal/marketplace", {
                method: "POST",
                body: JSON.stringify({
                  kind,
                  sourceId,
                  name: String(values.get("name")),
                  description: String(values.get("description")),
                  version: String(values.get("version")),
                }),
              });
              await onPublished();
            } catch (cause) {
              setError(friendlyError(cause.message));
            } finally {
              setBusy(false);
            }
          },
        },
        h("h3", null, "发布到共享市场"),
        h(
          "p",
          null,
          "所选内容和助手绑定的技能、MCP 配置会随版本共享给其他成员。连接密钥由获取者自行填写。",
        ),
        h(
          Field,
          { label: "发布类型" },
          h(Select, {
            value: kind,
            onChange: (e) => {
              setKind(e.target.value);
              setSourceId("");
              setQuery("");
            },
            options: Object.entries(marketKinds),
          }),
        ),
        h(
          Field,
          { label: "搜索已安装内容" },
          h(Input, {
            type: "search",
            value: query,
            onChange: (e) => setQuery(e.target.value),
          }),
        ),
        h(
          Field,
          { label: "发布内容" },
          h(Select, {
            value: sourceId,
            required: true,
            onChange: (e) => setSourceId(e.target.value),
            options: [
              ["", "请选择"],
              ...options.map((row) => [row.id, row.name]),
            ],
          }),
        ),
        selected
          ? h(
              "div",
              { key: selected.id, className: "workagent-market-fields" },
              h(
                Field,
                { label: "市场名称" },
                h(Input, {
                  name: "name",
                  required: true,
                  maxLength: 240,
                  defaultValue: selected.name,
                }),
              ),
              h(
                Field,
                { label: "版本" },
                h(Input, {
                  name: "version",
                  required: true,
                  pattern: "[0-9]+\\.[0-9]+\\.[0-9]+",
                  defaultValue: "1.0.0",
                }),
              ),
              h(
                Field,
                { label: "说明" },
                h("textarea", {
                  name: "description",
                  required: true,
                  maxLength: 4096,
                  defaultValue: selected.description || "",
                }),
              ),
              kind === "assistant"
                ? h(
                    "p",
                    null,
                    `将一并打包 ${selected.skillIds?.length || 0} 个技能及其依赖、${selected.mcpServerIds?.length || 0} 个直接绑定的 MCP。`,
                  )
                : null,
            )
          : null,
        error
          ? h("p", { role: "alert", className: "workagent-error" }, error)
          : null,
        h(
          Button,
          { type: "submit", disabled: busy || !selected },
          busy ? "正在发布…" : "发布",
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
    function CapabilityPicker({ name, label, state, selected = [] }) {
      const [ids, setIds] = React.useState(selected);
      const [query, setQuery] = React.useState("");
      const visible = state.rows.filter((row) =>
        `${row.name} ${row.id}`.toLowerCase().includes(query.toLowerCase()),
      );
      return h(
        "fieldset",
        { className: "workagent-capability-picker" },
        h("legend", null, label),
        h("input", { type: "hidden", name, value: ids.join(",") }),
        h(
          "details",
          null,
          h(
            "summary",
            null,
            ids.length ? `已选择 ${ids.length} 项` : `选择${label}`,
          ),
          h("input", {
            type: "search",
            "aria-label": `搜索${label}`,
            placeholder: "按名称搜索",
            value: query,
            onChange: (e) => setQuery(e.target.value),
          }),
          state.loading
            ? h("p", null, "正在加载…")
            : state.error
              ? h("p", { role: "alert" }, state.error)
              : h(
                  "div",
                  { className: "workagent-capability-options" },
                  ...visible.map((row) =>
                    h(
                      "label",
                      { key: row.id },
                      h("input", {
                        type: "checkbox",
                        checked: ids.includes(row.id),
                        onChange: (e) =>
                          setIds(
                            e.target.checked
                              ? [...ids, row.id]
                              : ids.filter((id) => id !== row.id),
                          ),
                      }),
                      h("span", null, row.name),
                    ),
                  ),
                  !visible.length
                    ? h("p", null, "没有匹配项，可先从市场获取。")
                    : null,
                ),
        ),
        ids.length
          ? h(
              "div",
              { className: "workagent-capability-selected" },
              ...ids.map((id) =>
                h(
                  "button",
                  {
                    type: "button",
                    key: id,
                    "aria-label": `移除${state.rows.find((row) => row.id === id)?.name || id}`,
                    onClick: () => setIds(ids.filter((value) => value !== id)),
                  },
                  `${state.rows.find((row) => row.id === id)?.name || id} ×`,
                ),
              ),
            )
          : null,
      );
    }
    function PresetsSection() {
      const endpoint = `${apiRoot}/presets`;
      const [state, refresh] = useResource(endpoint);
      const [skills] = useResource(`${apiRoot}/skills`);
      const [servers] = useResource(`${apiRoot}/mcp-servers`);
      const [editing, setEditing] = React.useState(null);
      const [formVersion, setFormVersion] = React.useState(0);
      const [error, setError] = React.useState("");
      const [pendingId, setPendingId] = React.useState(null);
      const toggle = async (row) => {
        setPendingId(row.id);
        await mutate(
          refresh,
          setError,
          `${endpoint}/${encodeURIComponent(row.id)}`,
          "PATCH",
          { enabled: !row.enabled },
        );
        setPendingId(null);
      };
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
          ...(editing
            ? {
                description: editing.description,
                enabled: editing.enabled,
                workspacePolicy: editing.workspacePolicy,
                toolAllowlist: editing.toolAllowlist,
                approvalPolicy: editing.approvalPolicy,
              }
            : {}),
          name: String(values.get("name")),
          engine: String(values.get("engine")),
          modelId:
            editing?.engine === values.get("engine") ? editing.modelId : null,
          systemPrompt: String(values.get("systemPrompt") || ""),
          skillIds: csv("skillIds"),
          mcpServerIds: csv("mcpServerIds"),
        };
        const saved = await mutate(
          refresh,
          setError,
          editing ? `${endpoint}/${encodeURIComponent(editing.id)}` : endpoint,
          editing ? "PATCH" : "POST",
          body,
        );
        if (!saved) return;
        setEditing(null);
        setFormVersion((version) => version + 1);
      };
      return h(
        Section,
        { title: "助手" },
        h(
          "p",
          { className: "workagent-muted" },
          "在这里配置助手的引擎与能力；默认模型、思考强度和权限在「设置 → 模型」中调整。关闭助手后，已有对话仍可继续。",
        ),
        h(
          "form",
          {
            className: "workagent-form",
            onSubmit: submit,
            key: `preset-form-${editing?.id || "new"}-${formVersion}`,
          },
          h(
            Field,
            { label: "名称" },
            h(Input, {
              name: "name",
              required: true,
              defaultValue: editing?.name || "",
            }),
          ),
          h(
            Field,
            { label: "引擎" },
            h(Select, {
              name: "engine",
              defaultValue: editing?.engine || "harness",
              options: [
                ["harness", "通用引擎"],
                ["codex", "Codex"],
                ["kimi", "Kimi"],
              ],
            }),
          ),
          h(CapabilityPicker, {
            name: "skillIds",
            label: "技能",
            state: skills,
            selected: editing?.skillIds,
          }),
          h(CapabilityPicker, {
            name: "mcpServerIds",
            label: "MCP 服务",
            state: servers,
            selected: editing?.mcpServerIds,
          }),
          h(
            Field,
            { label: "系统提示词" },
            h("textarea", {
              name: "systemPrompt",
              defaultValue: editing?.systemPrompt || "",
            }),
          ),
          h(
            "button",
            { className: "workagent-button", type: "submit" },
            editing ? "保存助手" : "创建助手",
          ),
          editing
            ? h(Button, { onClick: () => setEditing(null) }, "取消编辑")
            : null,
        ),
        error
          ? h("p", { role: "alert", className: "workagent-error" }, error)
          : null,
        h(Status, { state }),
        ...state.rows.map((row) =>
          h(
            "article",
            {
              key: row.id,
              className: "workagent-card workagent-assistant-card",
            },
            h(
              "div",
              { className: "workagent-assistant-info" },
              h("strong", null, displayPresetName(row.name)),
              h(
                "div",
                { className: "workagent-muted" },
                displayValue(row.engine),
              ),
            ),
            h(
              Button,
              {
                role: "switch",
                "aria-label": `${displayPresetName(row.name)} 开关`,
                "aria-checked": row.enabled,
                disabled: pendingId !== null,
                className: "workagent-assistant-switch",
                title: row.enabled ? "关闭助手" : "开启助手",
                onClick: () => toggle(row),
              },
              h("span", {
                className: "workagent-switch-track",
                "aria-hidden": true,
              }),
            ),
            row.source === "user"
              ? h(
                  "div",
                  {
                    className: "workagent-actions workagent-assistant-actions",
                  },
                  h(Button, { onClick: () => setEditing(row) }, "编辑"),
                  h(
                    Button,
                    {
                      disabled: pendingId !== null,
                      onClick: async () => {
                        if (
                          !window.confirm(
                            `确定删除助手“${displayPresetName(row.name)}”？此操作无法撤销。`,
                          )
                        )
                          return;
                        setPendingId(row.id);
                        const deleted = await mutate(
                          refresh,
                          setError,
                          `${endpoint}/${encodeURIComponent(row.id)}`,
                          "DELETE",
                        );
                        setPendingId(null);
                        if (deleted && editing?.id === row.id) setEditing(null);
                      },
                    },
                    "删除",
                  ),
                )
              : null,
          ),
        ),
      );
    }

    const reasoningLabel = (option) =>
      ({
        none: "无",
        minimal: "最低",
        low: "低",
        medium: "中",
        high: "高",
        xhigh: "极高",
        max: "最高",
        ultra: "极高",
        off: "关闭",
        thinking: "开启",
        on: "开启",
      })[option.id] ||
      option.name ||
      option.id;

    const MODEL_DEFAULTS_KEY = "workagent.model-defaults.v1";
    const MODEL_DEFAULTS_EVENT = "workagent:model-defaults";
    const permissionOptions = [
      ["read_only", "只读"],
      ["workspace_write", "项目内读写"],
      ["full_access", "完全访问"],
    ];
    const readModelDefaults = () => localStorage.getItem(MODEL_DEFAULTS_KEY);
    const subscribeModelDefaults = (listener) => {
      const onStorage = (event) => {
        if (event.key === MODEL_DEFAULTS_KEY || event.key === null) listener();
      };
      window.addEventListener("storage", onStorage);
      window.addEventListener(MODEL_DEFAULTS_EVENT, listener);
      return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(MODEL_DEFAULTS_EVENT, listener);
      };
    };
    function parseModelDefaults(raw) {
      try {
        const value = JSON.parse(raw);
        if (value && typeof value === "object" && !Array.isArray(value))
          return value;
      } catch {
        /* A damaged browser preference falls back to the product defaults. */
      }
      return {};
    }
    function useModelDefaults() {
      const raw = React.useSyncExternalStore(
        subscribeModelDefaults,
        readModelDefaults,
      );
      return [
        parseModelDefaults(raw),
        (key, value) => {
          const saved = parseModelDefaults(readModelDefaults());
          localStorage.setItem(
            MODEL_DEFAULTS_KEY,
            JSON.stringify({
              ...saved,
              [key]: { ...saved[key], ...value },
            }),
          );
          window.dispatchEvent(new window.Event(MODEL_DEFAULTS_EVENT));
        },
        raw,
      ];
    }
    function defaultEffort(engine, model) {
      const options = model?.reasoning || [];
      if (engine === "codex" && options.some((option) => option.id === "low"))
        return "low";
      if (engine === "kimi") {
        const lowest = [
          "off",
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
          "ultra",
        ].find((id) => options.some((option) => option.id === id));
        return lowest || options[0]?.id || "";
      }
      return (
        options.find((option) => option.id === model?.defaultReasoning)?.id ||
        options[0]?.id ||
        ""
      );
    }
    const modelDefaultsKey = (group, preset) =>
      preset?.source === "user"
        ? `assistant:${preset.id}:${preset.engine}`
        : group?.engine;
    function resolveModelDefaults(group, preferences, preset) {
      const models = group?.models || [];
      const saved = preferences[modelDefaultsKey(group, preset)];
      const preferred =
        group?.engine === "codex"
          ? ["gpt-6-astra"]
          : group?.engine === "kimi"
            ? ["kimi-code/kimi-k3", "kimi-k3", "k3"]
            : [];
      const model =
        models.find((model) => model.id === saved?.modelId) ||
        models.find((model) => model.id === preset?.modelId) ||
        models.find((model) => preferred.includes(model.id)) ||
        models.find((model) => model.isDefault) ||
        models[0];
      return {
        modelId: model?.id || "",
        thinkingEffort:
          model?.id === saved?.modelId &&
          model?.reasoning.some((option) => option.id === saved.thinkingEffort)
            ? saved.thinkingEffort
            : defaultEffort(group?.engine, model),
        permissionMode: permissionOptions.some(
          ([id]) => id === saved?.permissionMode,
        )
          ? saved.permissionMode
          : "workspace_write",
      };
    }

    function ModelDefaultsFields({ group, preset, defaults, save }) {
      const model = group.models.find((model) => model.id === defaults.modelId);
      const name = preset
        ? displayPresetName(preset.name)
        : displayValue(group.engine);
      const key = modelDefaultsKey(group, preset);
      const field = (label, props) =>
        h(
          "label",
          null,
          h("span", null, label),
          h(Select, { "aria-label": `${name} ${label}`, ...props }),
        );
      return h(
        "div",
        { className: "workagent-model-defaults" },
        field("默认模型", {
          value: defaults.modelId,
          disabled: !group.models.length,
          options: group.models.length
            ? group.models.map((model) => [model.id, model.name])
            : [["", "暂无可用模型"]],
          onChange: (event) => {
            const next = group.models.find(
              (model) => model.id === event.target.value,
            );
            save(key, {
              modelId: next.id,
              thinkingEffort: defaultEffort(group.engine, next),
            });
          },
        }),
        field("默认思考强度", {
          value: defaults.thinkingEffort,
          disabled: !model?.reasoning.length,
          options: model?.reasoning.length
            ? model.reasoning.map((option) => [
                option.id,
                reasoningLabel(option),
              ])
            : [["", "未提供思考选项"]],
          onChange: (event) =>
            save(key, {
              modelId: defaults.modelId,
              thinkingEffort: event.target.value,
            }),
        }),
        field("默认权限", {
          value: defaults.permissionMode,
          options: permissionOptions,
          onChange: (event) =>
            save(key, {
              permissionMode: event.target.value,
            }),
        }),
      );
    }

    const FONT_SIZE_KEY = "workagent.font-size";
    const fontSizes = [
      ["13", "紧凑"],
      ["14", "标准"],
      ["16", "大号"],
      ["18", "特大"],
    ];
    function readFontSize() {
      const value = localStorage.getItem(FONT_SIZE_KEY);
      return fontSizes.some(([size]) => size === value) ? value : "13";
    }
    function applyFontSize(value) {
      document.documentElement.style.setProperty(
        "--workagent-font-scale",
        String(Number(value) / 14),
      );
    }
    function TypographySettings() {
      const [size, setSize] = React.useState(readFontSize);
      return h(
        "section",
        { className: "workagent-typography", "aria-label": "字体" },
        h(
          "div",
          null,
          h("strong", null, "字体大小"),
          h("p", null, "调整界面和对话文字，自动保存。"),
        ),
        h(Select, {
          "aria-label": "字体大小",
          value: size,
          options: fontSizes,
          onChange: (event) => {
            const value = event.target.value;
            localStorage.setItem(FONT_SIZE_KEY, value);
            applyFontSize(value);
            setSize(value);
          },
        }),
      );
    }

    function CompletionNotificationSettings() {
      const routeSearch = navigation.useSearch();
      const endpoint = `${apiRoot}/completion-notifications`;
      const [state, refresh] = useResource(endpoint);
      const saved = state.rows[0];
      const [draft, setDraft] = React.useState(null);
      const [error, setError] = React.useState("");
      const [saving, setSaving] = React.useState(false);
      const [notice, setNotice] = React.useState("");
      React.useEffect(() => {
        if (saved)
          setDraft({
            enabled: saved.enabled,
            targetId: saved.targetId,
            attachFiles: saved.attachFiles === true,
          });
      }, [saved]);
      const update = (values) => {
        setNotice("");
        setDraft((current) => ({ ...current, ...values }));
      };
      const save = async (event) => {
        event.preventDefault();
        setSaving(true);
        setError("");
        try {
          await request(endpoint, {
            method: "PUT",
            body: JSON.stringify(draft),
          });
          await refresh();
          setNotice("提醒设置已保存");
        } catch (error) {
          setError(error.message);
        } finally {
          setSaving(false);
        }
      };
      const retry = async (id) => {
        setSaving(true);
        setError("");
        try {
          await request(`${endpoint}/retry`, {
            method: "POST",
            body: JSON.stringify({ id }),
          });
          await refresh();
        } catch (error) {
          setError(error.message);
        } finally {
          setSaving(false);
        }
      };
      return h(
        Section,
        { title: "消息提醒" },
        h(workbench.Notifications),
        new URLSearchParams(routeSearch).get("session")
          ? h(workbench.SessionReminder, {
              sessionId: new URLSearchParams(routeSearch).get("session"),
            })
          : null,
        h(
          "p",
          { className: "workagent-muted" },
          "开启后，网页对话和定时任务完成时，会把最终回复和产物下载链接推送到选定的 IM 聊天。渠道内的对话仍在原聊天回复，不重复提醒。",
        ),
        h(Status, { state }),
        draft &&
          h(
            "form",
            {
              className: "workagent-form workagent-completion-form",
              onSubmit: save,
            },
            h(
              "label",
              { className: "workagent-inline" },
              h("input", {
                type: "checkbox",
                role: "switch",
                "aria-label": "任务完成提醒",
                checked: draft.enabled,
                onChange: (event) => update({ enabled: event.target.checked }),
              }),
              "任务完成提醒",
            ),
            h(
              "label",
              null,
              h("input", {
                type: "checkbox",
                checked: draft.attachFiles,
                onChange: (event) =>
                  update({ attachFiles: event.target.checked }),
              }),
              "同时发送产物文件（支持文件的渠道，单个不超过 50 MiB）",
            ),
            h(
              Field,
              { label: "接收聊天" },
              h(
                "select",
                {
                  "aria-label": "接收聊天",
                  value: draft.targetId,
                  onChange: (event) => update({ targetId: event.target.value }),
                },
                h("option", { value: "" }, "请选择接收聊天"),
                ...(saved?.targets || []).map((target) =>
                  h(
                    "option",
                    {
                      key: target.id,
                      value: target.id,
                      disabled: !target.connected,
                    },
                    `${target.label}${target.connected ? "" : "（未连接）"}`,
                  ),
                ),
                draft.targetId &&
                  !(saved?.targets || []).some(
                    (target) => target.id === draft.targetId,
                  )
                  ? h(
                      "option",
                      { value: draft.targetId },
                      "原接收聊天已不可用，请重新选择",
                    )
                  : null,
              ),
            ),
            !(saved?.targets || []).length &&
              h(
                "p",
                { className: "workagent-muted" },
                "请先在“消息渠道”连接账号，并在接收聊天中给机器人发送一条消息，再刷新聊天列表。",
              ),
            h(Button, { type: "button", onClick: refresh }, "刷新聊天列表"),
            h(
              "p",
              { className: "workagent-muted" },
              "产物链接需要登录当前 WorkAgent 账号后下载。",
            ),
            h(
              Button,
              { type: "submit", disabled: saving },
              saving ? "保存中…" : "保存提醒设置",
            ),
            error &&
              h("p", { role: "alert", className: "workagent-error" }, error),
            notice && h("p", { role: "status" }, notice),
          ),
        h("h3", null, "最近推送"),
        h(Button, { type: "button", onClick: refresh }, "刷新推送记录"),
        !(saved?.deliveries || []).length &&
          h("p", { className: "workagent-muted" }, "暂无推送记录"),
        ...(saved?.deliveries || []).map((delivery) =>
          h(
            "div",
            { key: delivery.id, className: "workagent-card" },
            h("strong", null, delivery.title),
            h(
              "p",
              null,
              `${delivery.targetLabel} · ${{ pending: "等待发送", sending: "发送中", sent: "已发送", failed: "发送失败", cancelled: "已取消" }[delivery.status]}`,
            ),
            delivery.error &&
              h("p", { className: "workagent-error" }, delivery.error),
            delivery.status === "failed" &&
              h(
                Button,
                {
                  disabled: saving || !draft?.enabled,
                  onClick: () => retry(delivery.id),
                },
                "重试推送",
              ),
          ),
        ),
      );
    }

    function ModelsSection() {
      const [state] = useResource(`${apiRoot}/model-options`);
      const [presets] = useResource(`${apiRoot}/presets`);
      const [preferences, save] = useModelDefaults();
      const groups = [
        ...presets.rows
          .filter((preset) => preset.source === "user")
          .map((preset) => ({
            preset,
            group: state.rows.find(
              (group) => group.engine === preset.engine,
            ) || { engine: preset.engine, state: "unavailable", models: [] },
          })),
        ...state.rows.map((group) => ({ group })),
      ];
      return h(
        Section,
        { title: "模型" },
        h(
          "div",
          { className: "workagent-section-intro" },
          h(
            "p",
            null,
            "为各助手设置新对话的默认模型、思考强度和权限。更改自动保存在当前浏览器；输入框的临时选择不会修改默认值。模型列表每次打开网页时自动更新。",
          ),
        ),
        h(Status, { state }),
        presets.loading || presets.error ? h(Status, { state: presets }) : null,
        ...groups.map(({ group, preset }) =>
          h(
            "section",
            {
              key: preset?.id || group.engine,
              className: "workagent-model-group",
              "data-preset-id": preset?.id,
            },
            h(
              "header",
              null,
              h(EngineMark, { engine: group.engine }),
              h(
                "strong",
                null,
                preset
                  ? displayPresetName(preset.name)
                  : displayValue(group.engine),
              ),
              preset
                ? h(
                    "span",
                    { className: "workagent-muted" },
                    `${displayValue(group.engine)}${preset.enabled ? "" : " · 已关闭"}`,
                  )
                : null,
              h(
                "span",
                { className: `workagent-status-pill is-${group.state}` },
                group.state === "ready"
                  ? `已获取 ${group.models.length} 个模型`
                  : group.state === "empty"
                    ? "暂无模型"
                    : "暂时无法获取",
              ),
            ),
            h(ModelDefaultsFields, {
              group,
              preset,
              defaults: resolveModelDefaults(group, preferences, preset),
              save,
            }),
            group.state !== "ready"
              ? h(
                  "p",
                  { className: "workagent-muted" },
                  "请检查助手的连接与授权后重新打开网页。",
                )
              : null,
            ...(preset ? [] : group.models).map((model) =>
              h(
                "article",
                { key: model.id, className: "workagent-model-row" },
                h(
                  "div",
                  null,
                  h("strong", null, model.name),
                  model.id === resolveModelDefaults(group, preferences).modelId
                    ? h("span", { className: "workagent-default-tag" }, "默认")
                    : null,
                  h("small", null, model.id),
                ),
                h(
                  "div",
                  { className: "workagent-reasoning-tags" },
                  ...(model.reasoning.length
                    ? model.reasoning.map((option) =>
                        h("span", { key: option.id }, reasoningLabel(option)),
                      )
                    : [h("span", { key: "none" }, "未提供思考选项")]),
                ),
              ),
            ),
          ),
        ),
      );
    }

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
          if (row.deep_link) navigation.navigate(row.deep_link);
        } catch (reason) {
          setError(reason.message);
        }
      };
      return h(
        Section,
        { title: "通知" },
        h("p", { className: "workagent-muted" }, `未读 ${unread} 条`),
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
              row.deep_link ? "打开并标记已读" : "标记已读",
            ),
          ),
        ),
      );
    }

    const AutomationsPage = createAutomations({
      React,
      request,
      apiRoot,
      useResource,
      Section,
      Field,
      Input,
      Select,
      Button,
      Card,
      Status,
      friendlyError,
    });

    function TeamsPage() {
      const endpoint = `${apiRoot}/teams`;
      const [state, refresh] = useResource(endpoint);
      const [presets] = useResource(`${apiRoot}/presets`);
      const [workspaces] = useResource(`${apiRoot}/workspaces`);
      const [sessions] = useResource(`${apiRoot}/sessions`);
      const [details, setDetails] = React.useState({});
      const [selectedTeam, setSelectedTeam] = React.useState(null);
      const [teamAction, setTeamAction] = React.useState(null);
      const [teamActionValue, setTeamActionValue] = React.useState("");
      const [memberEngine, setMemberEngine] = React.useState("codex");
      const [memberPresetId, setMemberPresetId] = React.useState("");
      const [targetMemberId, setTargetMemberId] = React.useState("");
      const [error, setError] = React.useState("");
      React.useEffect(() => {
        if (!selectedTeam || typeof EventSource === "undefined") return;
        const source = new EventSource(
          `${endpoint}/${encodeURIComponent(selectedTeam.id)}/events`,
          { withCredentials: true },
        );
        const receive = (event) => {
          refresh();
          void loadDetails(selectedTeam);
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
          "member.renamed",
          "member.removed",
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
            engine: presets.rows.find(
              (row) => row.id === values.get("presetId"),
            )?.engine,
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
        setTargetMemberId(team.members[0].id);
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
              memberId: targetMemberId,
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
        const saved = await mutate(
          action.refresh,
          setError,
          `${endpoint}/${encodeURIComponent(team.id)}/${action.suffix}`,
          "POST",
          action.body,
        );
        if (saved) setTeamAction(null);
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
        { title: "团队" },
        h(
          "form",
          { className: "workagent-form", onSubmit: submit },
          ...[
            ["name", "团队名称"],
            ["lead", "负责人名称"],
          ].map(([name, label]) =>
            h(Field, { label, key: name }, h(Input, { name, required: true })),
          ),
          h(
            Field,
            { label: "团队项目" },
            h(Select, {
              name: "workspaceId",
              required: true,
              defaultValue: "",
              options: [
                ["", "选择项目"],
                ...workspaces.rows.map((row) => [row.id, row.name]),
              ],
            }),
          ),
          h(
            Field,
            { label: "负责人助手" },
            h(Select, {
              name: "presetId",
              required: true,
              defaultValue: "",
              options: [
                ["", "选择助手"],
                ...presets.rows
                  .filter((row) => row.enabled)
                  .map((row) => [row.id, row.name]),
              ],
            }),
          ),
          h(
            "button",
            { type: "submit", className: "workagent-button" },
            "创建团队",
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
              detail: `${team.members.length} 位成员 · ${displayValue(team.sessionMode, "独立会话")}`,
            },
            h(
              "div",
              { className: "workagent-team-members" },
              ...team.members.map((member, memberIndex) => {
                const session = sessions.rows.find(
                  (row) => row.id === member.sessionId,
                );
                return h(
                  "article",
                  { key: member.id },
                  h("strong", null, member.name),
                  " · ",
                  member.role === "lead" ? "负责人" : "成员",
                  " · ",
                  displayValue(session?.activity?.state || member.status),
                  member.sessionId
                    ? h(
                        "a",
                        {
                          href: `/?frontend=dsh&session=${encodeURIComponent(member.sessionId)}`,
                        },
                        "打开成员对话",
                      )
                    : null,
                  h(
                    "form",
                    {
                      key: member.name,
                      className: "workagent-form",
                      onSubmit: (event) => {
                        event.preventDefault();
                        const name = String(
                          new FormData(event.currentTarget).get("name") || "",
                        ).trim();
                        if (name)
                          mutate(
                            refresh,
                            setError,
                            `${endpoint}/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.id)}`,
                            "PATCH",
                            { name: name.trim() },
                          );
                      },
                    },
                    h(
                      Field,
                      { label: "成员名称" },
                      h(Input, {
                        name: "name",
                        defaultValue: member.name,
                        required: true,
                        maxLength: 120,
                      }),
                    ),
                    h(Button, { type: "submit" }, "重命名成员"),
                  ),
                  member.role !== "lead"
                    ? h(
                        Button,
                        {
                          disabled: member.status === "running",
                          onClick: () => {
                            if (window.confirm(`移除成员“${member.name}”？`))
                              mutate(
                                refresh,
                                setError,
                                `${endpoint}/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.id)}`,
                                "DELETE",
                              );
                          },
                        },
                        "移除成员",
                      )
                    : null,
                  memberIndex > 1
                    ? h(
                        Button,
                        {
                          onClick: () => {
                            const memberIds = team.members.map((row) => row.id);
                            [
                              memberIds[memberIndex - 1],
                              memberIds[memberIndex],
                            ] = [
                              memberIds[memberIndex],
                              memberIds[memberIndex - 1],
                            ];
                            mutate(
                              refresh,
                              setError,
                              `${endpoint}/${encodeURIComponent(team.id)}`,
                              "PATCH",
                              { version: team.version, memberIds },
                            );
                          },
                        },
                        "上移成员",
                      )
                    : null,
                );
              }),
            ),
            h(
              Button,
              { onClick: () => beginTeamAction("member", team) },
              "添加成员",
            ),
            h(
              Button,
              { onClick: () => beginTeamAction("task", team) },
              "分派任务",
            ),
            h(Button, { onClick: () => loadDetails(team) }, "消息与动态"),
            h(
              Button,
              { onClick: () => beginTeamAction("mail", team) },
              "发送团队消息",
            ),
            details[team.id]
              ? h(
                  "div",
                  { className: "workagent-stack" },
                  h(
                    "span",
                    null,
                    `${details[team.id].tasks.length} 个任务 · ${details[team.id].messages.length} 条消息 · ${details[team.id].events.length} 条动态`,
                  ),
                  ...details[team.id].tasks.map((taskEntry) =>
                    h(
                      "article",
                      { key: taskEntry.id },
                      h(
                        "strong",
                        null,
                        `${taskEntry.title} · ${displayValue(taskEntry.status)}`,
                      ),
                      h(
                        "p",
                        null,
                        `执行成员：${team.members.find((member) => member.id === taskEntry.memberId)?.name || "已移除成员"}`,
                      ),
                      taskEntry.result
                        ? h(Markdown, null, taskEntry.result)
                        : null,
                      taskEntry.error
                        ? h(
                            "p",
                            { role: "alert" },
                            friendlyError(taskEntry.error),
                          )
                        : null,
                      taskEntry.sessionId
                        ? h(
                            "a",
                            {
                              href: `/?frontend=dsh&session=${encodeURIComponent(taskEntry.sessionId)}`,
                            },
                            "查看执行对话",
                          )
                        : null,
                      h(
                        Button,
                        {
                          key: `task-${taskEntry.id}`,
                          disabled: !["queued", "running"].includes(
                            taskEntry.status,
                          ),
                          onClick: () => cancelTask(team, taskEntry),
                        },
                        "取消任务",
                      ),
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
                      displayValue(event.type),
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
                    member: "成员名称",
                    task: "任务标题",
                    mail: "发送给团队的消息",
                  }[teamAction.kind],
                },
                h(Input, {
                  "aria-label": "团队操作内容",
                  value: teamActionValue,
                  onChange: (event) => setTeamActionValue(event.target.value),
                  required: true,
                }),
              ),
              h(Button, { type: "submit" }, "确认"),
              h(Button, { onClick: () => setTeamAction(null) }, "取消"),
              teamAction.kind === "task"
                ? h(
                    Field,
                    { label: "执行成员" },
                    h(Select, {
                      value: targetMemberId,
                      onChange: (event) =>
                        setTargetMemberId(event.target.value),
                      options: teamAction.team.members.map((member) => [
                        member.id,
                        member.name,
                      ]),
                    }),
                  )
                : null,
              teamAction.kind === "member"
                ? h(
                    React.Fragment,
                    null,
                    h(
                      Field,
                      { label: "成员引擎" },
                      h(Select, {
                        "aria-label": "成员引擎",
                        value: memberEngine,
                        onChange: (event) => {
                          setMemberEngine(event.target.value);
                          setMemberPresetId("");
                        },
                        options: [
                          ["harness", "通用引擎"],
                          ["codex", "Codex"],
                          ["kimi", "Kimi"],
                        ],
                      }),
                    ),
                    h(
                      Field,
                      { label: "成员助手" },
                      h(Select, {
                        "aria-label": "成员助手",
                        value: memberPresetId,
                        onChange: (event) =>
                          setMemberPresetId(event.target.value),
                        required: true,
                        options: [
                          ["", "选择助手"],
                          ...presets.rows
                            .filter(
                              (row) =>
                                row.enabled && row.engine === memberEngine,
                            )
                            .map((row) => [row.id, row.name]),
                        ],
                      }),
                    ),
                  )
                : null,
            )
          : null,
      );
    }

    const FILE_PROJECT_EVENT = "workagent:files-project";
    const FILES_CHANGED_EVENT = "workagent:files-changed";
    const fileParent = (path) => path.split("/").slice(0, -1).join("/");
    const fileURL = (workspaceId, path, preview = false) =>
      `${apiRoot}/workspaces/${encodeURIComponent(workspaceId)}/content?path=${encodeURIComponent(path)}${preview ? "&preview=1" : ""}`;
    const uploads = createUploads({ React, request, apiRoot, friendlyError });
    const workbench = createWorkbench({
      navigate: navigation.navigate,
      reasoningLabel,
      Icon,
      uploadFile: uploads.uploadFile,
      friendlyError,
      React,
      primitives,
      request,
      apiRoot,
      fileURL,
      nativeSessionAction,
    });
    const Markdown = workbench.Markdown;
    const fileSize = (size) =>
      size < 1024
        ? `${size} B`
        : size < 1024 * 1024
          ? `${(size / 1024).toFixed(1)} KB`
          : `${(size / 1024 / 1024).toFixed(1)} MB`;
    function FileIconButton({ name, label, ...props }) {
      return h(
        "button",
        {
          type: "button",
          className: "workagent-file-icon-button",
          title: label,
          "aria-label": label,
          ...props,
        },
        h(Icon, { name, size: 17 }),
      );
    }

    function ResizeHandle({
      orientation,
      value,
      onChange,
      measure,
      label,
      min,
      max,
      className = "workagent-file-resizer",
    }) {
      const start = React.useRef(null);
      const vertical = orientation === "vertical";
      const finish = () => {
        start.current = null;
        document.body.classList.remove("workagent-resizing");
      };
      React.useEffect(
        () => () => {
          if (start.current) finish();
        },
        [],
      );
      const releasePointer = (event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      };
      return h("div", {
        className: `${className} ${vertical ? "is-vertical" : "is-horizontal"}`,
        role: "separator",
        tabIndex: 0,
        "aria-orientation": orientation,
        "aria-label": label || (vertical ? "调整文件栏宽度" : "调整预览区高度"),
        "aria-valuenow": Math.round(value),
        "aria-valuemin": min,
        "aria-valuemax": max,
        onPointerDown: (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          start.current = measure(event);
          event.currentTarget.setPointerCapture(event.pointerId);
          document.body.classList.add("workagent-resizing");
        },
        onPointerMove: (event) => {
          if (start.current) onChange(start.current(event));
        },
        onLostPointerCapture: finish,
        onPointerUp: releasePointer,
        onPointerCancel: releasePointer,
        onKeyDown: (event) => {
          const direction = {
            ArrowLeft: 1,
            ArrowRight: -1,
            ArrowUp: -1,
            ArrowDown: 1,
          }[event.key];
          if (
            direction &&
            (vertical
              ? event.key === "ArrowLeft" || event.key === "ArrowRight"
              : event.key === "ArrowUp" || event.key === "ArrowDown")
          ) {
            event.preventDefault();
            onChange(value + direction * (vertical ? 24 : 5));
          }
        },
      });
    }

    let documentPreviewTemplate;
    function loadDocumentPreview() {
      if (!documentPreviewTemplate) {
        const root = "/plugins/@workagent/dsh-client/";
        documentPreviewTemplate = Promise.all([
          request(`${root}document-preview.html`),
          request(`${root}jszip.js`),
          request(`${root}docx-preview.js`),
        ])
          .then(([html, zip, docx]) =>
            html
              .replace("__JSZIP_SOURCE__", () =>
                zip.replace(/<\/script/gi, "<\\/script"),
              )
              .replace("__DOCX_SOURCE__", () =>
                docx.replace(/<\/script/gi, "<\\/script"),
              ),
          )
          .catch((error) => {
            documentPreviewTemplate = null;
            throw error;
          });
      }
      return documentPreviewTemplate;
    }

    function WorkspaceFilePreview({
      workspace,
      entry,
      revision,
      onClose,
      onDismiss,
      onDirty,
      active,
    }) {
      const [state, setState] = React.useState({ loading: true });
      const [source, setSource] = React.useState(false);
      const [editingFile, setEditingFile] = React.useState(false);
      const [maximized, setMaximized] = React.useState(false);
      const locatedLine = React.useRef(null);
      React.useEffect(() => {
        if (active) locatedLine.current?.scrollIntoView?.({ block: "center" });
      }, [entry.line, state.text, active]);
      React.useEffect(() => {
        if (!active) setMaximized(false);
      }, [active]);
      const reportDirty = React.useCallback(
        (value) => onDirty?.(entry.path, value),
        [onDirty, entry.path],
      );
      const extension = entry.name.toLowerCase().split(".").pop();
      React.useEffect(() => {
        if (active === false) return;
        const controller = new AbortController();
        let objectURL;
        setState({ loading: true });
        setSource(false);
        const load = async () => {
          try {
            const inline = fileURL(workspace.id, entry.path, true);
            if (extension === "pdf") {
              const response = await fetch(inline, {
                signal: controller.signal,
              });
              if (!response.ok) throw new Error("file_not_found");
              await response.body?.cancel();
              if (controller.signal.aborted) return;
              setState({
                media: "pdf",
                url: `${inline}#navpanes=0&toolbar=1`,
              });
              return;
            }
            if (extension === "docx") {
              if (entry.size > 25 * 1024 * 1024)
                throw new Error("file_too_large");
              const [response, template] = await Promise.all([
                fetch(inline, { signal: controller.signal }),
                loadDocumentPreview(),
              ]);
              if (!response.ok) throw new Error("file_not_found");
              const data = await response.arrayBuffer();
              if (!controller.signal.aborted)
                setState({
                  media: "docx",
                  data,
                  html: template,
                });
              return;
            }
            if (["xlsx", "pptx"].includes(extension)) {
              const value = await request(`${apiRoot}/office-preview/convert`, {
                method: "POST",
                signal: controller.signal,
                body: JSON.stringify({
                  workspace: workspace.directory || workspace.id,
                  path: entry.path,
                }),
              });
              const url = `${apiRoot}/office-preview/content/${encodeURIComponent(value.hash)}.pdf`;
              const response = await fetch(url, { signal: controller.signal });
              if (
                !response.ok ||
                !response.headers
                  .get("content-type")
                  ?.includes("application/pdf")
              )
                throw new Error("office_preview_not_found");
              await response.body?.cancel();
              if (!controller.signal.aborted)
                setState({
                  media: "pdf",
                  url: `${url}#view=FitH&navpanes=0&toolbar=1`,
                });
              return;
            }
            const images = {
              png: "image/png",
              jpg: "image/jpeg",
              jpeg: "image/jpeg",
              gif: "image/gif",
              webp: "image/webp",
              svg: "image/svg+xml",
              bmp: "image/bmp",
              avif: "image/avif",
              ico: "image/x-icon",
            };
            const textFile =
              [
                "txt",
                "md",
                "markdown",
                "csv",
                "tsv",
                "json",
                "yaml",
                "yml",
                "log",
                "js",
                "ts",
                "tsx",
                "jsx",
                "css",
                "scss",
                "html",
                "htm",
                "xml",
                "py",
                "go",
                "rs",
                "java",
                "c",
                "cpp",
                "h",
                "hpp",
                "ps1",
                "sh",
                "bat",
                "toml",
                "ini",
                "sql",
                "diff",
                "patch",
                "env",
              ].includes(extension) || !entry.name.includes(".");
            if (!images[extension] && !textFile) {
              setState({ media: "unsupported" });
              return;
            }
            if (entry.size > (images[extension] ? 25 : 2) * 1024 * 1024) {
              setState({ error: "文件较大，请下载后查看。" });
              return;
            }
            const response = await fetch(inline, {
              credentials: "same-origin",
              signal: controller.signal,
            });
            if (!response.ok)
              throw new Error(
                response.status === 404
                  ? "file_not_found"
                  : "workspace_operation_failed",
              );
            if (images[extension]) {
              const data = await response.arrayBuffer();
              if (controller.signal.aborted) return;
              objectURL = URL.createObjectURL(
                new Blob([data], { type: images[extension] }),
              );
              setState({ media: "image", url: objectURL });
            } else {
              const text = await response.text();
              if (!controller.signal.aborted)
                setState({
                  media: ["md", "markdown"].includes(extension)
                    ? "markdown"
                    : ["html", "htm"].includes(extension)
                      ? "html"
                      : "text",
                  text,
                });
            }
          } catch (error) {
            if (!controller.signal.aborted)
              setState({
                error: ["docx", "xlsx", "pptx"].includes(extension)
                  ? "文档转换暂不可用，可下载原文件查看。"
                  : friendlyError(error.message),
              });
          }
        };
        void load();
        return () => {
          controller.abort();
          if (objectURL) URL.revokeObjectURL(objectURL);
        };
      }, [workspace.id, entry.path, revision, active]);
      const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">${state.text || ""}`;
      return h(
        "section",
        {
          className: `workagent-file-preview-pane${maximized ? " is-maximized" : ""}`,
          "aria-label": "文件预览",
          onKeyDown: (event) => {
            if (event.key === "Escape" && maximized) {
              event.stopPropagation();
              setMaximized(false);
            }
          },
        },
        h(
          "header",
          null,
          h(FileIconButton, {
            name: "back",
            label: "返回文件列表",
            onClick: onClose,
          }),
          h("strong", { title: entry.path }, entry.name),
          state.text !== undefined && !editingFile
            ? h(
                "button",
                { type: "button", onClick: () => setEditingFile(true) },
                "编辑文件",
              )
            : null,
          ["markdown", "html"].includes(state.media)
            ? h(
                "button",
                { type: "button", onClick: () => setSource(!source) },
                source ? "预览" : "源码",
              )
            : null,
          h(FileIconButton, {
            name: "expand",
            label: maximized ? "还原文件预览" : "最大化文件预览",
            onClick: () => setMaximized(!maximized),
          }),
          h(
            "a",
            {
              href: fileURL(workspace.id, entry.path),
              download: entry.name,
              "aria-label": `下载 ${entry.name}`,
              title: "下载原文件",
            },
            h(Icon, { name: "download", size: 17 }),
          ),
          h(FileIconButton, {
            name: "close",
            label: "关闭文件侧栏",
            onClick: onDismiss,
          }),
        ),
        h(
          "div",
          { className: "workagent-file-preview-body" },
          editingFile && state.text !== undefined
            ? h(workbench.TextEditor, {
                key: entry.path,
                workspaceId: workspace.id,
                path: entry.path,
                original: state.text,
                onDirty: reportDirty,
                onCancel: () => setEditingFile(false),
                onSaved: (text) => {
                  setState((current) => ({ ...current, text }));
                  setEditingFile(false);
                },
              })
            : state.loading
              ? h("p", { role: "status" }, "正在加载预览…")
              : state.error
                ? h("p", { role: "alert" }, state.error)
                : state.media === "docx"
                  ? h("iframe", {
                      key: `${entry.path}:${revision}`,
                      title: entry.name,
                      sandbox: "allow-scripts",
                      srcDoc: state.html,
                      onLoad: (event) =>
                        event.currentTarget.contentWindow.postMessage(
                          { type: "workagent:document", data: state.data },
                          "*",
                        ),
                    })
                  : state.media === "image"
                    ? h("img", { src: state.url, alt: entry.name })
                    : state.media === "pdf"
                      ? h("iframe", { src: state.url, title: entry.name })
                      : state.media === "html" && !source && !entry.line
                        ? h("iframe", {
                            srcDoc: html,
                            sandbox: "",
                            title: entry.name,
                          })
                        : state.media === "markdown" && !source && !entry.line
                          ? h(Markdown, null, state.text)
                          : state.text !== undefined
                            ? h(
                                "pre",
                                null,
                                entry.line
                                  ? state.text.split("\n").map((line, index) =>
                                      h(
                                        "span",
                                        {
                                          key: index,
                                          ref:
                                            index + 1 === entry.line
                                              ? locatedLine
                                              : undefined,
                                          className:
                                            index + 1 === entry.line
                                              ? "workagent-located-line"
                                              : undefined,
                                          style: { display: "block" },
                                        },
                                        `${index + 1}  ${line}`,
                                      ),
                                    )
                                  : state.text,
                              )
                            : h(
                                "p",
                                null,
                                "此格式暂不支持在线预览，请下载后查看。",
                              ),
        ),
      );
    }

    function WorkspaceFileManager({ workspace, onDismiss }) {
      const root = `${apiRoot}/workspaces/${encodeURIComponent(workspace.id)}`;
      const [tree, setTree] = React.useState({});
      const [expanded, setExpanded] = React.useState(new Set([""]));
      const [directory, setDirectory] = React.useState("");
      const [selected, setSelected] = React.useState(null);
      const [tabs, setTabs] = React.useState([]);
      const [dirtyFiles, setDirtyFiles] = React.useState(new Set());
      const reportDirty = React.useCallback(
        (path, value) =>
          setDirtyFiles((current) => {
            if (current.has(path) === value) return current;
            const next = new Set(current);
            if (value) next.add(path);
            else next.delete(path);
            return next;
          }),
        [],
      );
      const closeTab = (entry) => {
        if (
          dirtyFiles.has(entry.path) &&
          !window.confirm(
            `关闭“${entry.name}”？未保存草稿会保留，重新编辑时恢复。`,
          )
        )
          return;
        setTabs((current) =>
          current.filter((item) => item.path !== entry.path),
        );
        if (selected?.path === entry.path) setSelected(null);
        reportDirty(entry.path, false);
      };
      const [menu, setMenu] = React.useState(null);
      const [action, setAction] = React.useState(null);
      const [name, setName] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [loading, setLoading] = React.useState(false);
      const [error, setError] = React.useState("");
      const [notice, setNotice] = React.useState("");
      const [revision, setRevision] = React.useState(0);
      const uploadInput = React.useRef(null);
      const uploadControl = React.useRef(null);
      const [uploadProgress, setUploadProgress] = React.useState(null);
      React.useEffect(() => {
        const openFile = (event) => {
          if (event.detail?.workspaceId !== workspace.id) return;
          const entry = event.detail.entry;
          setTabs((current) => [
            ...current.filter((item) => item.path !== entry.path),
            entry,
          ]);
          setSelected(entry);
        };
        window.addEventListener("workagent:file-open", openFile);
        return () =>
          window.removeEventListener("workagent:file-open", openFile);
      }, [workspace.id]);
      React.useEffect(() => () => uploadControl.current?.abort(), []);
      const requests = React.useRef(new Map());
      const live = React.useRef(true);
      const expandedRef = React.useRef(expanded);
      expandedRef.current = expanded;
      const loadDirectory = React.useCallback(
        async (path) => {
          requests.current.get(path)?.abort();
          const controller = new AbortController();
          requests.current.set(path, controller);
          try {
            const entries = await request(
              `${root}/files?path=${encodeURIComponent(path)}`,
              { signal: controller.signal },
            );
            if (!controller.signal.aborted)
              setTree((current) => ({ ...current, [path]: entries }));
          } catch (reason) {
            if (!controller.signal.aborted)
              setError(friendlyError(reason.message));
          } finally {
            if (requests.current.get(path) === controller)
              requests.current.delete(path);
          }
        },
        [root],
      );
      const refresh = React.useCallback(async () => {
        setLoading(true);
        await Promise.all([...expandedRef.current].map(loadDirectory));
        if (live.current) setLoading(false);
      }, [loadDirectory]);
      React.useEffect(() => {
        live.current = true;
        void refresh();
        const update = () => {
          void refresh();
          setRevision((value) => value + 1);
        };
        window.addEventListener(SESSIONS_CHANGED_EVENT, update);
        window.addEventListener(FILES_CHANGED_EVENT, update);
        window.addEventListener("focus", update);
        return () => {
          live.current = false;
          for (const controller of requests.current.values())
            controller.abort();
          window.removeEventListener(SESSIONS_CHANGED_EVENT, update);
          window.removeEventListener(FILES_CHANGED_EVENT, update);
          window.removeEventListener("focus", update);
        };
      }, [refresh]);
      const beginAction = (kind, entry) => {
        setMenu(null);
        setError("");
        setNotice("");
        setAction({ kind, entry });
        setName(
          kind === "move" ? entry.path : kind === "rename" ? entry.name : "",
        );
      };
      const mutate = async (event) => {
        event.preventDefault();
        if (busy) return;
        const value = name.trim();
        if (
          action.kind !== "delete" &&
          (!value ||
            (action.kind !== "move" && /[\\/:*?"<>|]/.test(value)) ||
            value === "." ||
            value === "..")
        ) {
          setError("请输入有效名称。");
          return;
        }
        setBusy(true);
        setError("");
        try {
          if (action.kind === "delete") {
            if (
              [...dirtyFiles].some(
                (path) =>
                  path === action.entry.path ||
                  path.startsWith(`${action.entry.path}/`),
              )
            )
              throw new Error("请先保存或关闭此文件中的未保存编辑，再删除。");
            await request(fileURL(workspace.id, action.entry.path), {
              method: "DELETE",
            });
          } else if (["rename", "move"].includes(action.kind)) {
            if (
              [...dirtyFiles].some(
                (path) =>
                  path === action.entry.path ||
                  path.startsWith(`${action.entry.path}/`),
              )
            )
              throw new Error(
                "请先保存或关闭此文件中的未保存编辑，再移动或重命名。",
              );
            const destination =
              action.kind === "move"
                ? value
                : [fileParent(action.entry.path), value]
                    .filter(Boolean)
                    .join("/");
            await request(`${root}/move`, {
              method: "POST",
              body: JSON.stringify({ source: action.entry.path, destination }),
            });
          } else {
            const path = [directory, value].filter(Boolean).join("/");
            if (action.kind === "folder")
              await request(`${root}/directories`, {
                method: "POST",
                body: JSON.stringify({ path }),
              });
            else
              await request(`${fileURL(workspace.id, path)}&overwrite=0`, {
                method: "PUT",
                body: "",
                headers: { "Content-Type": "application/octet-stream" },
              });
          }
          if (!live.current) return;
          // Renaming/moving a directory invalidates all cached descendant paths.
          const reset =
            ["rename", "move", "delete"].includes(action.kind) &&
            action.entry.kind === "directory";
          if (reset) {
            for (const controller of requests.current.values())
              controller.abort();
            setTree({});
            expandedRef.current = new Set([""]);
            setExpanded(expandedRef.current);
            setDirectory("");
          }
          if (["rename", "move", "delete"].includes(action.kind)) {
            const affected = (path) =>
              path === action.entry.path ||
              path.startsWith(`${action.entry.path}/`);
            setTabs((rows) => rows.filter((entry) => !affected(entry.path)));
            if (selected && affected(selected.path)) setSelected(null);
          }
          setAction(null);
          setNotice("已完成");
          await refresh();
        } catch (reason) {
          if (live.current) setError(friendlyError(reason.message));
        } finally {
          if (live.current) setBusy(false);
        }
      };
      const upload = async (files) => {
        if (busy || !files.length) return;
        const controller = new AbortController();
        uploadControl.current = controller;
        setBusy(true);
        setError("");
        setNotice("");
        let completed = 0;
        const failures = [];
        try {
          for (const file of files) {
            if (!live.current) break;
            if (file.size > maxUploadBytes) {
              failures.push(`${file.name}：超过 1 GB`);
              continue;
            }
            try {
              await uploads.uploadFile(
                workspace.id,
                [directory, file.name].filter(Boolean).join("/"),
                file,
                {
                  signal: controller.signal,
                  onProgress: (bytes) => {
                    if (live.current)
                      setUploadProgress({
                        name: file.name,
                        bytes,
                        size: file.size,
                      });
                  },
                },
              );
              completed += 1;
            } catch (reason) {
              failures.push(`${file.name}：${friendlyError(reason.message)}`);
              if (controller.signal.aborted) break;
            }
          }
          if (live.current) {
            setNotice(completed ? `已上传 ${completed} 个文件` : "");
            setError(failures.join("；"));
            await refresh();
          }
        } finally {
          uploadControl.current = null;
          setUploadProgress(null);
          window.dispatchEvent(new Event("workagent:files-changed"));
          if (live.current) setBusy(false);
        }
      };
      const openDirectory = (entry) => {
        setDirectory(entry.path);
        setMenu(null);
        setExpanded((current) => {
          const next = new Set(current);
          if (next.has(entry.path)) next.delete(entry.path);
          else next.add(entry.path);
          return next;
        });
        if (!tree[entry.path]) void loadDirectory(entry.path);
      };
      const renderDirectory = (path, depth = 0) =>
        h(
          "ul",
          { className: "workagent-file-tree-list", key: path },
          ...(tree[path] || []).map((entry) =>
            h(
              "li",
              { key: entry.path },
              h(
                "div",
                {
                  className: `workagent-file-tree-row${selected?.path === entry.path || directory === entry.path ? " is-selected" : ""}`,
                  style: { "--file-depth": depth },
                },
                h(
                  "button",
                  {
                    type: "button",
                    className: "workagent-file-tree-name",
                    title: entry.path,
                    "aria-expanded":
                      entry.kind === "directory"
                        ? expanded.has(entry.path)
                        : undefined,
                    onClick: () => {
                      if (entry.kind === "directory") openDirectory(entry);
                      else {
                        setTabs((current) =>
                          current.some((item) => item.path === entry.path)
                            ? current
                            : [...current, entry],
                        );
                        setSelected(entry);
                        setDirectory(fileParent(entry.path));
                        setMenu(null);
                      }
                    },
                  },
                  h(Icon, {
                    name:
                      entry.kind === "directory"
                        ? expanded.has(entry.path)
                          ? "chevronDown"
                          : "chevronRight"
                        : "file",
                    size: 16,
                  }),
                  h("span", null, entry.name),
                ),
                entry.kind === "file"
                  ? h("small", null, fileSize(entry.size))
                  : null,
                h(FileIconButton, {
                  name: "more",
                  label: `操作 ${entry.name}`,
                  "aria-expanded": menu?.path === entry.path,
                  onClick: () =>
                    setMenu(menu?.path === entry.path ? null : entry),
                }),
              ),
              menu?.path === entry.path
                ? h(
                    "div",
                    {
                      className: "workagent-file-row-menu",
                      "aria-label": `${entry.name} 的操作`,
                    },
                    entry.kind === "file"
                      ? h(
                          "a",
                          {
                            href: fileURL(workspace.id, entry.path),
                            download: entry.name,
                          },
                          "下载",
                        )
                      : null,
                    h(
                      "button",
                      {
                        type: "button",
                        onClick: () => beginAction("rename", entry),
                      },
                      "重命名",
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        onClick: () => beginAction("move", entry),
                      },
                      "移动",
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        onClick: () => beginAction("delete", entry),
                      },
                      "删除",
                    ),
                  )
                : null,
              entry.kind === "directory" && expanded.has(entry.path)
                ? tree[entry.path]
                  ? tree[entry.path].length
                    ? renderDirectory(entry.path, depth + 1)
                    : h(
                        "p",
                        { className: "workagent-file-tree-empty" },
                        "空文件夹",
                      )
                  : h(
                      "p",
                      { className: "workagent-file-tree-empty" },
                      "正在加载…",
                    )
                : null,
            ),
          ),
        );
      const actionLabel =
        action &&
        {
          file: "新建文件",
          folder: "新建文件夹",
          rename: "重命名文件",
          move: "移动文件",
          delete: "删除文件",
        }[action.kind];
      return h(
        "div",
        {
          className: `workagent-file-manager${selected ? " has-preview" : ""}`,
          onDragOver: (event) => {
            if (event.dataTransfer.types.includes("Files"))
              event.preventDefault();
          },
          onDrop: (event) => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            void upload([...event.dataTransfer.files]);
          },
        },
        h(
          "div",
          { className: "workagent-file-manager-content", hidden: !!selected },
          uploadProgress
            ? h(
                "div",
                { className: "workagent-upload-progress" },
                uploadProgress.name,
                h("progress", {
                  max: uploadProgress.size || 1,
                  value: uploadProgress.bytes,
                }),
                h(
                  Button,
                  { onClick: () => uploadControl.current?.abort() },
                  "暂停上传",
                ),
              )
            : null,
          h(
            "div",
            { className: "workagent-file-toolbar" },
            h(FileIconButton, {
              name: "upload",
              label: "上传文件",
              title: "上传文件 · 单个最大 1 GB，也可拖入文件",
              disabled: busy,
              onClick: () => uploadInput.current.click(),
            }),
            h(FileIconButton, {
              name: "file",
              label: "新建文件",
              disabled: busy,
              onClick: () => beginAction("file"),
            }),
            h(FileIconButton, {
              name: "plus",
              label: "新建文件夹",
              disabled: busy,
              onClick: () => beginAction("folder"),
            }),
            h("span", null, busy ? "正在处理…" : ""),
            h(FileIconButton, {
              name: "refresh",
              label: "刷新文件",
              disabled: loading,
              onClick: () => {
                setError("");
                void refresh();
                setRevision((value) => value + 1);
              },
            }),
            h("input", {
              ref: uploadInput,
              hidden: true,
              type: "file",
              multiple: true,
              "aria-label": "选择上传文件",
              onChange: (event) => {
                const files = [...event.target.files];
                event.target.value = "";
                void upload(files);
              },
            }),
          ),
          h(uploads.Panel, { workspaceId: workspace.id, onChanged: refresh }),
          h(
            "nav",
            {
              className: "workagent-file-breadcrumb",
              "aria-label": "当前文件目录",
            },
            h(
              "button",
              { type: "button", onClick: () => setDirectory("") },
              "根目录",
            ),
            ...directory
              .split("/")
              .filter(Boolean)
              .map((part, index, parts) =>
                h(
                  "button",
                  {
                    key: index,
                    type: "button",
                    onClick: () =>
                      setDirectory(parts.slice(0, index + 1).join("/")),
                  },
                  " / ",
                  part,
                ),
              ),
          ),
          error
            ? h(
                "p",
                { role: "alert", className: "workagent-file-notice is-error" },
                error,
              )
            : null,
          notice
            ? h(
                "p",
                { role: "status", className: "workagent-file-notice" },
                notice,
              )
            : null,
          action
            ? h(
                "form",
                {
                  className: "workagent-file-action-form",
                  onSubmit: mutate,
                  "aria-label": actionLabel,
                },
                h("strong", null, actionLabel),
                action.kind === "delete"
                  ? h(
                      "p",
                      null,
                      `确认删除“${action.entry.name}”${action.entry.kind === "directory" ? "及其内容" : ""}？`,
                    )
                  : h(Input, {
                      autoFocus: true,
                      "aria-label":
                        action.kind === "move" ? "目标相对路径" : "文件名",
                      placeholder:
                        action.kind === "move"
                          ? "例如：资料/报告.txt"
                          : "输入名称",
                      value: name,
                      onChange: (event) => setName(event.target.value),
                      required: true,
                    }),
                action.kind === "move"
                  ? h(
                      "small",
                      null,
                      "相对于项目根目录，包含文件名；可输入新的文件夹路径。",
                    )
                  : null,
                h(
                  "div",
                  null,
                  h(
                    Button,
                    { disabled: busy, onClick: () => setAction(null) },
                    "取消",
                  ),
                  h(
                    Button,
                    { type: "submit", disabled: busy },
                    busy
                      ? "处理中…"
                      : action.kind === "delete"
                        ? "确认删除"
                        : "保存",
                  ),
                ),
              )
            : null,
          h(
            "div",
            { className: "workagent-file-tree", "aria-label": "项目文件树" },
            tree[""]
              ? tree[""].length
                ? renderDirectory("")
                : h(
                    "div",
                    { className: "workagent-file-panel-empty" },
                    h(Icon, { name: "workspace", size: 32 }),
                    h("strong", null, "此项目还没有文件"),
                    h("p", null, "拖入文件，或让助手在项目中创建文件。"),
                  )
              : h("p", { role: "status" }, "正在加载文件…"),
          ),
        ),
        tabs.length
          ? h(
              "nav",
              { className: "workagent-file-tabs", "aria-label": "已打开文件" },
              ...tabs.map((entry) =>
                h(
                  "span",
                  { key: entry.path },
                  h(
                    "button",
                    {
                      type: "button",
                      "aria-label": `切换文件 ${entry.name}`,
                      "aria-pressed": selected?.path === entry.path,
                      onClick: () => setSelected(entry),
                      title: entry.path,
                    },
                    `${entry.name}${dirtyFiles.has(entry.path) ? " •" : ""}`,
                  ),
                  h(
                    "button",
                    {
                      type: "button",
                      "aria-label": `关闭文件 ${entry.name}`,
                      onClick: () => closeTab(entry),
                    },
                    "×",
                  ),
                ),
              ),
            )
          : null,
        ...tabs.map((entry) =>
          h(
            "div",
            {
              key: entry.path,
              hidden: selected?.path !== entry.path,
              className: "workagent-file-tab-content",
            },
            h(WorkspaceFilePreview, {
              workspace,
              entry,
              active: selected?.path === entry.path,
              revision,
              onDirty: reportDirty,
              onClose: () => setSelected(null),
              onDismiss,
            }),
          ),
        ),
      );
    }

    function FileSidebarPanel({
      workspaceId,
      onProjectChange,
      sessionLoading,
      sessionError,
    }) {
      const [state, refresh] = useResource(`${apiRoot}/workspaces`);
      const [open, setOpen] = React.useState(
        () =>
          localStorage.getItem("workagent.files.open") === "true" ||
          (localStorage.getItem("workagent.files.open") === null &&
            window.innerWidth >= 1100),
      );
      const [width, setWidth] = React.useState(
        () => Number(localStorage.getItem("workagent.files.width")) || 440,
      );
      React.useEffect(() => {
        const openFile = (event) => {
          if (event.detail?.workspaceId === workspaceId) {
            setOpen(true);
            localStorage.setItem("workagent.files.open", "true");
          }
        };
        window.addEventListener("workagent:file-open", openFile);
        return () =>
          window.removeEventListener("workagent:file-open", openFile);
      }, [workspaceId]);
      const resizeWidth = (value) => {
        const next = Math.max(320, Math.min(window.innerWidth - 640, value));
        setWidth(next);
        localStorage.setItem("workagent.files.width", String(next));
      };
      React.useEffect(() => {
        const update = () =>
          document.body.style.setProperty(
            "--workagent-files-width",
            `${Math.max(320, Math.min(window.innerWidth - 640, width))}px`,
          );
        update();
        window.addEventListener("resize", update);
        return () => {
          window.removeEventListener("resize", update);
          document.body.style.removeProperty("--workagent-files-width");
        };
      }, [width]);
      const toggle = (value) => {
        setOpen(value);
        localStorage.setItem("workagent.files.open", String(value));
      };
      const workspace =
        workspaceId === "default"
          ? {
              id: "default",
              name: "当前会话文件",
              directory: ".workagent-unassigned",
            }
          : state.rows.find((row) => row.id === workspaceId);
      React.useEffect(() => {
        const update = () => void refresh();
        window.addEventListener(PROJECTS_CHANGED_EVENT, update);
        return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, update);
      }, [refresh]);
      return h(
        React.Fragment,
        null,
        h(
          "div",
          { className: "workagent-top-actions" },
          h(TopNotificationButton),
          h(
            "button",
            {
              type: "button",
              className: "workagent-files-toggle",
              "aria-label": open ? "收起文件侧栏" : "打开文件侧栏",
              "aria-expanded": open,
              "aria-controls": "workagent-files-panel",
              title: "项目文件",
              onClick: () => toggle(!open),
            },
            h(Icon, { name: "workspace", size: 19 }),
          ),
        ),
        open
          ? h("button", {
              type: "button",
              className: "workagent-files-backdrop",
              "aria-label": "关闭文件侧栏遮罩",
              onClick: () => toggle(false),
            })
          : null,
        h(
          "aside",
          {
            id: "workagent-files-panel",
            hidden: !open,
            className: "workagent-files-panel",
            "aria-label": "项目文件侧栏",
            onKeyDown: (event) => {
              if (
                event.key === "Escape" &&
                !["INPUT", "TEXTAREA"].includes(event.target.tagName)
              )
                toggle(false);
            },
          },
          h(ResizeHandle, {
            orientation: "vertical",
            value: width,
            onChange: resizeWidth,
            measure: (event) => {
              const initial = event.clientX;
              const actualWidth =
                event.currentTarget.parentElement.getBoundingClientRect().width;
              return (move) => actualWidth + initial - move.clientX;
            },
          }),
          h(
            "header",
            { className: "workagent-files-panel-header" },
            h("strong", null, "项目文件"),
            h(FileIconButton, {
              name: "expand",
              label: width > 500 ? "缩小文件侧栏" : "放大文件侧栏",
              onClick: () =>
                resizeWidth(width > 500 ? 440 : window.innerWidth * 0.55),
            }),
            h(FileIconButton, {
              name: "close",
              label: "关闭文件侧栏",
              onClick: () => toggle(false),
            }),
          ),
          onProjectChange
            ? h(
                "select",
                {
                  className: "workagent-files-project",
                  "aria-label": "文件侧栏项目",
                  value: workspace?.id || "",
                  onChange: (event) => onProjectChange(event.target.value),
                },
                h("option", { value: "" }, "选择项目"),
                ...state.rows
                  .filter((row) => row.scope !== "team")
                  .map((row) =>
                    h(
                      "option",
                      { key: row.id, value: row.id },
                      displayWorkspaceName(row.name),
                    ),
                  ),
              )
            : h(
                "div",
                {
                  className: "workagent-files-project",
                  title: workspace?.name,
                },
                workspace
                  ? displayWorkspaceName(workspace.name)
                  : "当前会话项目",
              ),
          state.error || sessionError
            ? h(
                "p",
                { role: "alert", className: "workagent-file-notice" },
                friendlyError(state.error || sessionError),
              )
            : state.loading || sessionLoading
              ? h("p", { role: "status" }, "正在加载项目…")
              : workspace
                ? h(WorkspaceFileManager, {
                    key: workspace.id,
                    workspace,
                    onDismiss: () => toggle(false),
                  })
                : h(
                    "div",
                    { className: "workagent-file-panel-empty" },
                    h(Icon, { name: "workspace", size: 32 }),
                    h("strong", null, "选择项目后查看文件"),
                    h(
                      "p",
                      null,
                      "文件随项目保存。已有会话会自动显示所属项目。",
                    ),
                  ),
        ),
      );
    }
    function HomeFileSidebar() {
      const routeSearch = navigation.useSearch();
      const [workspaceId, setWorkspaceId] = React.useState(
        () =>
          new URLSearchParams(routeSearch).get("project") ||
          localStorage.getItem(WORKSPACE_PICK_KEY) ||
          "",
      );
      React.useEffect(() => {
        setWorkspaceId(
          new URLSearchParams(routeSearch).get("project") ||
            localStorage.getItem(WORKSPACE_PICK_KEY) ||
            "",
        );
      }, [routeSearch]);
      React.useEffect(() => {
        const update = (event) => setWorkspaceId(event.detail || "");
        window.addEventListener(FILE_PROJECT_EVENT, update);
        return () => window.removeEventListener(FILE_PROJECT_EVENT, update);
      }, []);
      return h(FileSidebarPanel, {
        workspaceId,
        onProjectChange: (id) => {
          setWorkspaceId(id);
          localStorage.setItem(WORKSPACE_PICK_KEY, id || "none");
          window.dispatchEvent(
            new window.CustomEvent(HERO_WORKSPACE_EVENT, {
              detail: id || "none",
            }),
          );
        },
      });
    }
    function SessionFileSidebar({ sessionId }) {
      const [state] = useResource(
        `${apiRoot}/sessions/${encodeURIComponent(sessionId)}`,
      );
      return h(FileSidebarPanel, {
        workspaceId: state.rows[0]?.workspaceId,
        sessionLoading: state.loading,
        sessionError: state.error,
      });
    }
    function FileSidebar() {
      const routeSearch = navigation.useSearch();
      const params = new URLSearchParams(routeSearch);
      if (params.get("workagent"))
        return h(
          "div",
          { className: "workagent-top-actions" },
          h(TopNotificationButton),
        );
      const sessionId = params.get("session");
      return sessionId
        ? h(SessionFileSidebar, { key: sessionId, sessionId })
        : h(HomeFileSidebar);
    }

    function WorkspacesPage() {
      const endpoint = `${apiRoot}/workspaces`;
      const [state, refresh] = useResource(endpoint);
      const [selected, setSelected] = React.useState(null);
      const [files, setFiles] = React.useState([]);
      const [preview, setPreview] = React.useState(null);
      const [error, setError] = React.useState("");
      const [directory, setDirectory] = React.useState("");
      const [loadingFiles, setLoadingFiles] = React.useState(false);
      const [query, setQuery] = React.useState("");
      const [fileAction, setFileAction] = React.useState(null);
      const [fileName, setFileName] = React.useState("");
      const [saving, setSaving] = React.useState(false);
      const [creating, setCreating] = React.useState(false);
      const [showCreate, setShowCreate] = React.useState(false);
      const fileRequest = React.useRef(0);
      const visibleProjects = state.rows.filter((workspace) =>
        displayWorkspaceName(workspace.name)
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
      );
      React.useEffect(() => {
        const update = () => void refresh();
        window.addEventListener(PROJECTS_CHANGED_EVENT, update);
        return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, update);
      }, [refresh]);
      const createProject = async (event) => {
        event.preventDefault();
        if (creating) return;
        const form = event.currentTarget;
        const values = new FormData(form);
        const name = String(values.get("name") || "").trim();
        if (!name) {
          setError("请输入项目名称。");
          return;
        }
        setCreating(true);
        setError("");
        try {
          const project = await request(endpoint, {
            method: "POST",
            body: JSON.stringify({ name, scope: "personal" }),
          });
          await refresh();
          announceProjectsChanged();
          form.reset();
          setShowCreate(false);
          setQuery("");
          await openWorkspace(project);
        } catch (reason) {
          setError(friendlyError(reason.message));
        } finally {
          setCreating(false);
        }
      };
      const openWorkspace = async (workspace, path = "") => {
        const revision = ++fileRequest.current;
        setSelected(workspace);
        setDirectory(path);
        setPreview(null);
        setFiles([]);
        setError("");
        setLoadingFiles(true);
        try {
          const entries = await request(
            `${endpoint}/${encodeURIComponent(workspace.id)}/files${path ? `?path=${encodeURIComponent(path)}` : ""}`,
          );
          if (revision === fileRequest.current) setFiles(entries);
        } catch (reason) {
          if (revision === fileRequest.current)
            setError(friendlyError(reason.message));
        } finally {
          if (revision === fileRequest.current) setLoadingFiles(false);
        }
      };
      const submitFileAction = async (event) => {
        event.preventDefault();
        if (saving) return;
        const { kind, entry } = fileAction;
        const name = fileName.trim();
        if (
          kind === "rename" &&
          (!name || /[\\/:*?"<>|]/.test(name) || name === "." || name === "..")
        ) {
          setError("请输入有效文件名，不能包含路径分隔符。");
          return;
        }
        setSaving(true);
        setError("");
        try {
          const root = `${endpoint}/${encodeURIComponent(selected.id)}`;
          if (kind === "delete")
            await request(
              `${root}/content?path=${encodeURIComponent(entry.path)}`,
              { method: "DELETE" },
            );
          else
            await request(`${root}/move`, {
              method: "POST",
              body: JSON.stringify({
                source: entry.path,
                destination: directory ? `${directory}/${name}` : name,
              }),
            });
          setFileAction(null);
          await openWorkspace(selected, directory);
        } catch (reason) {
          setError(friendlyError(reason.message));
        } finally {
          setSaving(false);
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
        else if (
          [
            "txt",
            "md",
            "csv",
            "json",
            "yaml",
            "yml",
            "log",
            "js",
            "ts",
            "tsx",
            "jsx",
            "css",
            "html",
            "xml",
            "py",
            "go",
            "ps1",
            "toml",
            "ini",
            "svg",
          ].includes(extension)
        ) {
          try {
            setPreview({
              text: await request(path),
              media: "text",
              name: entry.name,
            });
          } catch (reason) {
            setError(reason.message);
          }
        } else setPreview({ media: "unsupported", name: entry.name });
      };
      return h(
        Section,
        { title: "项目" },
        h(
          "div",
          { className: "workagent-project-intro" },
          h(
            "div",
            null,
            h("h2", null, "所有项目"),
            h("p", null, "文件与对话，在这里井然有序。"),
          ),
          h(
            "span",
            { className: "workagent-project-count" },
            `${state.rows.length} 个项目`,
          ),
        ),
        h(
          "div",
          { className: "workagent-project-toolbar" },
          h(
            "div",
            { className: "workagent-project-search" },
            h(Icon, { name: "search", size: 18 }),
            h(Input, {
              "aria-label": "搜索项目",
              placeholder: "搜索项目名称…",
              value: query,
              onChange: (event) => {
                setQuery(event.target.value);
                setPreview(null);
              },
            }),
            query
              ? h(
                  Button,
                  { "aria-label": "清除项目搜索", onClick: () => setQuery("") },
                  h(Icon, { name: "close", size: 16 }),
                )
              : null,
          ),
          h(
            Button,
            {
              className: "workagent-button workagent-project-new",
              onClick: () => {
                setError("");
                setShowCreate(true);
              },
            },
            h(Icon, { name: "plus", size: 16 }),
            "新建项目",
          ),
        ),
        showCreate
          ? h(
              "form",
              {
                className: "workagent-form workagent-project-create",
                onSubmit: createProject,
              },
              h(
                Field,
                { label: "新项目名称" },
                h(Input, {
                  name: "name",
                  autoFocus: true,
                  required: true,
                  maxLength: 120,
                  placeholder: "给项目起个名字",
                  onKeyDown: (event) => {
                    if (event.key === "Escape" && !creating) {
                      event.stopPropagation();
                      setShowCreate(false);
                    }
                  },
                }),
              ),
              h(
                Button,
                { disabled: creating, onClick: () => setShowCreate(false) },
                "取消",
              ),
              h(
                "button",
                {
                  className: "workagent-button workagent-project-new",
                  type: "submit",
                  disabled: creating,
                },
                creating ? "正在创建…" : "创建项目",
              ),
            )
          : null,
        error
          ? h("p", { role: "alert", className: "workagent-error" }, error)
          : null,
        state.loading || state.error
          ? h(Status, { state })
          : state.rows.length === 0
            ? h(
                "div",
                { className: "workagent-project-empty" },
                h(Icon, { name: "workspace", size: 36 }),
                h("strong", null, "创建你的第一个项目"),
                h("p", null, "给项目起个名字，将相关文件与对话放在一起。"),
              )
            : null,
        !state.loading && state.rows.length > 0 && visibleProjects.length === 0
          ? h(
              "div",
              { className: "workagent-project-empty" },
              h(Icon, { name: "search", size: 28 }),
              h("strong", null, "没有找到匹配的项目"),
              h("p", null, "试试其他名称，或清除搜索查看所有项目。"),
            )
          : null,
        h(
          "div",
          { className: "workagent-grid workagent-workspace-grid" },
          ...visibleProjects.map((workspace) =>
            h(
              Card,
              {
                key: workspace.id,
                className: `workagent-workspace-card${selected?.id === workspace.id ? " is-selected" : ""}`,
                title: h(
                  "span",
                  null,
                  h(Icon, { name: "workspace", size: 18 }),
                  displayWorkspaceName(workspace.name),
                ),
                detail:
                  workspace.scope === "team" ? "团队共享项目" : "个人项目",
              },
              h(
                Button,
                { onClick: () => openWorkspace(workspace) },
                "管理文件",
                h(Icon, { name: "chevronRight", size: 14 }),
              ),
              h(
                Button,
                { onClick: () => startProjectConversation(workspace) },
                h(Icon, { name: "plus", size: 14 }),
                "新建会话",
              ),
            ),
          ),
        ),
        selected &&
          visibleProjects.some((workspace) => workspace.id === selected.id)
          ? h(
              "div",
              { className: "workagent-file-browser", "aria-label": "项目文件" },
              h(
                "header",
                null,
                h(
                  "nav",
                  { "aria-label": "文件路径" },
                  h(
                    Button,
                    { onClick: () => openWorkspace(selected) },
                    displayWorkspaceName(selected.name),
                  ),
                  ...directory
                    .split("/")
                    .filter(Boolean)
                    .map((part, index, parts) =>
                      h(
                        Button,
                        {
                          key: index,
                          onClick: () =>
                            openWorkspace(
                              selected,
                              parts.slice(0, index + 1).join("/"),
                            ),
                        },
                        h(Icon, { name: "chevronRight", size: 12 }),
                        part,
                      ),
                    ),
                ),
                h(
                  Button,
                  {
                    onClick: () => openWorkspace(selected, directory),
                    disabled: loadingFiles,
                  },
                  "刷新",
                ),
              ),
              loadingFiles
                ? h(
                    "p",
                    { role: "status", className: "workagent-file-empty" },
                    "正在加载文件…",
                  )
                : files.length === 0
                  ? h(
                      "div",
                      { className: "workagent-file-empty" },
                      h(Icon, { name: "workspace", size: 32 }),
                      h("strong", null, "此文件夹还没有文件"),
                      h(
                        "p",
                        null,
                        "在项目中开始对话，生成的文件会显示在这里。",
                      ),
                    )
                  : null,
              ...files
                .slice()
                .sort((a, b) =>
                  a.kind === b.kind
                    ? a.name.localeCompare(b.name, "zh-CN")
                    : a.kind === "directory"
                      ? -1
                      : 1,
                )
                .map((entry) =>
                  h(
                    "div",
                    {
                      key: entry.path,
                      className: "workagent-file-row",
                    },
                    h(Icon, {
                      name: entry.kind === "file" ? "chat" : "workspace",
                      size: 18,
                    }),
                    h(
                      "button",
                      {
                        className: "workagent-file-name",
                        onClick: () =>
                          entry.kind === "file"
                            ? openFile(entry)
                            : openWorkspace(selected, entry.path),
                      },
                      entry.name,
                    ),
                    h(
                      "span",
                      { className: "workagent-file-kind" },
                      entry.kind === "file" ? "文件" : "文件夹",
                    ),
                    h(
                      "div",
                      { className: "workagent-file-actions" },
                      entry.kind === "file"
                        ? h(
                            Button,
                            {
                              onClick: () => openFile(entry),
                              "aria-label": `预览 ${entry.name}`,
                            },
                            "预览",
                          )
                        : null,
                      entry.kind === "file"
                        ? h(
                            "a",
                            {
                              className: "workagent-button",
                              href: `${endpoint}/${encodeURIComponent(selected.id)}/content?path=${encodeURIComponent(entry.path)}`,
                              download: entry.name,
                              "aria-label": `下载 ${entry.name}`,
                            },
                            "下载",
                          )
                        : null,
                      h(
                        Button,
                        {
                          "aria-label": `重命名 ${entry.name}`,
                          onClick: () => {
                            setError("");
                            setFileName(entry.name);
                            setFileAction({ kind: "rename", entry });
                          },
                        },
                        "重命名",
                      ),
                      h(
                        Button,
                        {
                          "aria-label": `删除 ${entry.name}`,
                          onClick: () => {
                            setError("");
                            setFileAction({ kind: "delete", entry });
                          },
                        },
                        "删除",
                      ),
                    ),
                  ),
                ),
            )
          : null,
        fileAction
          ? h(
              "div",
              { className: "workagent-dialog-backdrop" },
              h(
                "form",
                {
                  className: "workagent-dialog",
                  role: "dialog",
                  "aria-modal": true,
                  "aria-label":
                    fileAction.kind === "rename" ? "重命名文件" : "删除文件",
                  onSubmit: submitFileAction,
                },
                h(
                  "h3",
                  null,
                  fileAction.kind === "rename" ? "重命名文件" : "删除文件",
                ),
                fileAction.kind === "rename"
                  ? h(Input, {
                      "aria-label": "文件名",
                      value: fileName,
                      autoFocus: true,
                      required: true,
                      onChange: (event) => setFileName(event.target.value),
                    })
                  : h(
                      "p",
                      null,
                      `确定删除“${fileAction.entry.name}”${fileAction.entry.kind === "file" ? "" : "及其全部内容"}？此操作无法撤销。`,
                    ),
                error
                  ? h(
                      "p",
                      { role: "alert", className: "workagent-error" },
                      error,
                    )
                  : null,
                h(
                  "div",
                  { className: "workagent-dialog-actions" },
                  h(
                    Button,
                    {
                      disabled: saving,
                      onClick: () => {
                        setFileAction(null);
                        setError("");
                      },
                    },
                    "取消",
                  ),
                  h(
                    "button",
                    {
                      className: "workagent-button",
                      type: "submit",
                      disabled: saving,
                    },
                    saving
                      ? "处理中…"
                      : fileAction.kind === "rename"
                        ? "保存"
                        : "删除",
                  ),
                ),
              ),
            )
          : null,
        preview
          ? h(
              "div",
              { className: "workagent-preview-heading" },
              h("strong", null, preview.name),
              h(Button, { onClick: () => setPreview(null) }, "关闭预览"),
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
              : preview?.media === "unsupported"
                ? h(
                    "p",
                    { className: "workagent-card" },
                    "此文件暂不支持预览，请下载后查看。",
                  )
                : null,
      );
    }

    function ConversationMessageTarget({ sessionId }) {
      const routeSearch = navigation.useSearch();
      const locateMessage = React.useCallback((messageId) => {
        const escaped = globalThis.CSS?.escape
          ? globalThis.CSS.escape(messageId)
          : messageId.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
        let target = document.querySelector(
          `[data-message-id="${escaped}"], #message-${escaped}`,
        );
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
        const messageId = new URLSearchParams(routeSearch).get("message");
        if (!messageId) return;
        let attempts = 0;
        const timer = globalThis.setInterval(() => {
          attempts += 1;
          if (locateMessage(messageId) || attempts >= 40)
            globalThis.clearInterval(timer);
        }, 100);
        return () => globalThis.clearInterval(timer);
      }, [sessionId, routeSearch, locateMessage]);
      return null;
    }

    const AGENT_PICK_KEY = "workagent.hero.agent";
    const CHAT_PAGE_KEY = "workagent.chat-page-url";
    const WORKSPACE_PICK_KEY = "workagent.hero.workspace";
    const HERO_AGENT_EVENT = "workagent:hero-agent";
    const HERO_WORKSPACE_EVENT = "workagent:hero-workspace";
    const PROJECTS_CHANGED_EVENT = "workagent:projects-changed";
    const SESSIONS_CHANGED_EVENT = "workagent:sessions-changed";
    const SESSION_SEEN_PREFIX = "workagent.session-seen.";
    function startProjectConversation(project) {
      localStorage.setItem(WORKSPACE_PICK_KEY, project.id);
      navigation.navigate(
        `/?frontend=dsh&project=${encodeURIComponent(project.id)}`,
      );
    }
    const announceProjectsChanged = () =>
      window.dispatchEvent(new window.Event(PROJECTS_CHANGED_EVENT));

    // Draft choices live only in this composer. New conversations start from settings.
    function useDraftOption(key, options, defaultId, revision) {
      const [selection, setSelection] = React.useState({
        revision,
        values: {},
      });
      const saved =
        selection.revision === revision ? selection.values[key] : undefined;
      const value =
        (
          options.find((option) => option.id === saved) ||
          options.find((option) => option.id === defaultId) ||
          options[0]
        )?.id || "";
      return [
        value,
        (value) =>
          setSelection((previous) => ({
            revision,
            values: {
              ...(previous.revision === revision ? previous.values : {}),
              [key]: value,
            },
          })),
      ];
    }

    function TopNotificationButton() {
      const [state] = useResource(
        "/api/portal/me/notifications",
        (value) => value.notifications || [],
      );
      const unread = state.rows.filter((row) => !row.read_at).length;
      return h(
        "button",
        {
          type: "button",
          className: "workagent-top-notifications",
          title: "通知",
          "aria-label": unread ? `通知，${unread} 条未读` : "通知",
          onClick: () => navigation.navigate("/?workagent=notifications"),
        },
        h(Icon, { name: "notifications", size: 19 }),
        unread ? h("span", { className: "workagent-badge" }, unread) : null,
      );
    }

    function AgentPicker() {
      const [state] = useResource(`${apiRoot}/presets`, (value) =>
        (Array.isArray(value) ? value : []).filter((preset) => preset.enabled),
      );
      const [selected, setSelected] = React.useState(
        () => localStorage.getItem(AGENT_PICK_KEY) || "builtin-general",
      );
      React.useEffect(() => {
        if (state.loading || state.rows.length === 0) return;
        if (state.rows.some((preset) => preset.id === selected)) return;
        const fallback =
          state.rows.find((preset) => preset.id === "builtin-general") ||
          state.rows[0];
        setSelected(fallback.id);
        localStorage.setItem(AGENT_PICK_KEY, fallback.id);
      }, [selected, state.loading, state.rows]);
      const choose = (preset) => {
        setSelected(preset.id);
        localStorage.setItem(AGENT_PICK_KEY, preset.id);
        window.dispatchEvent(
          new window.CustomEvent(HERO_AGENT_EVENT, { detail: preset.id }),
        );
      };
      if (state.loading || state.rows.length === 0) return null;
      return h(
        React.Fragment,
        null,
        h(
          "div",
          { className: "workagent-agents", role: "radiogroup" },
          h(
            "div",
            { className: "workagent-agent-strip" },
            ...state.rows.map((preset, index) => {
              const displayName = displayPresetName(preset.name);
              return h(
                "button",
                {
                  key: preset.id,
                  type: "button",
                  role: "radio",
                  "aria-checked": selected === preset.id,
                  tabIndex: selected === preset.id ? 0 : -1,
                  className: [
                    "workagent-agent",
                    selected === preset.id ? "is-active" : "",
                  ]
                    .filter(Boolean)
                    .join(" "),
                  title: `切换到${displayName}`,
                  onClick: () => choose(preset),
                  onKeyDown: (event) => {
                    if (!["ArrowLeft", "ArrowRight"].includes(event.key))
                      return;
                    event.preventDefault();
                    const direction = event.key === "ArrowRight" ? 1 : -1;
                    const nextIndex =
                      (index + direction + state.rows.length) %
                      state.rows.length;
                    choose(state.rows[nextIndex]);
                    event.currentTarget.parentElement?.children[
                      nextIndex
                    ]?.focus();
                  },
                },
                preset.avatar
                  ? h("img", {
                      className: "workagent-agent-avatar",
                      src: preset.avatar,
                      alt: "",
                    })
                  : h(EngineMark, { engine: preset.engine }),
                h("span", { className: "workagent-agent-name" }, displayName),
              );
            }),
          ),
        ),
      );
    }

    function HeroWorkspaceComposer() {
      const routeSearch = navigation.useSearch();
      const [workspaceState, reloadWorkspaces] = useResource(
        `${apiRoot}/workspaces`,
      );
      const [presetState] = useResource(`${apiRoot}/presets`, (value) =>
        (Array.isArray(value) ? value : []).filter((preset) => preset.enabled),
      );
      const [modelState] = useResource(`${apiRoot}/model-options`);
      const [projectChoice, setProjectChoice] = React.useState(
        () =>
          new URLSearchParams(routeSearch).get("project") ||
          localStorage.getItem(WORKSPACE_PICK_KEY) ||
          "none",
      );
      React.useEffect(() => {
        setProjectChoice(
          new URLSearchParams(routeSearch).get("project") ||
            localStorage.getItem(WORKSPACE_PICK_KEY) ||
            "none",
        );
      }, [routeSearch]);
      const [presetId, setPresetId] = React.useState(
        () => localStorage.getItem(AGENT_PICK_KEY) || "builtin-general",
      );
      const [teamMode, setTeamMode] = React.useState(false);
      const [projectName, setProjectName] = React.useState("");
      const [preferences, , defaultsRevision] = useModelDefaults();
      const [message, setMessage] = React.useState("");
      const [attachmentsBusy, setAttachmentsBusy] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState("");

      React.useEffect(() => {
        window.dispatchEvent(
          new window.CustomEvent(FILE_PROJECT_EVENT, {
            detail: ["none", "new"].includes(projectChoice)
              ? ""
              : projectChoice,
          }),
        );
      }, [projectChoice]);

      React.useEffect(() => {
        const update = (event) => setPresetId(event.detail);
        window.addEventListener(HERO_AGENT_EVENT, update);
        return () => window.removeEventListener(HERO_AGENT_EVENT, update);
      }, []);
      React.useEffect(() => {
        const update = (event) => {
          setTeamMode(false);
          setProjectChoice(event.detail);
        };
        window.addEventListener(HERO_WORKSPACE_EVENT, update);
        return () => window.removeEventListener(HERO_WORKSPACE_EVENT, update);
      }, []);
      React.useEffect(() => {
        const update = () => void reloadWorkspaces();
        window.addEventListener(PROJECTS_CHANGED_EVENT, update);
        return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, update);
      }, [reloadWorkspaces]);

      const selectedPreset =
        presetState.rows.find((preset) => preset.id === presetId) ||
        presetState.rows.find((preset) => preset.id === "builtin-general") ||
        presetState.rows[0];
      const teamProjects = workspaceState.rows.filter(
        (workspace) => workspace.scope === "team",
      );
      const availableProjects = teamMode ? teamProjects : workspaceState.rows;
      const modelGroup = modelState.rows.find(
        (group) => group.engine === selectedPreset?.engine,
      );
      const availableModels = modelGroup?.models || [];
      const defaults = resolveModelDefaults(
        modelGroup,
        preferences,
        selectedPreset,
      );
      const draftKey = `${selectedPreset?.id}:${selectedPreset?.engine}`;
      const [modelId, setModelId] = useDraftOption(
        draftKey,
        availableModels,
        defaults.modelId,
        defaultsRevision,
      );
      const selectedModel = availableModels.find(
        (model) => model.id === modelId,
      );
      const reasoningOptions = selectedModel?.reasoning || [];
      const [thinkingEffort, setThinkingEffort] = useDraftOption(
        `${draftKey}.${modelId}`,
        reasoningOptions,
        modelId === defaults.modelId
          ? defaults.thinkingEffort
          : defaultEffort(selectedPreset?.engine, selectedModel),
        defaultsRevision,
      );
      const [permissionMode, setPermissionMode] = useDraftOption(
        draftKey,
        permissionOptions.map(([id]) => ({ id })),
        defaults.permissionMode,
        defaultsRevision,
      );
      React.useEffect(() => {
        if (workspaceState.loading) return;
        const valid = availableProjects.some(
          (project) => project.id === projectChoice,
        );
        if (!valid && projectChoice !== "new" && projectChoice !== "none")
          setProjectChoice(teamMode ? "new" : "none");
        if (teamMode && projectChoice === "none") setProjectChoice("new");
      }, [teamMode, workspaceState.loading, workspaceState.rows]);
      const selectProject = (event) => {
        const value = event.target.value;
        setProjectChoice(value);
        if (!teamMode && value !== "new" && value !== "none") {
          localStorage.setItem(WORKSPACE_PICK_KEY, value);
          window.dispatchEvent(
            new window.CustomEvent(HERO_WORKSPACE_EVENT, { detail: value }),
          );
        }
        setError("");
      };
      const submit = async (event) => {
        event.preventDefault();
        const content = message.trim();
        if (!content || busy || attachmentsBusy) return;
        if (!selectedPreset) {
          setError("请先选择一个助手。");
          return;
        }
        if (modelState.loading || !selectedModel) {
          setError("请先获取可用模型。");
          return;
        }
        if (teamMode && projectChoice === "none") {
          setError("团队模式必须选择或新建一个团队项目。");
          return;
        }
        if (projectChoice === "new" && !projectName.trim()) {
          setError("请输入新项目名称。");
          return;
        }
        setBusy(true);
        setError("");
        try {
          let project = availableProjects.find(
            (item) => item.id === projectChoice,
          );
          if (projectChoice === "new") {
            project = await request(`${apiRoot}/workspaces`, {
              method: "POST",
              body: JSON.stringify({
                name: projectName.trim(),
                scope: teamMode ? "team" : "personal",
              }),
            });
            await reloadWorkspaces();
            announceProjectsChanged();
          }
          const common = {
            ...(modelId ? { modelId } : {}),
            ...(thinkingEffort ? { thinkingEffort } : {}),
            permissionMode,
          };
          let session;
          if (teamMode) {
            const team = await request(`${apiRoot}/teams`, {
              method: "POST",
              body: JSON.stringify({
                name: `${displayWorkspaceName(project.name)}团队`,
                workspaceId: project.id,
                lead: {
                  name: displayPresetName(selectedPreset.name),
                  engine: selectedPreset.engine,
                  presetId: selectedPreset.id,
                  ...common,
                },
              }),
            });
            session = { id: team.members[0].sessionId };
          } else {
            session = await request(`${apiRoot}/sessions`, {
              method: "POST",
              body: JSON.stringify({
                engine: selectedPreset.engine,
                title: plainSessionTitle(
                  content.length > 28 ? `${content.slice(0, 28)}…` : content,
                ),
                workspace: project?.id || "default",
                presetId: selectedPreset.id,
                ...common,
              }),
            });
          }
          await request(
            `${apiRoot}/sessions/${encodeURIComponent(session.id)}/turns`,
            {
              method: "POST",
              body: JSON.stringify({
                content,
                messageId: `message-ui-${Date.now()}`,
              }),
            },
          );
          setMessage("");
          navigation.navigate(`/?session=${encodeURIComponent(session.id)}`);
        } catch (cause) {
          setError(friendlyError(cause.message));
        } finally {
          setBusy(false);
        }
      };

      return h(
        "div",
        { className: "workagent-hero-controls" },
        h(
          ComposerForm,
          { className: "workagent-hero-composer", onSubmit: submit },
          h(workbench.ComposerTools, {
            session: {
              id: "home",
              workspaceId:
                projectChoice === "none"
                  ? "default"
                  : projectChoice === "new"
                    ? undefined
                    : projectChoice,
              preset: { resolvedSnapshot: selectedPreset || {} },
            },
            input: message,
            setInput: setMessage,
            disabled: busy,
            onError: setError,
            onBusyChange: setAttachmentsBusy,
          }),
          h(ComposerInput, {
            "aria-label": "输入消息",
            value: message,
            onChange: (event) => setMessage(event.target.value),
            onKeyDown: submitComposerOnEnter,
            placeholder: "描述你想完成的任务…",
          }),
          h(
            "div",
            { className: "workagent-hero-composer-bar" },
            h(
              "div",
              { className: "workagent-composer-options" },
              h(
                "label",
                {
                  className: "workagent-model-choice",
                  title: selectedModel?.name || "模型",
                },
                h(
                  "span",
                  {
                    className: "workagent-model-choice-label",
                    "aria-hidden": true,
                  },
                  selectedModel?.name || "模型",
                ),
                h(Select, {
                  "aria-label": "模型",
                  value: modelId,
                  disabled: modelState.loading || !availableModels.length,
                  onChange: (event) => setModelId(event.target.value),
                  options: [
                    ...(!availableModels.length
                      ? [
                          [
                            "",
                            modelState.loading
                              ? "正在获取模型…"
                              : "暂无可用模型",
                          ],
                        ]
                      : []),
                    ...availableModels.map((model) => [model.id, model.name]),
                  ],
                }),
              ),
              h(
                "label",
                { title: "思考级别" },
                h(Select, {
                  "aria-label": "思考级别",
                  heading: "思考强度",
                  value: thinkingEffort,
                  disabled: modelState.loading || !reasoningOptions.length,
                  onChange: (event) => setThinkingEffort(event.target.value),
                  options: reasoningOptions.length
                    ? reasoningOptions.map((option) => [
                        option.id,
                        reasoningLabel(option),
                      ])
                    : [["", "未提供思考选项"]],
                }),
              ),
              h(
                "label",
                { title: "权限" },
                h(Select, {
                  "aria-label": "权限",
                  heading: "权限",
                  value: permissionMode,
                  onChange: (event) => setPermissionMode(event.target.value),
                  options: permissionOptions,
                }),
              ),
            ),
            h(
              "button",
              {
                type: "submit",
                className: "workagent-composer-send",
                "aria-label": "发送消息",
                disabled:
                  busy ||
                  !message.trim() ||
                  !selectedPreset ||
                  (projectChoice === "new" && !projectName.trim()),
              },
              h(Icon, { name: "send", size: 18 }),
            ),
          ),
        ),
        h(
          "div",
          { className: "workagent-project-row" },
          h(
            "label",
            { className: "workagent-project-select" },
            h(Icon, { name: "workspace", size: 16 }),
            h(Select, {
              "aria-label": teamMode ? "团队项目" : "个人项目",
              value: projectChoice,
              onChange: selectProject,
              options: [
                ...(teamMode ? [] : [["none", "不使用项目"]]),
                ...availableProjects.map((project) => [
                  project.id,
                  displayWorkspaceName(project.name),
                ]),
                ["new", teamMode ? "新建团队项目…" : "新建个人项目…"],
              ],
            }),
          ),
          projectChoice === "new"
            ? h(
                "div",
                { className: "workagent-project-draft" },
                h(Input, {
                  className: "workagent-project-name",
                  "aria-label": "新项目名称",
                  value: projectName,
                  onChange: (event) => setProjectName(event.target.value),
                  placeholder: teamMode ? "团队项目名称" : "个人项目名称",
                }),
                h(
                  Button,
                  {
                    disabled: busy || !projectName.trim(),
                    onClick: async () => {
                      setBusy(true);
                      setError("");
                      try {
                        const project = await request(`${apiRoot}/workspaces`, {
                          method: "POST",
                          body: JSON.stringify({
                            name: projectName.trim(),
                            scope: teamMode ? "team" : "personal",
                          }),
                        });
                        await reloadWorkspaces();
                        setProjectChoice(project.id);
                        announceProjectsChanged();
                      } catch (reason) {
                        setError(friendlyError(reason.message));
                      } finally {
                        setBusy(false);
                      }
                    },
                  },
                  "创建项目",
                ),
              )
            : null,
          h(
            "label",
            { className: "workagent-team-toggle" },
            h(Input, {
              type: "checkbox",
              checked: teamMode,
              onChange: (event) => {
                const enabled = event.target.checked;
                setTeamMode(enabled);
                setProjectChoice(enabled ? "new" : "none");
                setProjectName("");
                setError("");
              },
            }),
            h("span", null, "团队模式"),
          ),
          error
            ? h("span", { role: "alert", className: "workagent-error" }, error)
            : h(
                "span",
                { className: "workagent-composer-hint" },
                busy
                  ? "正在创建会话…"
                  : teamMode
                    ? "团队项目会创建在共享范围"
                    : "Enter 发送",
              ),
        ),
      );
    }

    function SidebarSessions() {
      const routeSearch = navigation.useSearch();
      const [workspaceState, reloadWorkspaces] = useResource(
        `${apiRoot}/workspaces`,
      );
      const [sessionState, reloadSessions] = useResource(
        `${apiRoot}/sessions`,
        (value) =>
          (Array.isArray(value) ? value : [])
            .slice()
            .sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt),
            ),
      );
      const [teamState, reloadTeams] = useResource(`${apiRoot}/teams`);
      const pins = workbench.usePins();
      const [batchMode, setBatchMode] = React.useState(false);
      const [selectedIds, setSelectedIds] = React.useState([]);
      const [batchBusy, setBatchBusy] = React.useState(false);
      const [batchError, setBatchError] = React.useState("");
      async function deleteSelected() {
        if (
          !selectedIds.length ||
          !window.confirm(`删除选中的 ${selectedIds.length} 个对话及消息？`)
        )
          return;
        setBatchBusy(true);
        const failed = [];
        for (const id of selectedIds) {
          try {
            await request(`${apiRoot}/sessions/${encodeURIComponent(id)}`, {
              method: "DELETE",
            });
          } catch (reason) {
            failed.push({ id, error: friendlyError(reason.message) });
          }
        }
        setSelectedIds(failed.map((item) => item.id));
        setBatchError(
          failed.length
            ? failed
                .map(
                  (item) =>
                    `${sessionState.rows.find((row) => row.id === item.id)?.title || item.id}：${item.error}`,
                )
                .join("；")
            : "",
        );
        setBatchBusy(false);
        reloadSessions();
        if (
          selectedIds.includes(activeSession) &&
          !failed.some((item) => item.id === activeSession)
        )
          navigation.navigate("/?frontend=dsh");
      }
      const [query, setQuery] = React.useState("");
      const [searching, setSearching] = React.useState(false);
      const [collapsed, setCollapsed] = React.useState({});
      const [sectionsCollapsed, setSectionsCollapsed] = React.useState(() => ({
        projects:
          localStorage.getItem("workagent.sidebar.projects-collapsed") ===
          "true",
        sessions:
          localStorage.getItem("workagent.sidebar.sessions-collapsed") ===
          "true",
      }));
      const sectionToggle = (section, label) =>
        h(
          "button",
          {
            type: "button",
            className: "workagent-sidebar-section-toggle",
            "aria-label": `${sectionsCollapsed[section] ? "展开" : "收起"}${label}`,
            "aria-expanded": !sectionsCollapsed[section],
            onClick: () => {
              const next = !sectionsCollapsed[section];
              localStorage.setItem(
                `workagent.sidebar.${section}-collapsed`,
                String(next),
              );
              setSectionsCollapsed((value) => ({ ...value, [section]: next }));
              if (section === "projects" && next) {
                setSearching(false);
                setQuery("");
              }
            },
          },
          h(Icon, {
            name: sectionsCollapsed[section] ? "chevronRight" : "chevronDown",
            size: 13,
          }),
          h("span", null, label),
        );
      const [action, setAction] = React.useState(null);
      const [actionValue, setActionValue] = React.useState("");
      const [error, setError] = React.useState("");
      const activeSession = new URLSearchParams(routeSearch).get("session");
      React.useEffect(() => {
        const closeOnEscape = (event) => {
          if (
            event.key === "Escape" &&
            window.innerWidth <= 760 &&
            !document.querySelector('[role="dialog"]')
          )
            closeMobileSidebar();
        };
        window.addEventListener("keydown", closeOnEscape);
        return () => window.removeEventListener("keydown", closeOnEscape);
      }, []);
      const [, setSeenRevision] = React.useState(0);
      const openedSession = React.useRef(null);
      const markSeen = (session) => {
        if (session.lastTurn)
          localStorage.setItem(
            SESSION_SEEN_PREFIX + session.id,
            session.lastTurn.id,
          );
        setSeenRevision((value) => value + 1);
      };
      React.useEffect(() => {
        const session = sessionState.rows.find(
          (item) => item.id === activeSession,
        );
        if (!session || openedSession.current === activeSession) return;
        openedSession.current = activeSession;
        markSeen(session);
      }, [sessionState.rows, activeSession]);
      React.useEffect(() => {
        let disposed = false;
        let timer;
        let pending = false;
        let rerun = false;
        const update = async () => {
          clearTimeout(timer);
          if (disposed) return;
          if (pending) {
            rerun = true;
            return;
          }
          pending = true;
          try {
            await reloadSessions();
          } finally {
            pending = false;
            if (!disposed) {
              timer = setTimeout(update, rerun ? 0 : 2500);
              rerun = false;
            }
          }
        };
        const syncSeen = (event) => {
          if (event.key === null || event.key?.startsWith(SESSION_SEEN_PREFIX))
            setSeenRevision((value) => value + 1);
        };
        timer = setTimeout(update, 2500);
        window.addEventListener(SESSIONS_CHANGED_EVENT, update);
        window.addEventListener("focus", update);
        window.addEventListener("storage", syncSeen);
        document.addEventListener("visibilitychange", update);
        return () => {
          disposed = true;
          clearTimeout(timer);
          window.removeEventListener(SESSIONS_CHANGED_EVENT, update);
          window.removeEventListener("focus", update);
          window.removeEventListener("storage", syncSeen);
          document.removeEventListener("visibilitychange", update);
        };
      }, [reloadSessions]);
      React.useEffect(() => {
        const update = () => void reloadWorkspaces();
        window.addEventListener(PROJECTS_CHANGED_EVENT, update);
        return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, update);
      }, [reloadWorkspaces]);
      const sessions = sessionState.rows
        .filter((session) => session.branchKind !== "side_chat")
        .slice()
        .sort((a, b) => {
          const left = pins.pins.indexOf(a.id),
            right = pins.pins.indexOf(b.id);
          return (left < 0 ? Infinity : left) - (right < 0 ? Infinity : right);
        })
        .filter(
          (session) =>
            !/^Reply exactly with legacy-message-\d+$/i.test(session.title),
        )
        .filter((session) =>
          displaySessionTitle(session.title)
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
        );
      const selectProject = (project) => {
        localStorage.setItem(WORKSPACE_PICK_KEY, project.id);
        window.dispatchEvent(
          new window.CustomEvent(HERO_WORKSPACE_EVENT, {
            detail: project.id,
          }),
        );
      };
      const toggleSearch = () => {
        if (searching) setQuery("");
        setSearching(!searching);
      };
      const beginAction = (kind, target) => {
        setAction({ kind, target });
        setActionValue(
          kind === "rename-project"
            ? displayWorkspaceName(target.name)
            : kind === "rename-session"
              ? displaySessionTitle(target.title)
              : "",
        );
        setError("");
      };
      const submitAction = async (event) => {
        event.preventDefault();
        if (!action) return;
        try {
          if (action.kind === "rename-project") {
            await request(
              `${apiRoot}/workspaces/${encodeURIComponent(action.target.id)}`,
              {
                method: "PATCH",
                body: JSON.stringify({ name: actionValue.trim() }),
              },
            );
            await reloadWorkspaces();
            announceProjectsChanged();
          } else if (action.kind === "rename-session") {
            await request(
              `${apiRoot}/sessions/${encodeURIComponent(action.target.id)}`,
              {
                method: "PATCH",
                body: JSON.stringify({ title: actionValue.trim() }),
              },
            );
            await reloadSessions();
          } else if (action.kind === "delete-session") {
            await request(
              `${apiRoot}/sessions/${encodeURIComponent(action.target.id)}`,
              { method: "DELETE" },
            );
            await reloadSessions();
            if (activeSession === action.target.id)
              navigation.navigate("/?frontend=dsh");
          } else if (action.kind === "delete-project") {
            const relatedSessions = sessionState.rows.filter(
              (session) => session.workspaceId === action.target.id,
            );
            const relatedTeams = teamState.rows.filter(
              (team) => team.workspaceId === action.target.id,
            );
            await Promise.all(
              relatedSessions.map((session) =>
                request(
                  `${apiRoot}/sessions/${encodeURIComponent(session.id)}`,
                  { method: "DELETE" },
                ),
              ),
            );
            await Promise.all(
              relatedTeams.map((team) =>
                request(`${apiRoot}/teams/${encodeURIComponent(team.id)}`, {
                  method: "DELETE",
                }),
              ),
            );
            await request(
              `${apiRoot}/workspaces/${encodeURIComponent(action.target.id)}`,
              { method: "DELETE" },
            );
            await Promise.all([
              reloadWorkspaces(),
              reloadSessions(),
              reloadTeams(),
            ]);
            announceProjectsChanged();
            if (relatedSessions.some((session) => session.id === activeSession))
              navigation.navigate("/?frontend=dsh");
          }
          setAction(null);
        } catch (cause) {
          setError(friendlyError(cause.message));
        }
      };
      const projectRows = workspaceState.rows
        .slice()
        .sort((left, right) =>
          left.scope === right.scope ? 0 : left.scope === "team" ? 1 : -1,
        );
      const projectIds = new Set(projectRows.map((project) => project.id));
      const unassignedSessions = sessions.filter(
        (session) => !projectIds.has(session.workspaceId),
      );
      const renderSession = (session) => {
        const running = ["running", "retrying"].includes(
          session.activity?.state,
        );
        const unread =
          session.lastTurn &&
          localStorage.getItem(SESSION_SEEN_PREFIX + session.id) !==
            session.lastTurn.id;
        const status = running
          ? "正在运行"
          : unread
            ? session.lastTurn.status === "failed"
              ? "运行失败，未读"
              : session.lastTurn.status === "cancelled"
                ? "已停止，未读"
                : "已完成，未读"
            : "";
        return h(
          "div",
          {
            className: "workagent-sidebar-session",
            key: session.id,
            draggable: pins.pins.includes(session.id),
            onDragStart: (event) =>
              event.dataTransfer.setData("text/workagent-session", session.id),
            onDragOver: (event) => {
              if (pins.pins.includes(session.id)) event.preventDefault();
            },
            onDrop: (event) => {
              event.preventDefault();
              pins.move(
                event.dataTransfer.getData("text/workagent-session"),
                session.id,
              );
            },
          },
          batchMode
            ? h("input", {
                type: "checkbox",
                "aria-label": `选择对话 ${displaySessionTitle(session.title)}`,
                checked: selectedIds.includes(session.id),
                disabled: batchBusy,
                onChange: (event) =>
                  setSelectedIds((ids) =>
                    event.target.checked
                      ? [...ids, session.id]
                      : ids.filter((id) => id !== session.id),
                  ),
              })
            : null,
          h(
            "button",
            {
              type: "button",
              className: "workagent-row-action",
              "aria-label": `${pins.pins.includes(session.id) ? "取消置顶" : "置顶"} ${displaySessionTitle(session.title)}`,
              "aria-pressed": pins.pins.includes(session.id),
              onClick: () => pins.toggle(session.id),
            },
            h(Icon, { name: "pin", size: 14 }),
          ),
          h(
            "button",
            {
              type: "button",
              className:
                session.id === activeSession ? "is-active is-main" : "is-main",
              "aria-current": session.id === activeSession ? "page" : undefined,
              onClick: () => {
                markSeen(session);
                navigation.navigate(
                  `/?session=${encodeURIComponent(session.id)}`,
                );
              },
            },
            h(EngineMark, { engine: session.engine }),
            h(
              "span",
              { className: "workagent-session-title" },
              displaySessionTitle(session.title),
            ),
            status
              ? h("span", {
                  className: `workagent-session-status ${running ? "is-running" : "is-unread"}`,
                  role: "img",
                  "aria-label": status,
                  title: status,
                })
              : null,
          ),
          h(
            "button",
            {
              type: "button",
              className: "workagent-row-action",
              "aria-label": `编辑对话 ${displaySessionTitle(session.title)}`,
              title: "重命名或删除对话",
              onClick: () => beginAction("rename-session", session),
            },
            "•••",
          ),
        );
      };
      return h(
        "div",
        { className: "workagent-sidebar-browser" },
        h(workbench.Notifications, {
          sessions: sessionState.rows,
          settings: false,
        }),
        h("button", {
          type: "button",
          className: "workagent-mobile-backdrop",
          "aria-label": "收起导航菜单",
          tabIndex: -1,
          onClick: closeMobileSidebar,
        }),
        h(
          "div",
          { className: "workagent-sidebar-heading" },
          sectionToggle("projects", "项目"),
          h(
            "div",
            { className: "workagent-batch-actions" },
            h(
              Button,
              {
                disabled: batchBusy,
                "aria-label": batchMode ? "结束多选" : "多选对话",
                title: batchMode ? "结束多选" : "多选对话",
                "aria-pressed": batchMode,
                onClick: () => {
                  setBatchMode((value) => !value);
                  setSelectedIds([]);
                  setBatchError("");
                },
              },
              h(Icon, { name: batchMode ? "close" : "list", size: 15 }),
            ),
            batchMode
              ? h(
                  React.Fragment,
                  null,
                  h(
                    Button,
                    {
                      disabled: batchBusy,
                      onClick: () =>
                        setSelectedIds(sessions.map((row) => row.id)),
                    },
                    "全选当前列表",
                  ),
                  h(
                    Button,
                    {
                      disabled: batchBusy || !selectedIds.length,
                      onClick: deleteSelected,
                    },
                    batchBusy ? "删除中…" : `删除选中（${selectedIds.length}）`,
                  ),
                )
              : null,
            batchError
              ? h(
                  "p",
                  { role: "alert", className: "workagent-error" },
                  batchError,
                )
              : null,
          ),

          sectionsCollapsed.projects
            ? null
            : h(
                "div",
                { className: "workagent-sidebar-heading-actions" },
                h(
                  "button",
                  {
                    type: "button",
                    "aria-label": searching ? "关闭搜索" : "搜索对话",
                    title: searching ? "关闭搜索" : "搜索对话",
                    "aria-pressed": searching,
                    onClick: toggleSearch,
                  },
                  h(Icon, { name: searching ? "close" : "search", size: 15 }),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    "aria-label": "管理项目",
                    title: "管理项目",
                    onClick: () =>
                      navigation.navigate("/?workagent=workspaces"),
                  },
                  h(Icon, { name: "plus", size: 15 }),
                ),
              ),
        ),
        searching
          ? h(Input, {
              className: "workagent-sidebar-search",
              "aria-label": "搜索对话",
              value: query,
              onChange: (event) => setQuery(event.target.value),
              placeholder: "搜索对话…",
              autoFocus: true,
            })
          : null,
        h(
          "div",
          { className: "workagent-sidebar-projects" },
          workspaceState.loading && !sectionsCollapsed.projects
            ? h("span", { className: "workagent-sidebar-empty" }, "加载中…")
            : null,
          ...(sectionsCollapsed.projects ? [] : projectRows).map((project) => {
            const projectSessions = sessions.filter(
              (session) => session.workspaceId === project.id,
            );
            const isCollapsed = Boolean(collapsed[project.id]);
            return h(
              "section",
              { className: "workagent-sidebar-project", key: project.id },
              h(
                "div",
                { className: "workagent-sidebar-project-row" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "is-main",
                    "aria-expanded": !isCollapsed,
                    onClick: () => {
                      selectProject(project);
                      setCollapsed((value) => ({
                        ...value,
                        [project.id]: !value[project.id],
                      }));
                    },
                  },
                  h(Icon, {
                    name: isCollapsed ? "chevronRight" : "chevronDown",
                    size: 13,
                  }),
                  h(Icon, { name: "workspace", size: 15 }),
                  h("span", null, displayWorkspaceName(project.name)),
                  project.scope === "team" ? h("small", null, "共享") : null,
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "workagent-row-action",
                    "aria-label": `在 ${displayWorkspaceName(project.name)} 中新建会话`,
                    title: "在此项目中新建会话",
                    onClick: () => startProjectConversation(project),
                  },
                  h(Icon, { name: "plus", size: 14 }),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "workagent-row-action",
                    "aria-label": `编辑项目 ${displayWorkspaceName(project.name)}`,
                    title: "重命名或删除项目",
                    onClick: () => beginAction("rename-project", project),
                  },
                  "•••",
                ),
              ),
              !isCollapsed
                ? h(
                    "div",
                    { className: "workagent-sidebar-project-sessions" },
                    projectSessions.length === 0
                      ? h(
                          "span",
                          { className: "workagent-sidebar-empty" },
                          query ? "没有匹配的对话" : "暂无对话",
                        )
                      : projectSessions.map(renderSession),
                  )
                : null,
            );
          }),
          h(
            "section",
            { className: "workagent-sidebar-unassigned" },
            h(
              "div",
              { className: "workagent-sidebar-subheading" },
              sectionToggle("sessions", "对话"),
            ),
            sectionsCollapsed.sessions
              ? null
              : h(
                  "div",
                  {
                    className:
                      "workagent-sidebar-project-sessions workagent-sidebar-standalone",
                  },
                  ...unassignedSessions.map(renderSession),
                ),
          ),
        ),
        sessionState.loading && !sectionsCollapsed.sessions
          ? h("span", { className: "workagent-sidebar-empty" }, "加载中…")
          : null,
        error
          ? h("span", { role: "alert", className: "workagent-error" }, error)
          : null,
        action
          ? h(
              "div",
              { className: "workagent-dialog-backdrop", role: "presentation" },
              h(
                "form",
                {
                  className: "workagent-dialog",
                  role: "dialog",
                  "aria-modal": true,
                  "aria-label": action.kind.includes("delete")
                    ? "确认删除"
                    : "重命名",
                  onSubmit: submitAction,
                },
                h(
                  "strong",
                  null,
                  action.kind.startsWith("rename") ? "重命名" : "确认删除",
                ),
                action.kind.startsWith("rename")
                  ? h(Input, {
                      autoFocus: true,
                      value: actionValue,
                      onChange: (event) => setActionValue(event.target.value),
                      required: true,
                      maxLength: 120,
                    })
                  : h(
                      "p",
                      null,
                      action.kind === "delete-project"
                        ? "项目及其对话将移入可恢复的回收目录。"
                        : "删除后，这个对话将不再显示。",
                    ),
                h(
                  "div",
                  { className: "workagent-actions" },
                  h(
                    Button,
                    {
                      type: "submit",
                      disabled:
                        action.kind.startsWith("rename") && !actionValue.trim(),
                    },
                    action.kind.startsWith("rename") ? "保存" : "删除",
                  ),
                  action.kind.startsWith("rename")
                    ? h(
                        Button,
                        {
                          className: "workagent-button is-danger",
                          onClick: () =>
                            beginAction(
                              action.kind === "rename-project"
                                ? "delete-project"
                                : "delete-session",
                              action.target,
                            ),
                        },
                        "删除",
                      )
                    : null,
                  h(Button, { onClick: () => setAction(null) }, "取消"),
                ),
              ),
            )
          : null,
      );
    }

    let conversationSettings;
    function useBusyEnter() {
      return React.useSyncExternalStore(
        (listener) => conversationSettings.subscribe(listener),
        () =>
          conversationSettings.getSnapshot().value?.busyEnter === "steer"
            ? "steer"
            : "queue",
      );
    }
    function BusyEnterSettings() {
      const behavior = useBusyEnter();
      return h(
        "div",
        { className: "workagent-busy-setting" },
        h(
          "div",
          null,
          h("strong", null, "任务运行时的发送方式"),
          h(
            "p",
            { className: "workagent-muted" },
            "发送按钮和 Enter 使用此设置；Ctrl/Cmd + Enter 临时使用另一种方式。",
          ),
        ),
        h(Select, {
          "aria-label": "任务运行时的发送方式",
          value: behavior,
          onChange: (event) =>
            conversationSettings.set("busyEnter", event.target.value),
          options: [
            ["queue", "排队发送"],
            ["steer", "立即追加"],
          ],
        }),
      );
    }

    const RuntimeServices = React.createContext(null);
    const standardSessionApi = (ctx) => ctx.connection?.api?.sessions;
    const hasStandardSessions = (ctx) =>
      Boolean(ctx.sessions?.binding && standardSessionApi(ctx));
    const rpcValue = (response) => {
      const result = response.result ?? response;
      if (!result.ok)
        throw new Error(
          result.error?.message ||
            result.error?.code ||
            "session_request_failed",
        );
      return result.value;
    };
    async function nativeSessionAction(ctx, sessionId, action, ...args) {
      const session = ctx.sessions.binding(sessionId)?.session;
      if (typeof session?.[action] === "function")
        return rpcValue(await session[action](...args));
      const api = standardSessionApi(ctx);
      const payload =
        action === "prompt"
          ? { sessionId, content: args[0], mode: args[1] }
          : action === "updateQueue"
            ? { sessionId, itemId: args[0], action: args[1] }
            : action === "selectModel"
              ? { sessionId, ...args[0] }
              : { sessionId };
      return rpcValue(await api[action](payload));
    }
    function useNativeConversation(ctx, sessionId, enabled) {
      const [state, setState] = React.useState(() => ({
        value: conversationCache.get(sessionId, "native"),
        loading: !conversationCache.get(sessionId, "native"),
        error: "",
      }));
      const refresh = React.useRef(async () => {});
      const reload = React.useCallback(() => refresh.current(), []);
      React.useEffect(() => {
        if (!enabled) return;
        let disposed = false;
        let revision = 0;
        let generation = 0;
        let requestController;
        let binding;
        let stopProjection = () => {};
        const accept = (value) => {
          if (disposed || !value) return;
          revision += 1;
          conversationCache.set(sessionId, "native", value);
          setState({ value, loading: false, error: "" });
        };
        const bind = () => {
          const next = ctx.sessions.binding(sessionId);
          if (!next || next === binding) return;
          binding = next;
          stopProjection();
          const face = next.session.projections.faceOf("nativeSession");
          accept(face.getSnapshot());
          stopProjection = face.subscribe(() => accept(face.getSnapshot()));
        };
        const load = async () => {
          const currentGeneration = ++generation;
          const before = revision;
          requestController?.abort();
          const controller = new AbortController();
          requestController = controller;
          try {
            const value = rpcValue(
              await standardSessionApi(ctx).history(
                { sessionId },
                controller.signal,
              ),
            ).projections?.values?.nativeSession;
            if (
              disposed ||
              controller.signal.aborted ||
              generation !== currentGeneration ||
              revision !== before
            )
              return;
            if (!value)
              throw new Error("native_session_projection_unavailable");
            accept(value);
          } catch (error) {
            if (
              !disposed &&
              !controller.signal.aborted &&
              generation === currentGeneration
            )
              setState((current) => ({
                ...current,
                loading: false,
                error: error.message,
              }));
          }
        };
        refresh.current = load;
        bind();
        const stopList = ctx.sessions.list.subscribe(bind);
        const stopReset = ctx.on("connection/reset", () => {
          bind();
          void load();
        });
        void load();
        return () => {
          disposed = true;
          requestController?.abort();
          stopProjection();
          stopList();
          stopReset();
          refresh.current = async () => {};
        };
      }, [sessionId, enabled]);
      return { ...state, reload };
    }

    function RuntimeConversation({
      sessionId,
      side = false,
      onSideChat,
      sideHeader,
    }) {
      const busyEnter = useBusyEnter();
      const submitGesture = React.useRef(false);
      const id = encodeURIComponent(sessionId);
      const [sessionState] = useResource(`${apiRoot}/sessions/${id}`);
      const ctx = React.useContext(RuntimeServices);
      const standard = hasStandardSessions(ctx);
      const native =
        standard && ["codex", "kimi"].includes(sessionState.rows[0]?.engine);
      const legacy = !standard || sessionState.rows[0]?.engine === "harness";
      const nativeState = useNativeConversation(ctx, sessionId, native);
      const [legacyQueueState, reloadQueue] = useResource(
        legacy ? `${apiRoot}/sessions/${id}/queue` : null,
      );
      const [legacyMessageState, reloadMessages] = useResource(
        legacy ? `${apiRoot}/sessions/${id}/messages` : null,
      );
      const messageState = native
        ? {
            loading: nativeState.loading,
            rows: nativeState.value?.messages ?? [],
          }
        : legacyMessageState;
      const messageList = React.useRef(null);
      const restoredScroll = React.useRef(false);
      React.useLayoutEffect(() => {
        if (messageState.loading || restoredScroll.current) return;
        const list = messageList.current;
        if (!list) return;
        const saved = conversationCache.get(sessionId, "scroll");
        if (saved !== undefined) list.scrollTop = saved;
        restoredScroll.current = true;
      }, [sessionId, messageState.loading]);
      const queueState = native
        ? { rows: nativeState.value?.metadata?.queue ?? [] }
        : legacyQueueState;
      const [input, setInput] = workbench.useDraft(
        sessionId,
        sessionState.rows[0]?.id === sessionId,
      );
      const historyCursor = React.useRef({ index: -1, saved: "" });
      const [draft, setDraft] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [progress, setProgress] = React.useState("");
      const [error, setError] = React.useState("");
      const [submitting, setSubmitting] = React.useState(false);
      const [forkTarget, setForkTarget] = React.useState(null);
      const [attachmentsBusy, setAttachmentsBusy] = React.useState(false);
      const [editing, setEditing] = React.useState(null);
      const [editContent, setEditContent] = React.useState("");
      const session = native
        ? { ...sessionState.rows[0], ...nativeState.value?.metadata }
        : sessionState.rows[0];
      const activityRevision = React.useRef(0);
      React.useEffect(() => {
        if (!native) return;
        const value = nativeState.value;
        if (value) {
          setBusy(value.activity.state !== "idle");
          setDraft(value.draft || "");
          setProgress(
            value.activity.state === "retrying"
              ? "模型服务暂不可用，正在自动重试…"
              : value.activeTool
                ? "正在执行工具…"
                : value.progress || "",
          );
          if (value.activity.message)
            setError(friendlyError(value.activity.message));
          else if (value.lastEvent?.type === "turn.started") setError("");
          if (
            [
              "turn.started",
              "turn.retrying",
              "turn.completed",
              "turn.failed",
              "turn.cancelled",
              "session.metadata",
            ].includes(value.lastEvent?.type)
          )
            window.dispatchEvent(new window.Event(SESSIONS_CHANGED_EVENT));
        }
        if (nativeState.error) setError(friendlyError(nativeState.error));
      }, [native, nativeState.value, nativeState.error]);
      const syncActivity = React.useCallback(async () => {
        if (native) return nativeState.reload();
        if (!legacy) return;
        const revision = activityRevision.current;
        try {
          const current = await request(`${apiRoot}/sessions/${id}`);
          if (revision !== activityRevision.current || !current.activity)
            return;
          void reloadQueue();
          const active = current.activity.state !== "idle";
          setBusy(active);
          setProgress(
            current.activity.state === "retrying"
              ? "模型服务暂不可用，正在自动重试…"
              : "",
          );
          if (!active) {
            setDraft("");
            if (current.activity.message)
              setError(friendlyError(current.activity.message));
            void reloadMessages();
          }
        } catch {
          setProgress("连接中断，正在重新连接…");
        }
      }, [id, reloadMessages, native, legacy, nativeState.reload]);

      React.useEffect(() => {
        if (!busy || !legacy) return;
        const timer = setInterval(() => void syncActivity(), 5000);
        return () => clearInterval(timer);
      }, [busy, syncActivity, legacy]);

      React.useEffect(() => {
        if (!legacy || typeof EventSource === "undefined") return undefined;
        const stream = new EventSource(`${apiRoot}/sessions/${id}/events`);
        stream.onopen = () => void syncActivity();
        stream.onmessage = (event) => {
          let value;
          try {
            value = JSON.parse(event.data);
          } catch {
            return;
          }
          activityRevision.current += 1;
          if (
            [
              "turn.started",
              "turn.retrying",
              "turn.completed",
              "turn.failed",
              "turn.cancelled",
            ].includes(value.type)
          )
            window.dispatchEvent(new window.Event(SESSIONS_CHANGED_EVENT));
          if (value.type === "turn.started") {
            setBusy(true);
            setProgress("");
            setError("");
          }
          if (value.type === "turn.retrying") {
            setBusy(true);
            setProgress(
              /high demand|overloaded/i.test(value.message || "")
                ? "模型服务繁忙，正在自动重试…"
                : "模型连接暂时中断，正在自动重试…",
            );
          }
          if (value.type === "assistant.delta") {
            setProgress("");
            setDraft((current) => current + (value.delta || ""));
          }
          if (value.type === "tool.started") setProgress("正在执行工具…");
          if (value.type === "tool.completed") setProgress("");
          if (value.type === "assistant.completed") {
            setDraft("");
            void reloadMessages();
          }
          if (value.type === "queue.changed") void reloadQueue();
          if (value.type === "message.created") void reloadMessages();
          if (value.type === "turn.completed") {
            setBusy(false);
            setDraft("");
            setProgress("");
            void reloadMessages();
          }
          if (value.type === "turn.failed") {
            setBusy(false);
            setDraft("");
            setError(friendlyError(value.message));
            void reloadMessages();
          }
          if (value.type === "turn.cancelled") {
            setBusy(false);
            setDraft("");
          }
        };
        stream.onerror = () => {
          setProgress("连接中断，正在重新连接…");
          void syncActivity();
        };
        return () => stream.close();
      }, [id, legacy]);

      const send = async (event) => {
        event.preventDefault();
        const accelerated = submitGesture.current;
        submitGesture.current = false;
        const content = input.trim();
        if (!content || submitting || attachmentsBusy) return;
        if (!side && /^\/?btw(?:\s|$)/i.test(content)) {
          setSubmitting(true);
          try {
            await onSideChat(content.replace(/^\/?btw\s*/i, ""));
            setInput("");
          } catch (cause) {
            setError(friendlyError(cause.message));
          } finally {
            setSubmitting(false);
          }
          return;
        }
        const behavior = accelerated
          ? busyEnter === "queue"
            ? "steer"
            : "queue"
          : busyEnter;
        const queued = busy && behavior === "queue";
        const steering = busy && !queued;
        setSubmitting(true);
        activityRevision.current += 1;
        setBusy(true);
        setProgress("");
        if (!busy) setDraft("");
        setError("");
        setInput("");
        try {
          if (native)
            await nativeSessionAction(
              ctx,
              sessionId,
              "prompt",
              [{ type: "text", text: content }],
              steering ? "steer" : "queue",
            );
          else
            await request(
              `${apiRoot}/sessions/${id}/${queued ? "queue" : steering ? "steer" : "turns"}`,
              {
                method: "POST",
                body: JSON.stringify({
                  content,
                  messageId: `message-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                }),
              },
            );
          void reloadMessages();
          void reloadQueue();
        } catch (cause) {
          setInput(content);
          if (!busy) setBusy(false);
          setError(friendlyError(cause.message));
          void syncActivity();
        } finally {
          setSubmitting(false);
        }
      };
      const updateQueue = async (messageId, action) => {
        if (submitting) return;
        setSubmitting(true);
        setError("");
        try {
          if (native && action !== "send")
            await nativeSessionAction(
              ctx,
              sessionId,
              "updateQueue",
              messageId,
              { kind: action },
            );
          else
            await request(`${apiRoot}/sessions/${id}/queue`, {
              method: "POST",
              body: JSON.stringify({ messageId, action }),
            });
          void reloadMessages();
          void syncActivity();
        } catch (cause) {
          setError(friendlyError(cause.message));
        } finally {
          void reloadQueue();
          setSubmitting(false);
        }
      };
      const fork = async (messageId, replacementContent, confirmed = false) => {
        if (!confirmed && window.matchMedia("(max-width: 760px)").matches) {
          setForkTarget({ messageId, replacementContent });
          return;
        }
        if (submitting) return;
        setSubmitting(true);
        setError("");
        try {
          const branch = await request(`${apiRoot}/sessions/${id}/fork`, {
            method: "POST",
            body: JSON.stringify({ messageId, replacementContent }),
          });
          navigation.navigate(
            `/?frontend=dsh&session=${encodeURIComponent(branch.id)}`,
          );
        } catch (cause) {
          setError(friendlyError(cause.message));
        } finally {
          setSubmitting(false);
        }
      };
      const cancel = async () => {
        try {
          if (native) await nativeSessionAction(ctx, sessionId, "cancel");
          else
            await request(`${apiRoot}/sessions/${id}/cancel`, {
              method: "POST",
            });
          activityRevision.current += 1;
          setProgress("正在停止…");
          void syncActivity();
        } catch (cause) {
          setError(friendlyError(cause.message));
        }
      };

      return h(
        "section",
        { className: `workagent-conversation${side ? " is-side-chat" : ""}` },
        forkTarget
          ? h(
              "dialog",
              {
                className: "workagent-fork-dialog",
                ref: (node) => {
                  if (node && !node.open) node.showModal();
                },
                "aria-labelledby": "workagent-fork-heading",
                onCancel: () => setForkTarget(null),
                onClick: (event) => {
                  if (event.target === event.currentTarget) setForkTarget(null);
                },
              },
              h(
                "div",
                { className: "workagent-fork-content" },
                h(Icon, { name: "branch", size: 28 }),
                h("h2", { id: "workagent-fork-heading" }, "从这里创建分支？"),
                h(
                  "p",
                  null,
                  "将保留到这条消息为止的上下文，在新对话中继续探索。当前对话会保留。",
                ),
                h(
                  "div",
                  { className: "workagent-actions" },
                  h(
                    Button,
                    { autoFocus: true, onClick: () => setForkTarget(null) },
                    "继续当前对话",
                  ),
                  h(
                    Button,
                    {
                      className: "workagent-button is-primary",
                      onClick: () => {
                        const target = forkTarget;
                        setForkTarget(null);
                        void fork(
                          target.messageId,
                          target.replacementContent,
                          true,
                        );
                      },
                    },
                    "创建分支",
                  ),
                ),
              ),
            )
          : null,
        side
          ? sideHeader
          : h(
              "header",
              { className: "workagent-conversation-title" },
              session ? h(EngineMark, { engine: session.engine }) : null,
              h(
                "div",
                null,
                h(
                  "strong",
                  null,
                  session
                    ? displaySessionTitle(session.title)
                    : "正在加载会话…",
                ),
                session
                  ? h(
                      "span",
                      null,
                      `${displayPresetName(session.preset?.resolvedSnapshot?.name || session.preset?.presetId || session.engine)} · 当前会话`,
                    )
                  : null,
              ),
            ),
        h(
          "div",
          {
            className: "workagent-message-list",
            "aria-live": "polite",
            ref: messageList,
            onScroll: (event) =>
              conversationCache.set(
                sessionId,
                "scroll",
                event.currentTarget.scrollTop,
              ),
          },
          h(ConversationMessageTarget, { sessionId }),
          messageState.loading
            ? h("p", { className: "workagent-muted" }, "正在加载消息…")
            : messageState.rows.length === 0 && !draft
              ? h(
                  "div",
                  { className: "workagent-conversation-empty" },
                  side
                    ? h(
                        "div",
                        { className: "workagent-side-empty-icon" },
                        h(Icon, { name: "chatgpt", size: 24 }),
                      )
                    : null,
                  h("strong", null, side ? "顺便问一句" : "从这里继续对话"),
                  h(
                    "span",
                    null,
                    side
                      ? "另开一个话题，和主对话分开记录。"
                      : "消息和回复会保存在当前对话中。",
                  ),
                )
              : null,
          ...messageState.rows.map((message) =>
            h(
              "article",
              {
                key: message.id,
                className: `workagent-message is-${message.role}`,
                "data-message-id": message.id,
              },
              message.role === "assistant"
                ? h(EngineMark, { engine: session?.engine || "harness" })
                : null,
              h(Markdown, { workspaceId: session?.workspaceId }, message.text),
              h(MessageActions, {
                message,
                disabled: submitting,
                onEdit:
                  message.role === "user" && !side
                    ? () => {
                        setEditing(message.id);
                        setEditContent(message.text);
                      }
                    : undefined,
                onFork:
                  message.role === "assistant" && !side
                    ? () => void fork(message.id)
                    : undefined,
              }),
              editing === message.id
                ? h(
                    "form",
                    {
                      className: "workagent-message-editor",
                      onSubmit: (event) => {
                        event.preventDefault();
                        if (editContent.trim())
                          void fork(message.id, editContent.trim());
                      },
                    },
                    h("textarea", {
                      "aria-label": "编辑消息",
                      autoFocus: true,
                      value: editContent,
                      onChange: (event) => setEditContent(event.target.value),
                      onKeyDown: submitComposerOnEnter,
                    }),
                    h(
                      "small",
                      null,
                      `${busy ? "运行中的原任务会先停止。" : ""}从这条消息前重新继续，原会话保留。此操作不会回滚已修改的文件。`,
                    ),
                    h(
                      "div",
                      { className: "workagent-actions" },
                      h(
                        Button,
                        {
                          type: "submit",
                          disabled: submitting || !editContent.trim(),
                        },
                        submitting ? "正在重发…" : "保存并重发",
                      ),
                      h(
                        Button,
                        {
                          disabled: submitting,
                          onClick: () => setEditing(null),
                        },
                        "取消编辑",
                      ),
                    ),
                  )
                : null,
            ),
          ),
          h(workbench.Tools, {
            tools: nativeState.value?.tools,
            workspaceId: session?.workspaceId,
          }),
          h(workbench.Artifacts, {
            sessionId: id,
            workspaceId: session?.workspaceId,
            revision: messageState.rows.length,
          }),
          h(workbench.Process, { items: nativeState.value?.processes }),
          draft
            ? h(
                "article",
                { className: "workagent-message is-assistant is-streaming" },
                h(EngineMark, { engine: session?.engine || "harness" }),
                h(
                  Markdown,
                  { workspaceId: session?.workspaceId, streaming: true },
                  draft,
                ),
              )
            : busy
              ? h(
                  "div",
                  {
                    className: "workagent-thinking",
                    role: "status",
                    "aria-live": "polite",
                  },
                  h("span", null),
                  h("span", null),
                  h("span", null),
                  progress || "正在思考",
                )
              : null,
        ),
        h(
          ComposerForm,
          { className: "workagent-conversation-composer", onSubmit: send },
          queueState.rows.length
            ? h(
                "div",
                {
                  className: "workagent-message-queue",
                  "aria-label": "待发送消息",
                },
                h("small", null, `排队消息（${queueState.rows.length}）`),
                ...queueState.rows.map((row) =>
                  h(
                    "div",
                    {
                      key: row.messageId,
                      className: "workagent-queued-message",
                    },
                    h(
                      "div",
                      null,
                      h("span", null, row.content),
                      row.error
                        ? h(
                            "small",
                            { className: "workagent-error" },
                            friendlyError(row.error),
                          )
                        : null,
                    ),
                    h(
                      Button,
                      {
                        className: "workagent-queue-icon",
                        "aria-label": busy ? "立即追加" : "发送排队消息",
                        title: busy ? "立即追加到当前任务" : "发送这条消息",
                        disabled: submitting,
                        onClick: () =>
                          void updateQueue(
                            row.messageId,
                            busy ? "steer" : "send",
                          ),
                      },
                      h(Icon, { name: busy ? "steer" : "send" }),
                    ),
                    h(
                      Button,
                      {
                        className: "workagent-queue-icon",
                        "aria-label": "移除排队消息",
                        title: "移除排队消息",
                        disabled: submitting,
                        onClick: () =>
                          void updateQueue(row.messageId, "remove"),
                      },
                      h(Icon, { name: "close" }),
                    ),
                  ),
                ),
              )
            : null,
          h(workbench.ComposerTools, {
            onBusyChange: setAttachmentsBusy,
            key: sessionId,
            session,
            input,
            setInput,
            onError: setError,
            disabled: submitting,
          }),
          h(ComposerInput, {
            "aria-label": side ? "侧聊消息" : "继续对话",
            disabled: sessionState.rows[0]?.id !== sessionId,
            value: input,
            onChange: (event) => setInput(event.target.value),
            onKeyDown: (event) => {
              const cursor = historyCursor.current;
              const history = messageState.rows
                .filter((row) => row.role === "user")
                .map((row) => row.text)
                .reverse();
              if (
                event.altKey &&
                ["ArrowUp", "ArrowDown"].includes(event.key)
              ) {
                event.preventDefault();
                if (cursor.index === -1) cursor.saved = input;
                cursor.index = Math.max(
                  -1,
                  Math.min(
                    history.length - 1,
                    cursor.index + (event.key === "ArrowUp" ? 1 : -1),
                  ),
                );
                setInput(
                  cursor.index === -1 ? cursor.saved : history[cursor.index],
                );
                return;
              }
              submitComposerOnEnter(event, () => {
                submitGesture.current = event.ctrlKey || event.metaKey;
              });
            },
            title: "Alt + ↑/↓ 浏览历史输入；Shift + Enter 换行",
            placeholder: busy
              ? busyEnter === "queue"
                ? "输入消息…"
                : "输入补充指令，调整当前任务…"
              : side
                ? "顺便问一句…"
                : "继续聊聊…",
          }),
          h(
            "div",
            { className: "workagent-conversation-composer-bar" },
            h(workbench.Controls, { ctx, session, busy, cancel }),
            error
              ? h(
                  "span",
                  { role: "alert", className: "workagent-error" },
                  error,
                )
              : busy
                ? h(
                    "span",
                    { className: "workagent-muted" },
                    busyEnter === "queue"
                      ? "消息将排队，当前任务完成后发送"
                      : session?.engine === "kimi"
                        ? "补充指令会停止当前生成，再继续执行"
                        : "补充指令会送入当前任务",
                  )
                : null,
            busy
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "workagent-composer-icon",
                    "aria-label": "停止",
                    title: "停止当前任务",
                    onClick: () => void cancel(),
                  },
                  h(Icon, { name: "stop", size: 20 }),
                )
              : null,
            h(
              "button",
              {
                type: "submit",
                className: "workagent-composer-icon",
                "aria-label": "发送",
                title: submitting
                  ? "提交中…"
                  : busy
                    ? busyEnter === "queue"
                      ? "排队发送"
                      : "立即追加"
                    : "发送",
                disabled: !input.trim() || submitting || attachmentsBusy,
              },
              h(Icon, { name: "send", size: 20 }),
            ),
          ),
        ),
      );
    }

    function ConversationWorkspace({ sessionId }) {
      const ctx = React.useContext(RuntimeServices);
      const workspaceRef = React.useRef(null);
      const [workspaceWidth, setWorkspaceWidth] = React.useState(0);
      const [sideWidth, setSideWidth] = React.useState(
        () => Number(localStorage.getItem("workagent.side-chat.width")) || null,
      );
      React.useLayoutEffect(() => {
        const workspace = workspaceRef.current;
        const measure = () =>
          setWorkspaceWidth(workspace.getBoundingClientRect().width);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(workspace);
        return () => observer.disconnect();
      }, []);
      // Reserve 360px for the main chat and 24px for the drag handle.
      const sideMaxWidth = Math.max(320, workspaceWidth - 384);
      const visibleSideWidth = Math.max(
        320,
        Math.min(
          sideMaxWidth,
          sideWidth ?? Math.min(520, workspaceWidth * 0.38),
        ),
      );
      const resizeSideWidth = (value) => {
        const next = Math.max(320, Math.min(sideMaxWidth, Math.round(value)));
        setSideWidth(next);
        localStorage.setItem("workagent.side-chat.width", String(next));
      };
      const [sideId, setSideId] = React.useState(() =>
        localStorage.getItem(`workagent.side-chat.${sessionId}`),
      );
      const [opening, setOpening] = React.useState(false);
      const [sideError, setSideError] = React.useState("");
      const [deleteTarget, setDeleteTarget] = React.useState(null);
      const [deleting, setDeleting] = React.useState(false);
      const deletingRef = React.useRef(false);
      const openingRef = React.useRef(false);
      const [sideState, reloadSides] = useResource(
        `${apiRoot}/sessions`,
        (rows) =>
          (Array.isArray(rows) ? rows : []).filter(
            (row) =>
              row.parentSessionId === sessionId &&
              row.branchKind === "side_chat",
          ),
      );
      React.useEffect(() => {
        if (
          !sideId ||
          sideState.loading ||
          sideState.error ||
          opening ||
          deleting
        )
          return;
        if (!sideState.rows.some((row) => row.id === sideId)) {
          setSideId(null);
          localStorage.removeItem(`workagent.side-chat.${sessionId}`);
        }
      }, [sideId, sideState, opening, deleting, sessionId]);
      const deleteSideChat = async (event) => {
        event.preventDefault();
        if (!deleteTarget || deletingRef.current) return;
        deletingRef.current = true;
        setDeleting(true);
        setSideError("");
        try {
          await request(
            `${apiRoot}/sessions/${encodeURIComponent(deleteTarget)}`,
            { method: "DELETE" },
          );
          setSideId(null);
          localStorage.removeItem(`workagent.side-chat.${sessionId}`);
          setDeleteTarget(null);
          await reloadSides();
        } catch (error) {
          setSideError(friendlyError(error.message));
        } finally {
          deletingRef.current = false;
          setDeleting(false);
        }
      };
      const openSideChat = async (content = "", fresh = false) => {
        if (openingRef.current) throw new Error("正在打开侧聊，请稍候");
        if (deletingRef.current || deleteTarget)
          throw new Error("请先完成侧聊删除操作");
        openingRef.current = true;
        setOpening(true);
        try {
          let target = fresh ? undefined : sideId;
          if (!target) {
            const result = await request(
              `${apiRoot}/sessions/${encodeURIComponent(sessionId)}/side-chat`,
              {
                method: "POST",
                body: "{}",
              },
            );
            target = result.id;
            await reloadSides();
          }
          setSideId(target);
          localStorage.setItem(`workagent.side-chat.${sessionId}`, target);
          if (content) {
            const current = await request(
              `${apiRoot}/sessions/${encodeURIComponent(target)}`,
            );
            if (
              hasStandardSessions(ctx) &&
              ["codex", "kimi"].includes(current.engine)
            )
              await nativeSessionAction(
                ctx,
                target,
                "prompt",
                [{ type: "text", text: content }],
                current.activity?.state === "running" ||
                  current.activity?.state === "retrying"
                  ? "steer"
                  : "queue",
              );
            else
              await request(
                `${apiRoot}/sessions/${encodeURIComponent(target)}/${current.activity?.state === "running" || current.activity?.state === "retrying" ? "steer" : "turns"}`,
                {
                  method: "POST",
                  body: JSON.stringify({ content }),
                },
              );
          }
        } finally {
          openingRef.current = false;
          setOpening(false);
        }
      };
      return h(
        "div",
        {
          className: `workagent-conversation-workspace${sideId ? " has-side-chat" : ""}`,
          ref: workspaceRef,
          style: { "--workagent-side-chat-width": `${visibleSideWidth}px` },
        },
        h(RuntimeConversation, {
          key: sessionId,
          sessionId,
          onSideChat: openSideChat,
        }),
        opening
          ? h(
              "span",
              { role: "status", className: "workagent-side-opening" },
              "正在打开侧聊…",
            )
          : null,
        sideId
          ? h(ResizeHandle, {
              orientation: "vertical",
              label: "调整侧聊宽度",
              className: "workagent-side-resizer",
              value: visibleSideWidth,
              min: 320,
              max: Math.floor(sideMaxWidth),
              onChange: resizeSideWidth,
              measure: (event) => {
                const initial = event.clientX;
                const actualWidth =
                  event.currentTarget.nextElementSibling.getBoundingClientRect()
                    .width;
                return (move) => actualWidth + initial - move.clientX;
              },
            })
          : null,
        sideId
          ? h(
              "aside",
              { className: "workagent-side-chat", "aria-label": "侧聊 BTW" },
              h(RuntimeConversation, {
                key: sideId,
                sessionId: sideId,
                side: true,
                sideHeader: h(
                  "header",
                  {
                    className:
                      "workagent-conversation-title workagent-side-header",
                  },
                  h(
                    "div",
                    { className: "workagent-side-toolbar" },
                    h(
                      "div",
                      { className: "workagent-side-heading" },
                      h("strong", null, "侧聊"),
                      h("span", { className: "workagent-side-badge" }, "BTW"),
                    ),
                    h(
                      "nav",
                      {
                        className: "workagent-side-actions",
                        "aria-label": "侧聊操作",
                      },
                      h(
                        Button,
                        {
                          className: "workagent-side-action",
                          "aria-label": "新侧聊",
                          title: "新建侧聊",
                          disabled: opening || deleting,
                          onClick: () => {
                            setSideError("");
                            void openSideChat("", true).catch((error) =>
                              setSideError(friendlyError(error.message)),
                            );
                          },
                        },
                        h(Icon, { name: "plus", size: 17 }),
                      ),
                      h(
                        Button,
                        {
                          className: "workagent-side-action is-delete",
                          "aria-label": "删除侧聊",
                          title: "删除侧聊",
                          disabled: opening || deleting,
                          onClick: () => {
                            setSideError("");
                            setDeleteTarget(sideId);
                          },
                        },
                        h(Icon, { name: "trash", size: 17 }),
                      ),
                    ),
                  ),
                  sideState.rows.length > 1
                    ? h(
                        "div",
                        { className: "workagent-side-picker" },
                        h(Select, {
                          "aria-label": "选择侧聊",
                          disabled: opening || deleting,
                          value: sideId,
                          onChange: (event) => {
                            setSideId(event.target.value);
                            localStorage.setItem(
                              `workagent.side-chat.${sessionId}`,
                              event.target.value,
                            );
                          },
                          options: sideState.rows.map((row, index) => [
                            row.id,
                            `${index + 1}. ${displaySessionTitle(row.title)}`,
                          ]),
                        }),
                        h(Icon, { name: "chevronDown", size: 14 }),
                      )
                    : h(
                        "span",
                        { className: "workagent-side-caption" },
                        "和主对话分开记录",
                      ),
                  sideError && !deleteTarget
                    ? h(
                        "span",
                        { role: "alert", className: "workagent-error" },
                        sideError,
                      )
                    : null,
                ),
              }),
            )
          : null,
        deleteTarget
          ? h(
              "div",
              { className: "workagent-dialog-backdrop", role: "presentation" },
              h(
                "form",
                {
                  className: "workagent-dialog",
                  role: "alertdialog",
                  "aria-modal": true,
                  "aria-label": "确认删除侧聊",
                  onSubmit: deleteSideChat,
                  onKeyDown: (event) => {
                    if (event.key === "Escape" && !deleting) {
                      event.preventDefault();
                      setDeleteTarget(null);
                      setSideError("");
                    }
                  },
                },
                h("strong", null, "删除这个侧聊？"),
                h(
                  "p",
                  null,
                  "侧聊及其消息将被删除，主对话不受影响。再次打开会创建新的侧聊。",
                ),
                sideError
                  ? h(
                      "p",
                      { role: "alert", className: "workagent-error" },
                      sideError,
                    )
                  : null,
                h(
                  "div",
                  { className: "workagent-actions" },
                  h(
                    Button,
                    {
                      autoFocus: true,
                      disabled: deleting,
                      onClick: () => {
                        setDeleteTarget(null);
                        setSideError("");
                      },
                    },
                    "取消",
                  ),
                  h(
                    Button,
                    {
                      type: "submit",
                      className: "workagent-button is-danger",
                      disabled: deleting,
                    },
                    deleting ? "正在删除…" : "确认删除",
                  ),
                ),
              ),
            )
          : null,
      );
    }

    const SharedPage = createShared({
      React,
      request,
      apiRoot,
      useResource,
      Section,
      Button,
      Input,
      Select,
      Markdown,
      friendlyError,
    });
    function CollaborationPage() {
      const [tab, setTab] = React.useState("shared");
      return h(
        "div",
        { className: "workagent-collaboration" },
        h(
          "nav",
          {
            className: "workagent-collaboration-tabs",
            "aria-label": "协作视图",
          },
          ...[
            ["shared", "共享项目"],
            ["teams", "智能体团队"],
          ].map(([id, label]) =>
            h(
              "button",
              {
                type: "button",
                key: id,
                "aria-pressed": tab === id,
                onClick: () => setTab(id),
              },
              h(Icon, { name: id }),
              label,
            ),
          ),
        ),
        h(
          "p",
          { className: "workagent-muted" },
          tab === "teams"
            ? "让多个助手分工完成任务。"
            : "与同事共享项目资料、文件和对话。",
        ),
        tab === "teams" ? h(TeamsPage) : h(SharedPage),
      );
    }
    const pages = {
      shared: CollaborationPage,
      teams: CollaborationPage,
      assistants: PresetsSection,
      automations: AutomationsPage,
      notifications: NotificationsPage,
      workspaces: WorkspacesPage,
      marketplace: MarketplaceSection,
    };
    function WorkAgentOverlay() {
      const routeSearch = navigation.useSearch();
      const ctx = React.useContext(RuntimeServices);
      const params = new URLSearchParams(routeSearch);
      const target = params.get("workagent");
      const sessionId = params.get("session");
      React.useEffect(() => {
        // Native views bind by ID and must not move the upstream session stage.
        // Returning home does clear the old stage so DSH displays its hero.
        if (!sessionId && !target) ctx?.sessions?.clear?.();
      }, [ctx, sessionId, target]);
      const Page = pages[target];
      if (!Page && !sessionId) return null;
      const labels = {
        shared: "协作",
        teams: "协作",
        assistants: "助手",
        automations: "定时任务",
        notifications: "通知",
        workspaces: "项目",
        marketplace: "市场",
      };
      const label = Page ? labels[target] : "会话";
      return h(
        "div",
        {
          role: "dialog",
          "aria-label": label,
          className: "workagent-overlay",
        },
        h(
          "header",
          { className: "workagent-overlay-header" },

          h("h1", null, label),
        ),
        h(
          "main",
          { className: "workagent-overlay-content" },
          Page
            ? h(Page, { key: target })
            : h(ConversationWorkspace, { key: sessionId, sessionId }),
        ),
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
          "data-kind": "notifications",
          title: "通知",
          "aria-label": "通知",
          onClick: () => navigation.navigate("/?workagent=notifications"),
        },
        h(Icon, { name: "notifications" }),
        wide ? h("span", null, "通知") : null,
        unread > 0 ? h("span", { className: "workagent-badge" }, unread) : null,
      );
    }

    function FooterAction({ wide, kind, theme }) {
      if (kind === "notifications") return h(NotificationFooter, { wide });
      const navigate = (page) => () =>
        navigation.navigate(`/?workagent=${page}`);
      const actions = {
        teams: ["协作", navigate("teams")],
        shared: ["共享项目", navigate("shared")],
        assistants: ["助手", navigate("assistants")],
        tasks: ["定时任务", navigate("automations")],
        chatgpt: [
          "聊天模式",
          () =>
            location.assign(localStorage.getItem(CHAT_PAGE_KEY) || "/chatgpt/"),
        ],
        workspace: ["项目", navigate("workspaces")],
        theme: [
          "主题",
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
          "退出登录",
          async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            workbench.clearDrafts();
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
          "data-kind": kind,
          title: label,
          "aria-label": label,
          onClick: action,
        },
        h(Icon, { name: kind }),
        wide ? h("span", null, label) : null,
      );
    }

    function ChatPageSettings() {
      const [address, setAddress] = React.useState(
        () => localStorage.getItem(CHAT_PAGE_KEY) || "",
      );
      const [notice, setNotice] = React.useState("");
      const [error, setError] = React.useState("");
      const save = (event) => {
        event.preventDefault();
        setNotice("");
        setError("");
        try {
          const value = address.trim();
          if (value) {
            if (!value.startsWith("/") && !/^https?:\/\//i.test(value))
              throw new Error("请填写以 HTTP、HTTPS 或 / 开头的聊天网页地址。");
            const url = new URL(value, location.origin);
            if (!/^https?:$/.test(url.protocol) || url.username || url.password)
              throw new Error(
                "请填写 HTTP 或 HTTPS 网页地址，不要在地址中包含账号密码。",
              );
            localStorage.setItem(CHAT_PAGE_KEY, url.href);
          } else localStorage.removeItem(CHAT_PAGE_KEY);
          setNotice("已保存，点击侧栏的聊天模式即可打开。");
        } catch (reason) {
          setError(
            reason instanceof TypeError
              ? "请输入有效的聊天网页地址。"
              : reason.message,
          );
        }
      };
      return h(
        React.Fragment,
        null,
        h("h3", null, "聊天模式"),
        h(
          "p",
          null,
          "填写独立聊天网页的完整地址，例如旧版 WorkAgent 的 /chatgpt/ 地址。留空使用本站入口。此设置仅保存在当前浏览器。",
        ),
        h(
          "form",
          { className: "workagent-form", onSubmit: save },
          h(
            Field,
            { label: "聊天网页地址" },
            h(Input, {
              "aria-label": "聊天网页地址",
              value: address,
              placeholder: "/chatgpt/",
              onChange: (event) => {
                setAddress(event.target.value);
                setNotice("");
                setError("");
              },
            }),
          ),
          h(
            Button,
            { type: "submit", style: { alignSelf: "end" } },
            "保存聊天地址",
          ),
        ),
        error ? h("p", { role: "alert" }, error) : null,
        notice ? h("p", { role: "status" }, notice) : null,
      );
    }

    function SystemSettings() {
      const [storage, refreshStorage] = useResource(
        "/api/system/storage",
        (value) => [value],
      );
      const [status, refreshStatus] = useResource(
        "/api/system/status",
        (value) => [value],
      );
      const [preferences, refreshPreferences] = useResource(
        `${apiRoot}/runtime-settings`,
        (value) => [value],
      );
      const [error, setError] = React.useState("");
      const [notice, setNotice] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      return h(
        Section,
        { title: "系统与帮助" },
        h(ChatPageSettings),
        h(
          "div",
          { className: "workagent-settings-heading" },
          h("h3", null, "存储空间"),
          h(
            Button,
            {
              onClick: refreshStorage,
              "aria-label": "刷新磁盘用量",
              title: "刷新磁盘用量",
            },
            h(Icon, { name: "refresh", size: 16 }),
          ),
        ),
        storage.error
          ? h(
              "p",
              { role: "alert" },
              "暂时无法读取磁盘配额，请刷新或联系管理员。",
            )
          : null,
        h(
          "div",
          { className: "workagent-storage-grid" },
          ...["personal", "shared"].map((kind) => {
            const quota = storage.rows[0]?.[kind];
            return h(
              "article",
              { key: kind, className: "workagent-storage-card" },
              h(Icon, {
                name: kind === "personal" ? "workspace" : "shared",
                size: 20,
              }),
              h("span", null, kind === "personal" ? "个人空间" : "共享空间"),
              h(
                "strong",
                null,
                quota ? (quota.usedBytes / 1024 ** 3).toFixed(2) + " GiB" : "—",
              ),
              h(
                "small",
                null,
                quota?.enabled
                  ? "共 " + (quota.limitBytes / 1024 ** 3).toFixed(2) + " GiB"
                  : "尚未配置配额",
              ),
              quota?.enabled
                ? h("progress", {
                    max: quota.limitBytes || 1,
                    value: quota.usedBytes,
                    "aria-label":
                      kind === "personal" ? "个人空间用量" : "共享空间用量",
                  })
                : null,
            );
          }),
        ),
        h(
          "div",
          { className: "workagent-settings-heading" },
          h("h3", null, "运行状态"),
          h(
            Button,
            {
              onClick: refreshStatus,
              "aria-label": "刷新运行状态",
              title: "刷新运行状态",
            },
            h(Icon, { name: "refresh", size: 16 }),
          ),
        ),
        h(
          "div",
          { className: "workagent-system-status" },
          ...(status.rows[0]?.components || []).map((row) =>
            h(
              "div",
              { key: row.id },
              h(
                "span",
                null,
                {
                  portal: "平台",
                  notifications: "消息提醒",
                  audit: "活动记录",
                  userhost: "员工服务",
                  harness: "任务运行环境",
                }[row.id] || row.id,
              ),
              h(
                "span",
                {
                  className: "workagent-status-label",
                  "data-status": row.status,
                },
                h("i", { "aria-hidden": true }),
                {
                  healthy: "正常",
                  unavailable: "暂不可用",
                  unhealthy: "异常",
                  disabled: "未启用",
                  unknown: "待确认",
                }[row.status] || row.status,
              ),
            ),
          ),
        ),
        h(
          "a",
          { href: "/api/system/diagnostics", download: true },
          "下载诊断报告",
        ),
        h(
          Button,
          {
            disabled: busy,
            onClick: async () => {
              if (
                !window.confirm(
                  "重启当前员工的任务运行环境？正在执行的工作会中断。",
                )
              )
                return;
              setBusy(true);
              setError("");
              try {
                await request("/api/system/runtime/restart", {
                  method: "POST",
                });
                setNotice("已提交重启，请稍后刷新运行状态。");
              } catch (reason) {
                setError(friendlyError(reason.message));
              } finally {
                setBusy(false);
              }
            },
          },
          "重启运行环境",
        ),
        preferences.rows[0]
          ? h(
              "form",
              {
                className: "workagent-form",
                key: preferences.rows[0].turnTimeoutSeconds,
                onSubmit: async (event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  setBusy(true);
                  setError("");
                  const ok = await mutate(
                    refreshPreferences,
                    setError,
                    `${apiRoot}/runtime-settings`,
                    "PUT",
                    { turnTimeoutSeconds: Number(form.get("timeout")) },
                  );
                  setBusy(false);
                  if (ok) setNotice("已保存，从下一轮任务开始生效。");
                },
              },
              h(
                Field,
                { label: "任务时限（秒）" },
                h(Input, {
                  name: "timeout",
                  type: "number",
                  min: 0,
                  max: 86400,
                  required: true,
                  defaultValue: preferences.rows[0].turnTimeoutSeconds,
                }),
              ),
              h(
                "p",
                null,
                "0 表示不限制。时限包含等待确认的时间；达到时限后停止当前轮任务，适用于网页、团队、定时和消息渠道任务。",
              ),
              h(Button, { type: "submit", disabled: busy }, "保存运行设置"),
            )
          : null,
        error || status.error || preferences.error
          ? h(
              "p",
              { role: "alert" },
              friendlyError(error || status.error || preferences.error),
            )
          : null,
        notice ? h("p", { role: "status" }, notice) : null,
        h("h3", null, "使用帮助"),
        h(
          "p",
          null,
          "在项目中创建对话，使用附件或 @ 文件引用资料。Shift + Enter 换行，Alt + ↑/↓ 找回历史输入，/ 打开命令与技能菜单。",
        ),
        h(
          "p",
          null,
          "文件上传中断后，在文件栏的未完成上传中重新选择原文件继续。编辑冲突时保留你的草稿，重新打开文件核对后再保存。",
        ),
        h(
          "p",
          null,
          "任务需要确认时可允许本次、拒绝或停止。开启桌面提醒后，后台完成和待确认时会提醒；浏览器需要授予通知权限。",
        ),
      );
    }
    const imports = createImports({
      React,
      request,
      apiRoot,
      Field,
      Input,
      Button,
      friendlyError,
      useResource,
    });
    const sections = [
      ["workagent-system", 40, "系统与帮助", SystemSettings],
      ["workagent-mcp", 30, "MCP 服务", MCPSection],
      ["workagent-skills", 31, "技能", SkillsSection],
      ["workagent-market", 32, "市场", MarketplaceSection],
      ["workagent-presets", 33, "助手", PresetsSection],
      ["workagent-models", 34, "模型", ModelsSection],
      [
        "workagent-completion-notifications",
        36,
        "消息提醒",
        CompletionNotificationSettings,
      ],
    ];
    const inject = [
      "slots",
      "layout",
      "theme",
      "locale",
      "settingsScope",
      "sessions",
      "connection",
    ];
    function apply(ctx) {
      layout = ctx.layout;
      ctx.effect(() => navigation.install(), "workagent: in-page navigation");
      conversationSettings = ctx.settingsScope.bind({
        namespace: "ui-conversation",
      });
      installAssets();
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register(
          {
            name: "settings.general.item",
            id: "composer-enter",
            order: 20,
            priority: -10,
          },
          BusyEnterSettings,
        ),
      );
      ctx.effect(() => {
        // The upstream renderer rewrites the title when the selected session changes.
        const updateTitle = () => {
          if (document.title !== "WorkAgent") document.title = "WorkAgent";
        };
        const observer = new MutationObserver(updateTitle);
        observer.observe(document.head, {
          childList: true,
          subtree: true,
          characterData: true,
        });
        updateTitle();
        return () => observer.disconnect();
      }, "workagent: browser title");
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register(
          {
            name: "settings.general.item",
            id: "permission",
            order: -20,
            priority: -10,
          },
          () => null,
        ),
      );
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register(
          {
            name: "settings.general.item",
            id: "workagent-typography",
            order: 5,
          },
          TypographySettings,
        ),
      );
      const localeScope = ctx.settingsScope.bind({ namespace: "locale" });
      let localeWritePending = false;
      const initializeLocale = () => {
        const value = localeScope.getSnapshot().value;
        if (value?.preference === "zh") localeWritePending = false;
        else if (value !== undefined && !localeWritePending) {
          localeWritePending = true;
          ctx.locale.setLocale("zh");
        }
      };
      ctx.effect(() => {
        const unsubscribe = localeScope.subscribe(initializeLocale);
        initializeLocale();
        return unsubscribe;
      }, "workagent: Chinese interface language");
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register(
          {
            name: "settings.general.item",
            id: "language",
            order: 0,
            priority: -10,
          },
          () => null,
        ),
      );
      ctx.slots.inject("sidebar.brand.mark", () =>
        ctx.slots.inject("sidebar.brand.name", function* () {
          yield ctx.slots.register({ name: "sidebar.brand.mark" }, BrandMark);
          yield ctx.slots.register({ name: "sidebar.brand.name" }, BrandName);
        }),
      );
      ctx.slots.inject("conversation.hero.brand.mark", () =>
        ctx.slots.register(
          {
            name: "conversation.hero.brand.mark",
            id: "workagent-hero-mark",
            order: 10,
          },
          BrandMark,
        ),
      );
      for (const [id, order, label, Component] of sections)
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            { name: "settings.section", id, order, label },
            Component,
          ),
        );
      ctx.slots.inject("settings.action", () =>
        ctx.slots.register(
          { name: "settings.action", id: "workagent-quota", order: 100 },
          QuotaPanel,
        ),
      );
      for (const [order, kind] of [
        "chatgpt",
        "tasks",
        "teams",
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
      ctx.slots.inject("conversation.hero.agentPreset", () =>
        ctx.slots.register(
          {
            name: "conversation.hero.agentPreset",
            id: "workagent-agent-picker",
            order: 10,
          },
          AgentPicker,
        ),
      );
      ctx.slots.inject("conversation.hero.workspace", () =>
        ctx.slots.register(
          {
            name: "conversation.hero.workspace",
            id: "workagent-workspace-composer",
            order: 20,
            priority: -10,
          },
          HeroWorkspaceComposer,
        ),
      );
      ctx.slots.inject("sidebar.workspaces", () =>
        ctx.slots.register(
          {
            name: "sidebar.workspaces",
            id: "workagent-sidebar-browser",
            order: 20,
            priority: -10,
          },
          SidebarSessions,
        ),
      );
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "workagent-page", order: 10 },
          (props) =>
            h(
              RuntimeServices.Provider,
              { value: ctx },
              h(WorkAgentOverlay, props),
            ),
        ),
      );
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "workagent-files", order: 20 },
          FileSidebar,
        ),
      );
    }
    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  },
});
