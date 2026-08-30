import SettingsModal from "@renderer/components/settings/SettingsModal";

/** WorkAgent3 close-state adapter around the original Renderer SettingsModal. */
export function AionSettingsModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  return <SettingsModal visible={visible} onCancel={onClose} />;
}
