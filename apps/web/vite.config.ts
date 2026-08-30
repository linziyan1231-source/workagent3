import react from "@vitejs/plugin-react";
import UnoCSS from "unocss/vite";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import unoConfig from "./uno.config";

const aionSrc = fileURLToPath(
  new URL("../../third_party/aionui/packages/desktop/src", import.meta.url),
);
const webModules = fileURLToPath(new URL("./node_modules", import.meta.url));
const adapter = (name: string) =>
  fileURLToPath(new URL(`./src/shared/aion-adapter/${name}`, import.meta.url));

export default defineConfig({
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
      { find: "classnames", replacement: `${webModules}/classnames` },
      { find: "i18next", replacement: `${webModules}/i18next` },
      { find: "react-i18next", replacement: `${webModules}/react-i18next` },
      {
        find: "react-router-dom",
        replacement: `${webModules}/react-router-dom`,
      },
      { find: "swr", replacement: `${webModules}/swr` },
      { find: "@renderer/assets/logos/brand/app.png", replacement: `${adapter("workagent-logo.svg")}?no-inline` },
      { find: "katex", replacement: `${webModules}/katex` },
      { find: "mermaid", replacement: `${webModules}/mermaid` },
      { find: "react-markdown", replacement: `${webModules}/react-markdown` },
      { find: "react-syntax-highlighter", replacement: `${webModules}/react-syntax-highlighter` },
      { find: "rehype-katex", replacement: `${webModules}/rehype-katex` },
      { find: "rehype-raw", replacement: `${webModules}/rehype-raw` },
      { find: "remark-breaks", replacement: `${webModules}/remark-breaks` },
      { find: "remark-gfm", replacement: `${webModules}/remark-gfm` },
      { find: "remark-math", replacement: `${webModules}/remark-math` },
      { find: /^@\/common$/, replacement: adapter("common.ts") },
      { find: "@office-ai/platform", replacement: adapter("officePlatform.ts") },
      { find: "@/renderer/hooks/context/ThemeContext", replacement: adapter("themeContext.ts") },
      { find: "@/renderer/hooks/context/ConversationContext", replacement: adapter("conversationContext.ts") },
      { find: "@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview", replacement: adapter("localFilePreview.ts") },
      { find: "@/renderer/pages/conversation/Preview", replacement: adapter("previewContext.ts") },
      { find: "@/renderer/utils/emitter", replacement: adapter("emitter.ts") },
      { find: "@/renderer/components/chat/BtwOverlay/useBtwCommand", replacement: adapter("btwCommand.ts") },
      { find: "@/renderer/components/chat/BtwOverlay", replacement: adapter("BtwOverlay.tsx") },
      { find: "@renderer/hooks/file/useConversationExport", replacement: adapter("conversationExport.ts") },
      { find: "@renderer/hooks/file/useDragUpload", replacement: adapter("dragUpload.ts") },
      { find: "@renderer/hooks/file/usePasteService", replacement: adapter("pasteService.ts") },
      { find: "@renderer/pages/conversation/Messages/hooks", replacement: adapter("messageList.ts") },
      { find: "@renderer/services/FileService", replacement: adapter("fileService.ts") },
      { find: "@renderer/hooks/file/useUploadState", replacement: adapter("uploadState.ts") },
      { find: "@renderer/hooks/file/useAbortUploadsOnConversationChange", replacement: adapter("abortUploads.ts") },
      { find: "@renderer/components/media/UploadProgressBar", replacement: adapter("UploadProgressBar.tsx") },
      { find: "@/renderer/components/chat/SpeechInputButton", replacement: adapter("SpeechInputButton.tsx") },
      { find: "@/renderer/hooks/system/useSpeechInput", replacement: adapter("speechInput.ts") },
      { find: "@/renderer/hooks/system/useLiveTranscriptInsertion", replacement: adapter("liveTranscript.ts") },
      { find: "@/renderer/hooks/config/useConfig", replacement: adapter("config.ts") },
      { find: "@/renderer/utils/model/agentLogo", replacement: adapter("agentLogo.ts") },
      { find: "@/renderer/pages/conversation/Messages/components/TeammateMessageAvatar", replacement: adapter("TeammateMessageAvatar.tsx") },
      { find: "@renderer/components/media/FilePreview", replacement: adapter("FilePreview.tsx") },
      { find: "@renderer/components/media/HorizontalFileList", replacement: adapter("HorizontalFileList.tsx") },
      { find: "@/renderer/hooks/system/useExtI18n", replacement: adapter("extensionSettings.ts") },
      { find: "@/renderer/hooks/system/useExtensionSettingsTabs", replacement: adapter("extensionSettings.ts") },
      { find: "../../hooks/context/AuthContext", replacement: adapter("authContext.tsx") },
      { find: /^@\/renderer\/services\/i18n$/, replacement: adapter("language.ts") },
      { find: "@renderer/components/layout/AppLoader", replacement: adapter("AppLoader.tsx") },
      { find: "@/renderer/pages/settings/components/SettingsSider", replacement: adapter("settingsSider.ts") },
      { find: "./contents/ModelModalContent", replacement: adapter("settings/ModelContent.tsx") },
      { find: "./contents/AgentModalContent", replacement: adapter("settings/AgentContent.tsx") },
      { find: "./contents/ToolsModalContent", replacement: adapter("settings/ToolsContent.tsx") },
      { find: "./contents/WebuiModalContent", replacement: adapter("settings/WebuiContent.tsx") },
      { find: "./contents/SystemModalContent", replacement: adapter("settings/SystemContent.tsx") },
      { find: "./contents/AboutModalContent", replacement: adapter("settings/AboutContent.tsx") },
      { find: "./contents/ExtensionSettingsTabContent", replacement: adapter("settings/ExtensionContent.tsx") },
      { find: "@/renderer/components/settings/SettingsModal/contents/ModelModalContent", replacement: adapter("settings/ModelContent.tsx") },
      { find: "@/renderer/components/settings/SettingsModal/contents/AgentModalContent", replacement: adapter("settings/AgentContent.tsx") },
      { find: "@/renderer/components/settings/SettingsModal/contents/ToolsModalContent", replacement: adapter("settings/ToolsContent.tsx") },
      { find: "@/renderer/components/settings/SettingsModal/contents/WebuiModalContent", replacement: adapter("settings/WebuiContent.tsx") },
      { find: "@/renderer/components/settings/SettingsModal/contents/SystemModalContent", replacement: adapter("settings/SystemContent.tsx") },
      { find: "@/renderer/components/settings/SettingsModal/contents/AboutModalContent", replacement: adapter("settings/AboutContent.tsx") },
      { find: "@/renderer/components/settings/SettingsModal/contents/ExtensionSettingsTabContent", replacement: adapter("settings/ExtensionContent.tsx") },
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
      "/api": "http://127.0.0.1:8080",
    },
  },
  test: {
    environment: "jsdom",
  },
});
