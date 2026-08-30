import type { ComponentType } from "react";

export type AionTextMessage = {
  id: string;
  conversation_id: string;
  type: "text";
  content: { content: string };
  position: "left" | "right";
  created_at?: number;
};

declare const MessageText: ComponentType<{
  message: AionTextMessage;
  showCopyRow?: boolean;
}>;
export default MessageText;
