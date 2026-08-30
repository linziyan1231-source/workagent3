import type { ComponentType } from "react";

declare const SettingsModal: ComponentType<{
  visible: boolean;
  onCancel: () => void;
  defaultTab?: "model" | "tools" | "webui" | "system" | "about";
}>;
export default SettingsModal;
