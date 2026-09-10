import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import "./styles.css";

const fontSize = localStorage.getItem("workagent.font-size") ?? "13";
document.documentElement.style.setProperty(
  "--workagent-font-scale",
  String(
    (["13", "14", "16", "18"].includes(fontSize) ? Number(fontSize) : 13) / 14,
  ),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
