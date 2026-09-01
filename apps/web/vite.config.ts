import react from "@vitejs/plugin-react";
import UnoCSS from "unocss/vite";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import unoConfig from "./uno.config";

const aionSrc = fileURLToPath(
  new URL("../../third_party/aionui/packages/desktop/src", import.meta.url),
);
const webModules = fileURLToPath(new URL("./node_modules", import.meta.url));
const apiProxyTarget =
  process.env.WORKAGENT_WEB_API_TARGET ?? "http://127.0.0.1:8080";
const adapter = (name: string) =>
  fileURLToPath(new URL(`./src/shared/aion-adapter/${name}`, import.meta.url));

export default defineConfig({
  define: {
    "process.env.AIONUI_MULTI_INSTANCE": "undefined",
    "process.env.NODE_ENV": JSON.stringify(
      process.env.NODE_ENV ?? "development",
    ),
  },
  plugins: [react(), UnoCSS(unoConfig)],
  resolve: {
    alias: [
      { find: "react", replacement: `${webModules}/react` },
      { find: "react-dom", replacement: `${webModules}/react-dom` },
      {
        find: "@arco-design/web-react",
        replacement: `${webModules}/@arco-design/web-react`,
      },
      {
        find: "@icon-park/react",
        replacement: `${webModules}/@icon-park/react`,
      },
      { find: "@iconify/react", replacement: `${webModules}/@iconify/react` },
      {
        find: "@uiw/react-codemirror",
        replacement: `${webModules}/@uiw/react-codemirror`,
      },
      {
        find: "@sentry/electron/renderer",
        replacement: adapter("sentryRenderer.ts"),
      },
      {
        find: "@codemirror/lang-json",
        replacement: `${webModules}/@codemirror/lang-json`,
      },
      {
        find: "@codemirror/commands",
        replacement: `${webModules}/@codemirror/commands`,
      },
      {
        find: "@codemirror/lang-css",
        replacement: `${webModules}/@codemirror/lang-css`,
      },
      {
        find: "@codemirror/lang-html",
        replacement: `${webModules}/@codemirror/lang-html`,
      },
      {
        find: "@codemirror/lang-markdown",
        replacement: `${webModules}/@codemirror/lang-markdown`,
      },
      {
        find: "@codemirror/language",
        replacement: `${webModules}/@codemirror/language`,
      },
      {
        find: "@codemirror/language-data",
        replacement: `${webModules}/@codemirror/language-data`,
      },
      {
        find: "@codemirror/search",
        replacement: `${webModules}/@codemirror/search`,
      },
      {
        find: "@codemirror/state",
        replacement: `${webModules}/@codemirror/state`,
      },
      {
        find: "@codemirror/view",
        replacement: `${webModules}/@codemirror/view`,
      },
      {
        find: "@lezer/highlight",
        replacement: `${webModules}/@lezer/highlight`,
      },
      {
        find: "@monaco-editor/react",
        replacement: `${webModules}/@monaco-editor/react`,
      },
      {
        find: "@uiw/codemirror-extensions-langs",
        replacement: `${webModules}/@uiw/codemirror-extensions-langs`,
      },
      { find: "@dnd-kit/core", replacement: `${webModules}/@dnd-kit/core` },
      {
        find: "@dnd-kit/sortable",
        replacement: `${webModules}/@dnd-kit/sortable`,
      },
      {
        find: "@dnd-kit/utilities",
        replacement: `${webModules}/@dnd-kit/utilities`,
      },
      {
        find: "@floating-ui/react",
        replacement: `${webModules}/@floating-ui/react`,
      },
      {
        find: "@/common/adapter/ipcBridge",
        replacement: adapter("ipcBridge.ts"),
      },
      {
        find: "@/common/adapter/httpBridge",
        replacement: adapter("httpBridge.ts"),
      },
      { find: "classnames", replacement: `${webModules}/classnames` },
      { find: "dayjs", replacement: `${webModules}/dayjs` },
      { find: "croner", replacement: `${webModules}/croner` },
      {
        find: "@noble/hashes",
        replacement: `${webModules}/@noble/hashes`,
      },
      {
        find: "react-virtuoso",
        replacement: `${webModules}/react-virtuoso`,
      },
      { find: "streamdown", replacement: `${webModules}/streamdown` },
      { find: "diff2html", replacement: `${webModules}/diff2html` },
      { find: "eventemitter3", replacement: `${webModules}/eventemitter3` },
      { find: "i18next", replacement: `${webModules}/i18next` },
      { find: "json5", replacement: `${webModules}/json5` },
      { find: "react-i18next", replacement: `${webModules}/react-i18next` },
      {
        find: "react-router-dom",
        replacement: `${webModules}/react-router-dom`,
      },
      { find: "swr", replacement: `${webModules}/swr` },
      { find: "qrcode.react", replacement: `${webModules}/qrcode.react` },
      { find: "katex", replacement: `${webModules}/katex` },
      { find: "mermaid", replacement: `${webModules}/mermaid` },
      { find: "postcss", replacement: `${webModules}/postcss` },
      { find: "react-markdown", replacement: `${webModules}/react-markdown` },
      {
        find: "react-syntax-highlighter",
        replacement: `${webModules}/react-syntax-highlighter`,
      },
      { find: "rehype-katex", replacement: `${webModules}/rehype-katex` },
      { find: "rehype-raw", replacement: `${webModules}/rehype-raw` },
      { find: "rehype-sanitize", replacement: `${webModules}/rehype-sanitize` },
      { find: "remark-breaks", replacement: `${webModules}/remark-breaks` },
      { find: "remark-gfm", replacement: `${webModules}/remark-gfm` },
      { find: "remark-math", replacement: `${webModules}/remark-math` },
      { find: "semver", replacement: `${webModules}/semver` },
      { find: "wavedrom", replacement: `${webModules}/wavedrom` },
      { find: /^@\/common$/, replacement: adapter("common.ts") },
      {
        find: "@office-ai/platform",
        replacement: adapter("officePlatform.ts"),
      },
      {
        find: "@/common/config/configService",
        replacement: adapter("configService.ts"),
      },
      {
        find: "@/renderer/hooks/context/ConversationContext",
        replacement: adapter("conversationContext.tsx"),
      },
      {
        find: "@/renderer/hooks/context/AuthContext",
        replacement: adapter("authContext.tsx"),
      },
      {
        find: "@renderer/hooks/context/AuthContext",
        replacement: adapter("authContext.tsx"),
      },
      {
        find: "@/renderer/hooks/context/FeedbackContext",
        replacement: adapter("feedbackContext.ts"),
      },
      {
        find: "@renderer/hooks/context/NavigationHistoryContext",
        replacement: adapter("NavigationHistoryContext.tsx"),
      },
      {
        find: "@/renderer/hooks/context/NavigationHistoryContext",
        replacement: adapter("NavigationHistoryContext.tsx"),
      },
      {
        find: "@renderer/hooks/system/useDeepLink",
        replacement: adapter("layoutHooks.tsx"),
      },
      {
        find: "@renderer/hooks/system/notification/useNotificationClick",
        replacement: adapter("layoutHooks.tsx"),
      },
      {
        find: "@renderer/hooks/system/notification/useBrowserNotification",
        replacement: adapter("layoutHooks.tsx"),
      },
      {
        find: "@renderer/hooks/file/useDirectorySelection",
        replacement: adapter("layoutHooks.tsx"),
      },
      {
        find: "@renderer/hooks/ui/useConversationShortcuts",
        replacement: adapter("layoutHooks.tsx"),
      },
      {
        find: "@/renderer/components/layout/PwaPullToRefresh",
        replacement: adapter("PwaPullToRefresh.tsx"),
      },
      {
        find: "@/renderer/components/settings/UpdateModal",
        replacement: adapter("UpdateModal.tsx"),
      },
      {
        find: "./SharedInviteNotifications",
        replacement: adapter("EmptyRendererComponent.tsx"),
      },
      {
        find: "../WindowControls",
        replacement: adapter("EmptyRendererComponent.tsx"),
      },
      { find: "@/renderer/utils/emitter", replacement: adapter("emitter.ts") },
      {
        find: "@/renderer/components/chat/BtwOverlay/useBtwCommand",
        replacement: adapter("btwCommand.ts"),
      },
      {
        find: "@renderer/hooks/file/useConversationExport",
        replacement: adapter("conversationExport.ts"),
      },
      {
        find: "@renderer/hooks/file/useDragUpload",
        replacement: adapter("dragUpload.ts"),
      },
      {
        find: "@renderer/hooks/file/usePasteService",
        replacement: adapter("pasteService.ts"),
      },
      {
        find: "@renderer/pages/conversation/Messages/hooks",
        replacement: adapter("messageList.tsx"),
      },
      {
        find: "@renderer/pages/conversation/runtime/useConversationRuntimeView",
        replacement: adapter("messageRuntime.ts"),
      },
      {
        find: "@renderer/hooks/file/useAutoPreviewOfficeFiles",
        replacement: adapter("autoPreviewOfficeFiles.ts"),
      },
      {
        find: "../viewers/PDFViewer",
        replacement: adapter("BrowserPdfViewer.tsx"),
      },
      {
        find: /^@\/renderer\/pages\/conversation\/Preview$/,
        replacement: `${aionSrc}/renderer/pages/conversation/Preview/index.ts`,
      },
      {
        find: /^@renderer\/pages\/conversation\/Preview$/,
        replacement: `${aionSrc}/renderer/pages/conversation/Preview/index.ts`,
      },
      {
        find: "diff",
        replacement: fileURLToPath(
          new URL("./node_modules/diff/libesm/index.js", import.meta.url),
        ),
      },
      {
        find: "@renderer/services/FileService",
        replacement: adapter("fileService.ts"),
      },
      {
        find: "@/renderer/services/FileService",
        replacement: adapter("fileService.ts"),
      },
      {
        find: "@renderer/hooks/file/useUploadState",
        replacement: adapter("uploadState.ts"),
      },
      {
        find: "@renderer/hooks/file/useAbortUploadsOnConversationChange",
        replacement: adapter("abortUploads.ts"),
      },
      {
        find: "@/renderer/services/clientBusinessSettings",
        replacement: adapter("clientBusinessSettings.ts"),
      },
      {
        find: "@/renderer/components/settings/SettingsModal/contents/SystemModalContent/VoiceInputSection",
        replacement: adapter("ManagedVoiceInputSection.tsx"),
      },
      {
        find: "./VoiceInputSection",
        replacement: adapter("ManagedVoiceInputSection.tsx"),
      },
      {
        find: "@/renderer/hooks/system/useLiveTranscriptInsertion",
        replacement: adapter("liveTranscript.ts"),
      },
      {
        find: "@/renderer/hooks/config/useConfig",
        replacement: adapter("config.ts"),
      },
      {
        find: "@/renderer/utils/model/agentLogo",
        replacement: adapter("agentLogo.ts"),
      },
      {
        find: "@/renderer/hooks/agent/useManagedAgents",
        replacement: adapter("assistantHooks.ts"),
      },
      {
        find: "@/renderer/hooks/agent/useModelProviderList",
        replacement: adapter("assistantHooks.ts"),
      },
      {
        find: /^@\/?renderer\/pages\/cron$/,
        replacement: adapter("cronSummary.tsx"),
      },
      {
        find: "@/renderer/hooks/agent/usePresetAssistantInfo",
        replacement: adapter("presetAssistantInfo.ts"),
      },
      {
        find: /^@renderer\/pages\/settings\/ExtensionSettingsPage$/,
        replacement: fileURLToPath(
          new URL(
            "./src/shared/ui/aionui/AionExtensionSettingsPage.tsx",
            import.meta.url,
          ),
        ),
      },
      {
        find: "@/renderer/hooks/system/useExtI18n",
        replacement: adapter("extensionSettings.ts"),
      },
      {
        find: "@/renderer/hooks/system/useExtensionSettingsTabs",
        replacement: adapter("extensionSettings.ts"),
      },
      {
        find: "./contents/ExtensionSettingsTabContent",
        replacement: adapter("ExtensionSettingsTabContent.tsx"),
      },
      {
        find: "../../hooks/context/AuthContext",
        replacement: adapter("authContext.tsx"),
      },
      {
        find: /^@\/renderer\/services\/i18n$/,
        replacement: adapter("language.ts"),
      },
      {
        find: "@renderer/components/layout/AppLoader",
        replacement: adapter("AppLoader.tsx"),
      },
      {
        find: "@/renderer/pages/settings/components/SettingsSider",
        replacement: adapter("settingsSider.ts"),
      },
      {
        find: "@renderer/utils/platform",
        replacement: fileURLToPath(
          new URL("./src/shared/aion-adapter/platform.ts", import.meta.url),
        ),
      },
      {
        find: "@/renderer/utils/platform",
        replacement: fileURLToPath(
          new URL("./src/shared/aion-adapter/platform.ts", import.meta.url),
        ),
      },
      { find: "@renderer", replacement: `${aionSrc}/renderer` },
      { find: "@", replacement: aionSrc },
    ],
  },
  server: {
    proxy: {
      "/api": apiProxyTarget,
    },
  },
  test: {
    environment: "jsdom",
  },
});
