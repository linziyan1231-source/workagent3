import { Markdown, workbench } from "../content/index.js";
import { apiRoot, request } from "../../platform/api.js";
import { Icon } from "../../ui/icons.js";
import { friendlyError } from "../../ui/labels.js";
import { fileURL } from "./api.js";
import React from "react";
import { createElement as h } from "react";

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

function FileTreeRow({ depth = 0, className = "", ...props }) {
  return h("div", {
    ...props,
    className: `workagent-file-tree-row ${className}`,
    style: { "--file-depth": depth, ...props.style },
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

function DocxPreview({ title, html, data }) {
  const frame = React.useRef(null);
  const sendTypography = React.useCallback(() => {
    const size = document.documentElement.dataset.workagentFontSize;
    frame.current.contentWindow.postMessage(
      {
        type: "workagent:document-typography",
        inputSize: size === "18" ? 20 : size === "16" ? 18 : 16,
      },
      "*",
    );
  }, []);
  React.useEffect(() => {
    const observer = new MutationObserver(sendTypography);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-workagent-font-size"],
    });
    return () => observer.disconnect();
  }, [sendTypography]);
  return h("iframe", {
    ref: frame,
    title,
    sandbox: "allow-scripts",
    srcDoc: html,
    onLoad: () => {
      sendTypography();
      frame.current.contentWindow.postMessage(
        { type: "workagent:document", data },
        "*",
      );
    },
  });
}

function WorkspaceFilePreview({
  workspace,
  entry,
  revision,
  onClose,
  onDismiss,
  dismissLabel = "关闭文件侧栏",
  onDirty,
  active,
  contentURL = fileURL,
  resolveOfficePreview,
  editable = true,
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
        const inline = contentURL(workspace.id, entry.path, true);
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
          if (entry.size > 25 * 1024 * 1024) throw new Error("file_too_large");
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
          const url = resolveOfficePreview
            ? await resolveOfficePreview(workspace, entry, controller.signal)
            : await request(`${apiRoot}/office-preview/convert`, {
                method: "POST",
                signal: controller.signal,
                body: JSON.stringify({
                  workspace: workspace.directory || workspace.id,
                  path: entry.path,
                }),
              }).then(
                (value) =>
                  `${apiRoot}/office-preview/content/${encodeURIComponent(value.hash)}.pdf`,
              );
          const response = await fetch(url, { signal: controller.signal });
          if (
            !response.ok ||
            !response.headers.get("content-type")?.includes("application/pdf")
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
      editable && state.text !== undefined && !editingFile
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
          href: contentURL(workspace.id, entry.path),
          download: entry.name,
          "aria-label": `下载 ${entry.name}`,
          title: "下载原文件",
        },
        h(Icon, { name: "download", size: 17 }),
      ),
      h(FileIconButton, {
        name: "close",
        label: dismissLabel,
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
            fileId: entry.fileId,
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
              ? h(DocxPreview, {
                  key: `${entry.path}:${revision}`,
                  title: entry.name,
                  html: state.html,
                  data: state.data,
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

export { FileIconButton, FileTreeRow, WorkspaceFilePreview };
