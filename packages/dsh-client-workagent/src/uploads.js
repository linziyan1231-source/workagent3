export function createUploads({ React, request, apiRoot, friendlyError }) {
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
