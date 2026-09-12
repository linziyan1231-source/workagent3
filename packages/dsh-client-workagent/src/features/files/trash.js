export function createFileTrash({
  React,
  request,
  h,
  Icon,
  Button,
  FileIconButton,
  FileTreeRow,
  friendlyError,
  fileSize,
}) {
  const storageSize = (size) =>
    size >= 1024 ** 3 ? `${(size / 1024 ** 3).toFixed(1)} GB` : fileSize(size);
  const dateLabel = (value) =>
    new Date(value).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  const expiresLabel = (value) => {
    const days = (Date.parse(value) - Date.now()) / 86400000;
    return days <= 0
      ? "等待自动清理"
      : days < 1
        ? "不足 1 天后清理"
        : `${Math.ceil(days)} 天后清理`;
  };
  const originalLocation = (entry) =>
    entry.legacy ? "项目根目录（旧版记录）" : entry.path;

  function useFileTrash({ root, enabled }) {
    const [data, setData] = React.useState(null);
    const [loading, setLoading] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState("");
    const [notice, setNotice] = React.useState("");
    const [menu, setMenu] = React.useState(null);
    const [action, setAction] = React.useState(null);
    const pending = React.useRef(null);
    const live = React.useRef(false);
    const refresh = React.useCallback(async () => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      setLoading(true);
      setError("");
      try {
        const value = await request(root, { signal: controller.signal });
        if (!controller.signal.aborted) setData(value);
      } catch (reason) {
        if (!controller.signal.aborted) setError(friendlyError(reason.message));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, [root]);
    React.useEffect(() => {
      if (!enabled) return;
      live.current = true;
      setData(null);
      setAction(null);
      setMenu(null);
      setNotice("");
      void refresh();
      const update = () => void refresh();
      window.addEventListener("focus", update);
      window.addEventListener("workagent:files-changed", update);
      window.addEventListener("workagent:shared-changed", update);
      const timer = setInterval(update, 30000);
      return () => {
        live.current = false;
        pending.current?.abort();
        clearInterval(timer);
        window.removeEventListener("focus", update);
        window.removeEventListener("workagent:files-changed", update);
        window.removeEventListener("workagent:shared-changed", update);
      };
    }, [enabled, refresh]);
    const beginAction = (kind, entry) => {
      setMenu(null);
      setError("");
      setNotice("");
      setAction({ kind, entry });
    };
    const mutate = async (event) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      setError("");
      const { kind, entry } = action;
      try {
        const endpoint = `${root}/${encodeURIComponent(entry.id)}`;
        await request(kind === "restore" ? `${endpoint}/restore` : endpoint, {
          method: kind === "restore" ? "POST" : "DELETE",
        });
        if (!live.current) return;
        setAction(null);
        setData((value) => ({
          ...value,
          entries: value.entries.filter((row) => row.id !== entry.id),
        }));
        setNotice(
          kind === "restore"
            ? `已恢复“${entry.name}”`
            : `已永久删除“${entry.name}”`,
        );
        window.dispatchEvent(new Event("workagent:files-changed"));
      } catch (reason) {
        if (live.current)
          setError(
            reason.message === "file_exists"
              ? "原位置已有同名文件。请先在项目文件中重命名或移走同名文件，再恢复。"
              : reason.status === 404
                ? "此文件已被恢复或清理，请刷新回收站。"
                : friendlyError(reason.message),
          );
      } finally {
        if (live.current) setBusy(false);
      }
    };
    const content = h(
      React.Fragment,
      null,
      h(
        "section",
        {
          className: "workagent-trash-summary",
          "aria-label": "回收站保留规则",
        },
        h(
          "div",
          { className: "workagent-trash-summary-heading" },
          h("strong", null, "文件恢复"),
          h("span", null, `保留 ${data?.retentionDays || 7} 天`),
        ),
        h(
          "p",
          null,
          `删除后最多保留 ${data?.retentionDays || 7} 天。共享空间不足时，按删除时间从早到晚自动清理。`,
        ),
        data
          ? h(
              React.Fragment,
              null,
              h(
                "div",
                { className: "workagent-trash-capacity" },
                h("span", null, "所有成员共享回收空间"),
                h(
                  "span",
                  null,
                  `${storageSize(data.usedBytes)} / ${storageSize(data.limitBytes)}`,
                ),
              ),
              h("progress", {
                "aria-label": "共享回收空间使用量",
                value: data.usedBytes,
                max: data.limitBytes,
              }),
            )
          : null,
      ),
      error
        ? h(
            "p",
            { role: "alert", className: "workagent-file-notice is-error" },
            error,
          )
        : null,
      notice
        ? h("p", { role: "status", className: "workagent-file-notice" }, notice)
        : null,
      action
        ? h(
            "form",
            {
              className: "workagent-file-action-form",
              "aria-label":
                action.kind === "restore" ? "恢复文件" : "永久删除文件",
              onSubmit: mutate,
            },
            h(
              "strong",
              null,
              action.kind === "restore" ? "恢复文件" : "永久删除文件",
            ),
            h(
              "p",
              null,
              action.kind === "restore"
                ? `将“${action.entry.name}”${action.entry.kind === "directory" ? "及其内容" : ""}恢复到${action.entry.legacy ? "项目根目录" : "原位置"}？`
                : `永久删除“${action.entry.name}”${action.entry.kind === "directory" ? "及其内容" : ""}？此操作无法撤销。`,
            ),
            action.kind === "restore"
              ? h(
                  "p",
                  { className: "workagent-trash-restore-path" },
                  originalLocation(action.entry),
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
                {
                  type: "submit",
                  disabled: busy,
                  ...(action.kind === "delete"
                    ? { className: "workagent-button is-danger" }
                    : {}),
                },
                busy
                  ? "处理中…"
                  : action.kind === "restore"
                    ? "确认恢复"
                    : "永久删除",
              ),
            ),
          )
        : null,
      data
        ? h(
            "div",
            { className: "workagent-trash-list-heading" },
            h("strong", null, `本项目 · ${data.entries.length} 项`),
            h("span", null, storageSize(data.projectUsedBytes)),
          )
        : null,
      h(
        "div",
        {
          className: "workagent-file-tree workagent-trash-list",
          "aria-label": "当前项目回收站文件",
          "aria-busy": loading,
        },
        !data
          ? error
            ? h(
                "div",
                { className: "workagent-file-panel-empty" },
                h(Icon, { name: "trash", size: 32 }),
                h("strong", null, "暂时无法读取回收站"),
                h(Button, { onClick: refresh, disabled: loading }, "重新加载"),
              )
            : h(
                "p",
                { role: "status", className: "workagent-file-notice" },
                "正在加载回收站…",
              )
          : data.entries.length
            ? h(
                "ul",
                { className: "workagent-file-tree-list" },
                ...data.entries.map((entry) =>
                  h(
                    "li",
                    { key: entry.id },
                    h(
                      FileTreeRow,
                      {
                        className: `workagent-trash-row${menu === entry.id ? " is-selected" : ""}`,
                      },
                      h(
                        "button",
                        {
                          type: "button",
                          className: "workagent-file-tree-name",
                          title: originalLocation(entry),
                          "aria-label": `查看 ${entry.name} 的回收信息`,
                          "aria-expanded": menu === entry.id,
                          disabled: busy,
                          onClick: () =>
                            setMenu(menu === entry.id ? null : entry.id),
                        },
                        h(Icon, {
                          name:
                            entry.kind === "directory" ? "workspace" : "file",
                          size: 17,
                        }),
                        h(
                          "span",
                          { className: "workagent-trash-file-label" },
                          h("span", null, entry.name),
                          h(
                            "small",
                            null,
                            entry.legacy
                              ? "旧版记录 · 恢复至根目录"
                              : entry.path,
                          ),
                        ),
                      ),
                      h("small", null, storageSize(entry.size)),
                      h(FileIconButton, {
                        name: "more",
                        label: `操作 ${entry.name}`,
                        "aria-expanded": menu === entry.id,
                        disabled: busy,
                        onClick: () =>
                          setMenu(menu === entry.id ? null : entry.id),
                      }),
                    ),
                    h(
                      "div",
                      { className: "workagent-trash-file-time" },
                      h(
                        "time",
                        { dateTime: entry.deletedAt },
                        `${dateLabel(entry.deletedAt)} 删除`,
                      ),
                      h(
                        "span",
                        { title: `${dateLabel(entry.expiresAt)} 自动清理` },
                        expiresLabel(entry.expiresAt),
                      ),
                    ),
                    menu === entry.id
                      ? h(
                          "div",
                          {
                            className: "workagent-file-row-menu",
                            "aria-label": `${entry.name} 的操作`,
                          },
                          h(
                            "button",
                            {
                              type: "button",
                              disabled: busy,
                              onClick: () => beginAction("restore", entry),
                            },
                            "恢复",
                          ),
                          h(
                            "button",
                            {
                              type: "button",
                              disabled: busy,
                              className: "workagent-trash-delete",
                              onClick: () => beginAction("delete", entry),
                            },
                            "永久删除",
                          ),
                        )
                      : null,
                  ),
                ),
              )
            : h(
                "div",
                { className: "workagent-file-panel-empty" },
                h(Icon, { name: "trash", size: 32 }),
                h("strong", null, "本项目回收站为空"),
                h("p", null, "项目中删除的文件会暂存在这里，可在清理前恢复。"),
              ),
      ),
    );
    return { content, refresh, busy, loading };
  }
  return { useFileTrash };
}
