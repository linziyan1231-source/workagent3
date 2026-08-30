import type { ReactNode } from "react";

export default function ConversationSearchPopover({
  renderTrigger,
}: {
  renderTrigger: (props: { onClick: () => void }) => ReactNode;
}) {
  return renderTrigger({ onClick: () => undefined });
}
