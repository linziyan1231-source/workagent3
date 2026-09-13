import { createFileMoves } from "./moves.js";
import { createFileTrash } from "./trash.js";
import { apiRoot, request } from "../../platform/api.js";
import { Button, Input } from "../../ui/elements.js";
import { Icon } from "../../ui/icons.js";
import { useConfirm } from "../../ui/dialog.js";
import { friendlyError } from "../../ui/labels.js";
import { SESSIONS_CHANGED_EVENT } from "../conversations/state.js";
import {
  FILES_CHANGED_EVENT,
  fileParent,
  fileSize,
  fileURL,
  uploads,
} from "./api.js";
import {
  FileIconButton,
  FileTreeRow,
  WorkspaceFilePreview,
} from "./preview.js";
import React from "react";
import { createElement as h } from "react";

const { useFileMoves } = createFileMoves({
  React,
  request,
  h,
  friendlyError,
});

const { useFileTrash } = createFileTrash({
  React,
  request,
  h,
  Icon,
  Button,
  FileIconButton,
  FileTreeRow,
  friendlyError,
  fileSize,
});

function WorkspaceFileManager({
  workspace,
  onDismiss,
  dismissLabel,
  root = `${apiRoot}/workspaces/${encodeURIComponent(workspace.id)}`,
  contentURL = fileURL,
  uploadClient = uploads,
  resolveOfficePreview,
  editable = true,
  createEmptyFile,
  trashRoot,
}) {
  const [tree, setTree] = React.useState({});
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchRows, setSearchRows] = React.useState([]);
  const [searchCursor, setSearchCursor] = React.useState(null);
  const [searchBusy, setSearchBusy] = React.useState(false);
  const [searchChoice, setSearchChoice] = React.useState(0);
  const searchAbort = React.useRef(null);
  const searchLease = React.useRef(null);
  const releaseSearch = () => {
    const lease = searchLease.current;
    searchLease.current = null;
    if (lease)
      void request(
        `${lease.root}/search?cursor=${encodeURIComponent(lease.cursor)}`,
        { method: "DELETE" },
      ).catch(() => {});
  };
  const searchFiles = async (cursor = null) => {
    searchAbort.current?.abort();
    if (!cursor) releaseSearch();
    const controller = new AbortController();
    searchAbort.current = controller;
    setSearchBusy(true);
    try {
      const result = await request(
        `${root}/search?q=${encodeURIComponent(searchQuery)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) {
        searchLease.current = result.nextCursor
          ? { root, cursor: result.nextCursor }
          : null;
        setSearchRows((rows) =>
          cursor ? [...rows, ...result.items] : result.items,
        );
        if (!cursor) setSearchChoice(0);
        setSearchCursor(result.nextCursor);
      } else if (result.nextCursor) {
        void request(
          `${root}/search?cursor=${encodeURIComponent(result.nextCursor)}`,
          { method: "DELETE" },
        ).catch(() => {});
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(friendlyError(reason.message));
    } finally {
      if (!controller.signal.aborted) setSearchBusy(false);
    }
  };
  React.useEffect(() => {
    searchAbort.current?.abort();
    releaseSearch();
    setSearchRows([]);
    setSearchCursor(null);
    if (!searchQuery.trim()) {
      setSearchBusy(false);
      return;
    }
    const timer = setTimeout(() => searchFiles(), 200);
    return () => {
      clearTimeout(timer);
      searchAbort.current?.abort();
      releaseSearch();
    };
  }, [root, searchQuery]);
  const openSearchResult = (entry) => {
    setTabs((rows) => [...rows.filter((item) => item.path !== entry.path), entry]);
    setSelected(entry);
    setDirectory(fileParent(entry.path));
    setSearchQuery("");
  };
  const searchKeyDown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!searchRows.length) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSearchChoice(
        (index) => (index + delta + searchRows.length) % searchRows.length,
      );
    } else if (event.key === "Enter" && searchRows[searchChoice]) {
      event.preventDefault();
      openSearchResult(searchRows[searchChoice]);
    } else if (event.key === "Escape" && searchQuery) {
      event.preventDefault();
      setSearchQuery("");
    }
  };
  const { confirm, confirmation } = useConfirm();
  const [trashOpen, setTrashOpen] = React.useState(false);
  const trash = useFileTrash({ root: trashRoot, enabled: trashOpen });
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
  const closeTab = async (entry) => {
    if (
      dirtyFiles.has(entry.path) &&
      !(await confirm(
        `关闭“${entry.name}”？未保存草稿会保留，重新编辑时恢复。`,
      ))
    )
      return;
    setTabs((current) => current.filter((item) => item.path !== entry.path));
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
      setTrashOpen(false);
      const entry = event.detail.entry;
      setTabs((current) => [
        ...current.filter((item) => item.path !== entry.path),
        entry,
      ]);
      setSelected(entry);
    };
    window.addEventListener("workagent:file-open", openFile);
    return () => window.removeEventListener("workagent:file-open", openFile);
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
        if (!controller.signal.aborted) setError(friendlyError(reason.message));
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
      for (const controller of requests.current.values()) controller.abort();
      window.removeEventListener(SESSIONS_CHANGED_EVENT, update);
      window.removeEventListener(FILES_CHANGED_EVENT, update);
      window.removeEventListener("focus", update);
    };
  }, [refresh]);
  const movement = useFileMoves({
    root,
    workspaceId: workspace.id,
    dirtyFiles,
    onError: setError,
    onCompleted: (moves) => {
      const mapped = (path) => {
        for (const move of moves)
          if (path === move.source || path.startsWith(move.source + "/"))
            return move.destination + path.slice(move.source.length);
        return path;
      };
      const entry = (row) => ({
        ...row,
        path: mapped(row.path),
        name: mapped(row.path).split("/").at(-1),
      });
      for (const controller of requests.current.values()) controller.abort();
      setTree({});
      const next = new Set([
        "",
        ...[...expandedRef.current].map(mapped),
        ...moves.map((move) => fileParent(move.destination)),
      ]);
      expandedRef.current = next;
      setExpanded(next);
      setDirectory((current) => mapped(current));
      setTabs((rows) => rows.map(entry));
      setSelected((current) => (current ? entry(current) : current));
      setRevision((value) => value + 1);
      for (const path of next) void loadDirectory(path);
      window.dispatchEvent(new Event(FILES_CHANGED_EVENT));
    },
  });
  const beginAction = (kind, entry) => {
    setMenu(null);
    if (kind === "move") {
      movement.open(entry);
      return;
    }
    setError("");
    setNotice("");
    setAction({ kind, entry });
    setName(kind === "rename" ? entry.name : "");
  };
  const mutate = async (event) => {
    event.preventDefault();
    if (busy) return;
    const value = name.trim();
    if (
      action.kind !== "delete" &&
      (!value || /[\\/:*?"<>|]/.test(value) || value === "." || value === "..")
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
        await request(contentURL(workspace.id, action.entry.path), {
          method: "DELETE",
        });
      } else if (action.kind === "rename") {
        const destination = [fileParent(action.entry.path), value]
          .filter(Boolean)
          .join("/");
        await movement.submit([
          {
            source: action.entry.path,
            destination,
            fileId: action.entry.fileId,
          },
        ]);
        setAction(null);
        return;
      } else {
        const path = [directory, value].filter(Boolean).join("/");
        if (action.kind === "folder")
          await request(`${root}/directories`, {
            method: "POST",
            body: JSON.stringify({ path }),
          });
        else if (createEmptyFile)
          await createEmptyFile({ directory, name: value, path });
        else
          await request(`${contentURL(workspace.id, path)}&overwrite=0`, {
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
        for (const controller of requests.current.values()) controller.abort();
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
    if (uploadControl.current || busy || !files.length) return;
    const controller = new AbortController();
    uploadControl.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { completed, failures } = await uploadClient.uploadFiles(
        workspace.id,
        files,
        {
          directory,
          signal: controller.signal,
          onProgress: (progress) => {
            if (live.current) setUploadProgress(progress);
          },
        },
      );
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
            FileTreeRow,
            {
              ...movement.rowProps(entry),
              className: `${selected?.path === entry.path || directory === entry.path ? "is-selected" : ""}${movement.hover === entry.path ? " is-move-target" : ""}`,
              depth,
            },
            movement.checkbox(entry),
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
              onClick: () => setMenu(menu?.path === entry.path ? null : entry),
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
                        href: contentURL(workspace.id, entry.path),
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
                  "移动到…",
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
                : h("p", { className: "workagent-file-tree-empty" }, "空文件夹")
              : h("p", { className: "workagent-file-tree-empty" }, "正在加载…")
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
      delete: "删除文件",
    }[action.kind];
  const leaveTrash = () => {
    setTrashOpen(false);
    void refresh();
  };
  return h(
    "div",
    {
      className: `workagent-file-manager${selected && !trashOpen ? " has-preview" : ""}`,
      onDragEnter: (event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
      },
      onDragOver: (event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = busy || trashOpen ? "none" : "copy";
      },
      onDrop: (event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        event.stopPropagation();
        if (!trashOpen) void upload([...event.dataTransfer.files]);
      },
    },
    confirmation,
    h(
      "div",
      {
        className: "workagent-file-manager-content",
        hidden: !!selected && !trashOpen,
      },
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
        trashOpen
          ? h(FileIconButton, {
              name: "back",
              label: "返回项目文件",
              disabled: trash.busy,
              onClick: leaveTrash,
            })
          : h(
              React.Fragment,
              null,
              h(FileIconButton, {
                name: "upload",
                label: "上传文件",
                title: `上传文件 · 单个最大 ${UPLOAD_SIZE_LABEL}，也可拖入文件`,
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
              trashRoot
                ? h(FileIconButton, {
                    name: "trash",
                    label: "打开项目回收站",
                    disabled: busy,
                    onClick: () => {
                      setAction(null);
                      setMenu(null);
                      setTrashOpen(true);
                    },
                  })
                : null,
            ),
        h("span", null, (trashOpen ? trash.busy : busy) ? "正在处理…" : ""),
        h(FileIconButton, {
          name: "refresh",
          label: trashOpen ? "刷新回收站" : "刷新文件",
          disabled: trashOpen ? trash.loading || trash.busy : loading,
          onClick: () => {
            if (trashOpen) {
              void trash.refresh();
              return;
            }
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
      !trashOpen
        ? h(uploadClient.Panel, {
            workspaceId: workspace.id,
            onChanged: refresh,
          })
        : null,
      h(
        "nav",
        {
          className: "workagent-file-breadcrumb",
          "aria-label": "当前文件目录",
        },
        h(
          "button",
          {
            type: "button",
            onClick: trashOpen ? leaveTrash : () => setDirectory(""),
            disabled: trashOpen && trash.busy,
            ...(!trashOpen ? movement.destinationProps("") : {}),
            className:
              !trashOpen && movement.hover === "" ? "is-move-target" : "",
          },
          trashOpen ? "项目文件" : "根目录",
        ),
        trashOpen ? h("span", { "aria-current": "page" }, " / 回收站") : null,
        ...(trashOpen ? "" : directory)
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
      !trashOpen && error
        ? h(
            "p",
            { role: "alert", className: "workagent-file-notice is-error" },
            error,
          )
        : null,
      !trashOpen && notice
        ? h("p", { role: "status", className: "workagent-file-notice" }, notice)
        : null,
      !trashOpen ? movement.controls : null,
      !trashOpen && action
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
                  trashRoot
                    ? "文件将移入项目回收站，最多保留 7 天；共享空间不足时将按删除时间从早到晚清理。"
                    : "",
                )
              : h(Input, {
                  autoFocus: true,
                  "aria-label": "文件名",
                  placeholder: "输入名称",
                  value: name,
                  onChange: (event) => setName(event.target.value),
                  required: true,
                }),
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
      trashOpen
        ? trash.content
        : h(
            React.Fragment,
            null,
            h(
              "div",
              { className: "workagent-file-search" },
              h(Icon, { name: "search", size: 16 }),
              h(Input, {
                className: "workagent-file-search-input",
                role: "combobox",
                "aria-expanded": !!searchQuery.trim(),
                "aria-label": "搜索整个项目",
                placeholder: "搜索整个项目的文件名或路径",
                value: searchQuery,
                onChange: (event) => setSearchQuery(event.target.value),
                onKeyDown: searchKeyDown,
              }),
              searchQuery.trim()
                ? h(
                    "div",
                    {
                      className: "workagent-file-search-results",
                      role: "listbox",
                      "aria-label": "项目搜索结果",
                    },
                    ...searchRows.map((entry, index) =>
                      h(
                        "button",
                        {
                          key: entry.path,
                          type: "button",
                          role: "option",
                          "aria-selected": index === searchChoice,
                          className: `workagent-file-search-result${index === searchChoice ? " is-active" : ""}`,
                          onMouseDown: (event) => event.preventDefault(),
                          onClick: () => openSearchResult(entry),
                        },
                        h(Icon, { name: "file", size: 16 }),
                        h(
                          "span",
                          { className: "workagent-file-search-name" },
                          entry.name,
                        ),
                        h("small", null, fileParent(entry.path) || "根目录"),
                      ),
                    ),
                    searchBusy
                      ? h(
                          "p",
                          {
                            role: "status",
                            className: "workagent-file-search-state",
                          },
                          "正在搜索…",
                        )
                      : searchCursor
                        ? h(
                            "button",
                            {
                              type: "button",
                              className: "workagent-file-search-more",
                              onMouseDown: (event) => event.preventDefault(),
                              onClick: () => searchFiles(searchCursor),
                            },
                            "继续搜索更多结果",
                          )
                        : !searchRows.length
                          ? h(
                              "p",
                              { className: "workagent-file-search-state" },
                              "没有匹配的文件",
                            )
                          : null,
                  )
                : null,
            ),
            h(
              "div",
              {
                className: `workagent-file-tree${movement.hover === movement.moveOutKey ? " is-move-target" : ""}`,
                "aria-label": "项目文件树",
                ...movement.moveOutProps(),
              },
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
    ),
    tabs.length && !trashOpen
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
          hidden: trashOpen || selected?.path !== entry.path,
          className: "workagent-file-tab-content",
        },
        h(WorkspaceFilePreview, {
          workspace,
          entry,
          active: !trashOpen && selected?.path === entry.path,
          revision,
          onDirty: reportDirty,
          onClose: () => setSelected(null),
          onDismiss,
          dismissLabel,
          contentURL,
          resolveOfficePreview,
          editable,
        }),
      ),
    ),
  );
}

export { WorkspaceFileManager };
import { UPLOAD_SIZE_LABEL } from "@workagent/contracts/upload-policy";
