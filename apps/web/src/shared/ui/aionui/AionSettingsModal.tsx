import SettingsModal from "@renderer/components/settings/SettingsModal";
import { MemoryRouter } from "react-router-dom";

/** WorkAgent3 close-state adapter around the original Renderer SettingsModal. */
export function AionSettingsModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <MemoryRouter>
      <SettingsModal visible={visible} onCancel={onClose} />
    </MemoryRouter>
  );
}
