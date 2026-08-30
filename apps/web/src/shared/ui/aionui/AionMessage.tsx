import { lazy, Suspense } from "react";
import type { AionTextMessage } from "@renderer/pages/conversation/Messages/components/MessageText";

const MessageText = lazy(
  () => import("@renderer/pages/conversation/Messages/components/MessageText"),
);

type Props = {
  conversationId: string;
  id: string;
  role: "user" | "assistant";
  text: string;
};

/** Maps WorkAgent3 transcript records into the original Renderer text message. */
export function AionMessage({ conversationId, id, role, text }: Props) {
  const position = role === "user" ? "right" : "left";
  const message: AionTextMessage = {
    id,
    conversation_id: conversationId,
    type: "text",
    content: { content: text },
    position,
  };

  return (
    <div
      id={`message-${id}`}
      data-testid={`message-text-${position}`}
      data-message-type="text"
      data-message-position={position}
      className={`chat-surface-fluid min-w-0 flex items-start message-item [&>div]:max-w-full px-8px m-t-10px text ${position === "right" ? "justify-end" : "justify-start"}`}
    >
      <Suspense fallback={null}>
        <MessageText message={message} showCopyRow />
      </Suspense>
    </div>
  );
}
