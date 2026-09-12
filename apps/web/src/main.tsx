import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import "./styles.css";
import "./shared/ui/typography.css";

const fontSize = localStorage.getItem("workagent.font-size") ?? "13";
const selectedFontSize = ["13", "14", "16", "18"].includes(fontSize)
  ? fontSize
  : "13";
document.documentElement.dataset.workagentFontSize = selectedFontSize;
document.documentElement.style.setProperty(
  "--workagent-font-scale",
  String(Number(selectedFontSize) / 14),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
