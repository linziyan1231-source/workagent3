import { createContext, useContext, type PropsWithChildren } from "react";

export type RendererMessage = {
  id: string;
  conversation_id: string;
  type: "text";
  content: { content: string };
  position: "left" | "right";
  created_at: number;
};

type MessageAdapterState = {
  messages: RendererMessage[];
  loading: boolean;
  processing: boolean;
};

const emptyState: MessageAdapterState = {
  messages: [],
  loading: false,
  processing: false,
};

const MessageAdapterContext = createContext(emptyState);

export function WorkAgentMessageListProvider({
  messages,
  loading = false,
  processing = false,
  children,
}: PropsWithChildren<MessageAdapterState>) {
  return (
    <MessageAdapterContext.Provider value={{ messages, loading, processing }}>
      {children}
    </MessageAdapterContext.Provider>
  );
}

export const useMessageAdapterState = () => useContext(MessageAdapterContext);
export const useMessageList = () => useMessageAdapterState().messages;
export const useMessageListLoading = () => useMessageAdapterState().loading;
export const useMessagePaginationState = () => ({
  hasMoreBefore: false,
  hasMoreAfter: false,
  isLoadingBefore: false,
  isLoadingAnchor: false,
});
export const useLoadPreviousMessagePage = () => async () => false;
export const useLoadAnchorMessageWindow = () => async () => false;

export const MessageListProvider = ({ children }: PropsWithChildren) => children;
export const MessageListLoadingProvider = ({ children }: PropsWithChildren) => children;
export const MessagePaginationProvider = ({ children }: PropsWithChildren) => children;
export const ChatKeyProvider = ({ children }: PropsWithChildren) => children;
export const useChatKey = () => "";
export const useUpdateMessagePaginationState = () => () => undefined;
export const useUpdateMessageList = () => () => undefined;
