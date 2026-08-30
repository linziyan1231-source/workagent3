import type { ComponentType, ReactNode } from "react";

declare const MessageList: ComponentType<{
  className?: string;
  emptySlot?: ReactNode;
}>;

export default MessageList;
