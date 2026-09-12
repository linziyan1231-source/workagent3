import React, { createElement as h } from "react";
import { request } from "../../platform/api.js";
import { Button, Input, Field, Section } from "../../ui/elements.js";
const operationId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
export function FeedbackForm() {
  const [description, setDescription] = React.useState("");
  const [steps, setSteps] = React.useState("");
  const [files, setFiles] = React.useState([]);
  const [notice, setNotice] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [items, setItems] = React.useState([]);
  const [diagnostic, setDiagnostic] = React.useState("");
  const requestId = React.useRef(operationId());
  const submitting = React.useRef(false);
  const edit = (setter, value) => {
    requestId.current = operationId();
    setter(value);
  };
  const load = () =>
    request("/api/system/feedback")
      .then((result) => setItems(result.items))
      .catch(() => {});
  React.useEffect(() => {
    load();
  }, []);
  const [previews, setPreviews] = React.useState([]);
  React.useEffect(() => {
    const urls = files.map((file) =>
      file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    );
    setPreviews(urls);
    return () => urls.forEach((url) => url && URL.revokeObjectURL(url));
  }, [files]);
  const submit = async (event) => {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setNotice("");
    try {
      const body = new FormData();
      body.set("requestId", requestId.current);
      body.set("module", "用户反馈");
      body.set("description", description);
      body.set("steps", steps);
      files.forEach((file) => body.append("attachments", file));
      const response = await fetch("/api/system/feedback", {
        method: "POST",
        body,
        credentials: "same-origin",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "提交失败");
      setNotice(`已保存反馈 ${result.id}`);
      setDescription("");
      setSteps("");
      setFiles([]);
      requestId.current = operationId();
      await load();
    } catch (error) {
      setNotice(error.message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return h(
    Section,
    { title: "问题反馈" },
    h(
      "form",
      { className: "workagent-form", onSubmit: submit },
      h(
        Field,
        { label: "问题描述" },
        h("textarea", {
          required: true,
          maxLength: 2000,
          value: description,
          disabled: busy,
          onChange: (e) => edit(setDescription, e.target.value),
          "aria-label": "问题描述",
          className: "workagent-control",
        }),
      ),
      h(
        Field,
        { label: "复现步骤（可选）" },
        h("textarea", {
          maxLength: 4000,
          value: steps,
          disabled: busy,
          onChange: (e) => edit(setSteps, e.target.value),
          "aria-label": "复现步骤",
          className: "workagent-control",
        }),
      ),
      h(Input, {
        type: "file",
        multiple: true,
        disabled: busy,
        accept: "image/png,image/jpeg,image/webp,.json,.txt",
        "aria-label": "反馈附件",
        onChange: (e) => {
          const chosen = [...e.target.files];
          if (
            chosen.length > 4 ||
            chosen.filter((file) => file.type.startsWith("image/")).length >
              3 ||
            chosen.filter((file) => !file.type.startsWith("image/")).length >
              1 ||
            chosen.some((file) => file.size > 4 * 1024 * 1024)
          ) {
            setNotice("最多三张截图和一份诊断摘要，每份不超过 4 MiB。");
            return;
          }
          edit(setFiles, chosen);
        },
      }),
      ...files.map((file, index) =>
        h(
          "div",
          { key: index },
          previews[index]
            ? h("img", {
                src: previews[index],
                alt: file.name,
                style: { maxWidth: "160px", maxHeight: "120px" },
              })
            : null,
          h("span", null, file.name),
          h(
            Button,
            {
              type: "button",
              disabled: busy,
              onClick: () =>
                edit(
                  setFiles,
                  files.filter((_, i) => i !== index),
                ),
            },
            "移除",
          ),
        ),
      ),
      h(
        Button,
        {
          type: "button",
          disabled: busy,
          onClick: () =>
            setDiagnostic(
              JSON.stringify(
                {
                  capturedAt: new Date().toISOString(),
                  browser: navigator.userAgent,
                  page: location.pathname,
                  viewport: { width: innerWidth, height: innerHeight },
                  language: navigator.language,
                },
                null,
                2,
              ),
            ),
        },
        "预览诊断摘要",
      ),
      diagnostic
        ? h(
            "div",
            null,
            h("p", null, "确认以下摘要后，可作为附件提交。"),
            h("textarea", {
              className: "workagent-control",
              "aria-label": "诊断摘要",
              value: diagnostic,
              disabled: busy,
              onChange: (e) => setDiagnostic(e.target.value),
            }),
            h(
              Button,
              {
                type: "button",
                disabled: busy,
                onClick: () => {
                  edit(setFiles, [
                    ...files.filter((file) => file.type.startsWith("image/")),
                    new File([diagnostic], "diagnostic-summary.txt", {
                      type: "text/plain",
                    }),
                  ]);
                  setDiagnostic("");
                },
              },
              "附加这份摘要",
            ),
          )
        : null,
      h(
        Button,
        { type: "submit", disabled: busy },
        busy ? "提交中…" : "提交反馈",
      ),
    ),
    notice ? h("p", { role: "status" }, notice) : null,
    ...items.map((item) =>
      h(
        "details",
        { key: item.id },
        h(
          "summary",
          null,
          `${item.description.slice(0, 60)} · ${{ new: "待处理", in_progress: "处理中", resolved: "已解决" }[item.status]}`,
        ),
        h("p", null, item.description),
        h("p", null, item.steps),
        ...(item.attachments || []).map((a) =>
          h(
            "a",
            {
              key: a.id,
              href: `/api/system/feedback/${item.id}/attachments/${a.id}`,
              download: true,
            },
            a.name,
          ),
        ),
      ),
    ),
  );
}
