import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import { AionRendererProvider } from "./shared/ui/aionui/AionRendererProvider.js";
import "./shared/ui/aionui/i18n.js";
import "@arco-design/web-react/es/_util/react-19-adapter";
import "@arco-design/web-react/dist/css/arco.css";
import "virtual:uno.css";
import "./styles.css";
import "./shared/ui/aionui/aionui.css";
import "../../../third_party/aionui/packages/desktop/src/renderer/styles/arco-override.css";
import "../../../third_party/aionui/packages/desktop/src/renderer/styles/themes/index.css";
import "../../../third_party/aionui/packages/desktop/src/renderer/styles/markdown.css";
import "../../../third_party/aionui/packages/desktop/src/renderer/styles/layout.css";
import "../../../third_party/aionui/packages/desktop/src/renderer/pages/login/LoginPage.css";
import "../../../third_party/aionui/packages/desktop/src/renderer/components/chat/SendBox/sendbox.css";
import "../../../third_party/aionui/packages/desktop/src/renderer/pages/conversation/Messages/messages.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AionRendererProvider>
      <App />
    </AionRendererProvider>
  </StrictMode>,
);
