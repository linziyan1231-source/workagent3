import { lazy, Suspense } from "react";

const SettingsModal = lazy(
  () => import("@renderer/components/settings/SettingsModal"),
);

/** WorkAgent3 close-state adapter around the original Renderer SettingsModal. */
export function AionSettingsModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  return (
    <Suspense fallback={null}>
      <SettingsModal visible={visible} onCancel={onClose} />
    </Suspense>
  );
}
