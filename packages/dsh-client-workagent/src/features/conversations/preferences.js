import { Select, Switch } from "../../ui/elements.js";
import React from "react";
import { createElement as h } from "react";

let conversationSettings;

const UPLOAD_PROJECT_KEY = "workagent.upload-to-project";

function useUploadToProject() {
  return React.useSyncExternalStore(
    (listener) => {
      window.addEventListener("workagent:upload-preference", listener);
      window.addEventListener("storage", listener);
      return () => {
        window.removeEventListener("workagent:upload-preference", listener);
        window.removeEventListener("storage", listener);
      };
    },
    () => localStorage.getItem(UPLOAD_PROJECT_KEY) !== "false",
  );
}

function UploadSettings() {
  const enabled = useUploadToProject();
  return h(
    "label",
    { className: "workagent-busy-setting" },
    h(
      "div",
      null,
      h("strong", null, "上传文件保存到当前项目"),
      h(
        "p",
        { className: "workagent-muted" },
        "开启后保存到项目根目录；关闭后作为会话附件保留。仅影响之后的上传。",
      ),
    ),
    h(Switch, {
      "aria-label": "上传文件保存到当前项目",
      checked: enabled,
      onChange: (checked) => {
        localStorage.setItem(UPLOAD_PROJECT_KEY, String(checked));
        window.dispatchEvent(new Event("workagent:upload-preference"));
      },
    }),
  );
}

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

export {
  conversationSettings,
  useUploadToProject,
  UploadSettings,
  useBusyEnter,
  BusyEnterSettings,
};

export function bindConversationSettings(value) {
  conversationSettings = value;
}
