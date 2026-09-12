export function createFileMoves({ React, request, h, friendlyError }) {
  const mime = "application/x-workagent-project-files";
  const contains = (parent, path) =>
    path.toLowerCase() === parent.toLowerCase() ||
    path.toLowerCase().startsWith(parent.toLowerCase() + "/");
  const join = (directory, name) => [directory, name].filter(Boolean).join("/");
  function useFileMoves({
    root,
    workspaceId,
    dirtyFiles,
    onCompleted,
    onError,
  }) {
    const [checked, setChecked] = React.useState([]);
    const [picker, setPicker] = React.useState(null);
    const [target, setTarget] = React.useState("");
    const [folders, setFolders] = React.useState([]);
    const [folderName, setFolderName] = React.useState("");
    const [hover, setHover] = React.useState(null);
    const [operations, setOperations] = React.useState([]);
    const [conflict, setConflict] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const seen = React.useRef(null);
    const callback = React.useRef(onCompleted);
    callback.current = onCompleted;
    const drag = React.useRef(null);
    const accept = (op) => {
      const key = `${op.state}:${op.applied}`;
      if (seen.current?.get(op.id) !== key && op.applied)
        callback.current(op.moves.slice(0, op.applied));
      seen.current?.set(op.id, key);
      setOperations((rows) => [...rows.filter((row) => row.id !== op.id), op]);
    };
    React.useEffect(() => {
      let live = true;
      const poll = async () => {
        try {
          const rows = await request(`${root}/move`);
          if (!live || !Array.isArray(rows)) return;
          if (seen.current)
            for (const op of rows) {
              if (
                seen.current.get(op.id) !== `${op.state}:${op.applied}` &&
                op.applied
              )
                callback.current(op.moves.slice(0, op.applied));
            }
          seen.current = new Map(
            rows.map((op) => [op.id, `${op.state}:${op.applied}`]),
          );
          setOperations(rows);
        } catch (error) {
          if (live) onError(friendlyError(error.message));
        }
      };
      void poll();
      const timer = setInterval(poll, 2000);
      return () => {
        live = false;
        clearInterval(timer);
      };
    }, [root]);
    React.useEffect(() => {
      if (!picker) return;
      const controller = new AbortController();
      request(`${root}/files?path=${encodeURIComponent(target)}`, {
        signal: controller.signal,
      })
        .then((rows) => {
          if (!controller.signal.aborted)
            setFolders(rows.filter((row) => row.kind === "directory"));
        })
        .catch((error) => {
          if (!controller.signal.aborted) onError(friendlyError(error.message));
        });
      return () => controller.abort();
    }, [root, picker, target]);
    const submit = async (moves, keepBoth = false) => {
      if (busy) return;
      setBusy(true);
      onError("");
      try {
        const result = await request(`${root}/move`, {
          method: "POST",
          body: JSON.stringify({
            moves,
            ...(keepBoth ? { conflict: "rename" } : {}),
          }),
        });
        accept(result);
        setPicker(null);
        setChecked([]);
        setConflict(null);
        if (result.state === "failed") onError(friendlyError(result.error));
      } catch (error) {
        if (error.message === "destination_exists") setConflict(moves);
        else onError(friendlyError(error.message));
      } finally {
        setBusy(false);
      }
    };
    const moveTo = (entries, directory) => {
      const top = entries.filter(
        (entry) =>
          !entries.some(
            (other) => other !== entry && contains(other.path, entry.path),
          ),
      );
      const moves = top
        .map((entry) => ({
          source: entry.path,
          destination: join(directory, entry.name),
          fileId: entry.fileId,
        }))
        .filter((m) => m.source !== m.destination);
      if (moves.length) void submit(moves);
      else onError("文件已在此文件夹中。");
    };
    const action = async (op, kind) => {
      try {
        accept(
          await request(`${root}/move`, {
            method: "POST",
            body: JSON.stringify({ action: kind, id: op.id }),
          }),
        );
      } catch (error) {
        onError(friendlyError(error.message));
      }
    };
    const destinationProps = (path) => ({
      "data-move-target": path,
      onDragOver: (event) => {
        if (!event.dataTransfer.types.includes(mime)) return;
        event.preventDefault();
        event.stopPropagation();
        const invalid = drag.current?.some((row) => contains(row.path, path));
        event.dataTransfer.dropEffect = invalid ? "none" : "move";
        setHover(invalid ? null : path);
      },
      onDragLeave: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHover(null);
      },
      onDrop: (event) => {
        if (!event.dataTransfer.types.includes(mime)) return;
        event.preventDefault();
        event.stopPropagation();
        setHover(null);
        try {
          const payload = JSON.parse(event.dataTransfer.getData(mime));
          if (payload.workspaceId !== workspaceId)
            throw new Error("只能在当前项目内移动文件。");
          moveTo(payload.entries, path);
        } catch (error) {
          onError(friendlyError(error.message));
        }
      },
    });
    const open = (entry) => {
      setTarget("");
      setFolderName("");
      setPicker(
        entry
          ? checked.some((row) => row.path === entry.path)
            ? checked
            : [entry]
          : checked,
      );
    };
    const button = (label, onClick, disabled = false) =>
      h(
        "button",
        { type: "button", className: "workagent-button", onClick, disabled },
        label,
      );
    const pending = operations.filter((op) => op.state === "queued");
    const last = operations.filter((op) => op.state === "completed").at(-1);
    return {
      open,
      submit,
      hover,
      checked,
      rowProps: (entry) => ({
        draggable: !busy,
        "data-file-path": entry.path,
        onDragStart: (event) => {
          const entries = checked.some((row) => row.path === entry.path)
            ? checked
            : [entry];
          drag.current = entries;
          event.dataTransfer.setData(
            mime,
            JSON.stringify({ workspaceId, entries }),
          );
          event.dataTransfer.effectAllowed = "move";
        },
        onDragEnd: () => {
          drag.current = null;
          setHover(null);
        },
        ...(entry.kind === "directory" ? destinationProps(entry.path) : {}),
      }),
      destinationProps,
      checkbox: (entry) =>
        h("input", {
          type: "checkbox",
          "aria-label": `选择 ${entry.name}`,
          checked: checked.some((row) => row.path === entry.path),
          onChange: (event) =>
            setChecked((rows) =>
              event.target.checked
                ? [...rows, entry]
                : rows.filter((row) => row.path !== entry.path),
            ),
        }),
      controls: h(
        React.Fragment,
        null,
        checked.length
          ? h(
              "div",
              { className: "workagent-move-selection" },
              `已选择 ${checked.length} 项`,
              button("移动到…", () => open()),
              button("取消选择", () => setChecked([])),
            )
          : null,
        ...pending.map((op) =>
          h(
            "div",
            { key: op.id, role: "status", className: "workagent-file-notice" },
            h("span", null, "已安排移动，等待任务结束或文件编辑保存。"),
            button("取消移动", () => action(op, "cancel")),
          ),
        ),
        last
          ? h(
              "div",
              { role: "status", className: "workagent-file-notice" },
              `已移动 ${last.moves.length} 项到 ${last.moves[0].destination.split("/").slice(0, -1).join(" / ") || "根目录"}`,
              button("撤销移动", () => action(last, "undo")),
            )
          : null,
        ...operations
          .filter((op) => op.state === "failed")
          .slice(-1)
          .map((op) =>
            h(
              "p",
              { role: "alert", key: op.id },
              `移动未完成（已移动 ${op.applied}/${op.moves.length} 项）：${friendlyError(op.error)}`,
            ),
          ),
        conflict
          ? h(
              "div",
              { role: "alert", className: "workagent-file-action-form" },
              "目标文件夹已有同名文件，原文件会保留。",
              button("保留两份", () => submit(conflict, true), busy),
              button("取消", () => setConflict(null)),
            )
          : null,
        picker
          ? h(
              "section",
              {
                role: "dialog",
                "aria-label": "移动到文件夹",
                className: "workagent-move-picker",
              },
              h("strong", null, `移动 ${picker.length} 项到…`),
              h(
                "nav",
                { "aria-label": "目标文件夹" },
                button("根目录", () => setTarget("")),
                ...target
                  .split("/")
                  .filter(Boolean)
                  .map((part, i, parts) =>
                    button(part, () =>
                      setTarget(parts.slice(0, i + 1).join("/")),
                    ),
                  ),
              ),
              h(
                "div",
                { className: "workagent-move-folder-list" },
                ...folders.map((folder) =>
                  button(
                    `📁 ${folder.name}`,
                    () => setTarget(folder.path),
                    picker.some((entry) => contains(entry.path, folder.path)),
                  ),
                ),
              ),
              h(
                "div",
                { className: "workagent-move-new-folder" },
                h("input", {
                  "aria-label": "新文件夹名称",
                  value: folderName,
                  placeholder: "新文件夹名称",
                  onChange: (event) => setFolderName(event.target.value),
                }),
                button("新建文件夹", async () => {
                  if (
                    !folderName.trim() ||
                    /[\\/:*?"<>|]/.test(folderName) ||
                    [".", ".."].includes(folderName.trim())
                  )
                    return onError("请输入有效文件夹名称。");
                  try {
                    const path = join(target, folderName.trim());
                    await request(`${root}/directories`, {
                      method: "POST",
                      body: JSON.stringify({ path }),
                    });
                    setFolderName("");
                    setTarget(path);
                  } catch (error) {
                    onError(friendlyError(error.message));
                  }
                }),
              ),
              dirtyFiles.size
                ? h("p", null, "有未保存编辑时，移动将在保存或关闭编辑后进行。")
                : null,
              button("取消", () => setPicker(null)),
              button(
                "移动到这里",
                () => moveTo(picker, target),
                busy || picker.some((entry) => contains(entry.path, target)),
              ),
            )
          : null,
      ),
    };
  }
  return { useFileMoves };
}
