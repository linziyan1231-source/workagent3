import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
  type Dispatch,
  type SetStateAction,
} from "react";
import { conversationPort } from "../../features/conversation/conversationPort.js";

export type RendererMessage = Record<string, any> & {
  id: string;
  msg_id?: string;
  conversation_id: string;
  type: string;
};

type MessageAdapterState = {
  messages: RendererMessage[];
  setMessages: Dispatch<SetStateAction<RendererMessage[]>>;
  loading: boolean;
  setLoading: Dispatch<SetStateAction<boolean>>;
  processing: boolean;
};

const noop = () => undefined;
const MessageAdapterContext = createContext<MessageAdapterState>({
  messages: [],
  setMessages: noop as MessageAdapterState["setMessages"],
  loading: false,
  setLoading: noop as MessageAdapterState["setLoading"],
  processing: false,
});

export function WorkAgentMessageListProvider({
  messages,
  loading = false,
  processing = false,
  children,
}: PropsWithChildren<{
  messages: RendererMessage[];
  loading?: boolean;
  processing?: boolean;
}>) {
  const [current, setMessages] = useState(messages);
  const [currentLoading, setLoading] = useState(loading);
  useEffect(() => setMessages(messages), [messages]);
  useEffect(() => setLoading(loading), [loading]);
  const value = useMemo(
    () => ({
      messages: current,
      setMessages,
      loading: currentLoading,
      setLoading,
      processing,
    }),
    [current, currentLoading, processing],
  );
  return (
    <MessageAdapterContext.Provider value={value}>
      {children}
    </MessageAdapterContext.Provider>
  );
}

export function MessageListProvider({ children }: PropsWithChildren) {
  const [messages, setMessages] = useState<RendererMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const value = useMemo(
    () => ({ messages, setMessages, loading, setLoading, processing: false }),
    [loading, messages],
  );
  return (
    <MessageAdapterContext.Provider value={value}>
      {children}
    </MessageAdapterContext.Provider>
  );
}

export const MessageListLoadingProvider = ({ children }: PropsWithChildren) =>
  children;
export const MessagePaginationProvider = ({ children }: PropsWithChildren) =>
  children;
export const ChatKeyProvider = ({ children }: PropsWithChildren) => children;

export const useMessageAdapterState = () => useContext(MessageAdapterContext);
export const useMessageList = () => useMessageAdapterState().messages;
export const useMessageListLoading = () => useMessageAdapterState().loading;
export const useUpdateMessageList = () => useMessageAdapterState().setMessages;
export const useUpdateMessageListLoading = () =>
  useMessageAdapterState().setLoading;
export const useChatKey = () => "";

export const useMessagePaginationState = () => ({
  hasMoreBefore: false,
  hasMoreAfter: false,
  isLoadingBefore: false,
  isLoadingAnchor: false,
});
export const useUpdateMessagePaginationState = () => () => undefined;
export const useLoadPreviousMessagePage = () => async () => false;
export const useLoadAnchorMessageWindow = () => async () => false;

const messageKey = (message: RendererMessage) => message.msg_id ?? message.id;

const mergeMessage = (
  list: RendererMessage[],
  message: RendererMessage,
  add: boolean,
) => {
  const key = messageKey(message);
  const index = list.findIndex((item) => messageKey(item) === key);
  if (index < 0) return list.concat(message);
  if (add) return list;
  const next = list.slice();
  next[index] = { ...next[index], ...message };
  return next;
};

export const useMergeLiveMessage = () => {
  const update = useUpdateMessageList();
  return useCallback(
    (message: RendererMessage | undefined, add = false) => {
      if (message) update((list) => mergeMessage(list, message, add));
    },
    [update],
  );
};

export const useAddOrUpdateMessage = useMergeLiveMessage;

export const useRemoveMessageByMsgId = () => {
  const update = useUpdateMessageList();
  return useCallback(
    (msgId: string) =>
      update((list) => list.filter((message) => messageKey(message) !== msgId)),
    [update],
  );
};

export const useMessageLstCache = (conversationId: string) => {
  const update = useUpdateMessageList();
  const setLoading = useUpdateMessageListLoading();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void conversationPort
      .messages(conversationId)
      .then((messages) => {
        if (cancelled) return;
        const restored: RendererMessage[] = messages.map((message) => ({
          id: message.id,
          msg_id: message.id,
          conversation_id: message.sessionId,
          type: "text",
          position: message.role === "user" ? "right" : "left",
          created_at: Date.parse(message.createdAt),
          content: { content: message.text },
        }));
        update((current) => {
          let next = restored;
          for (const message of current)
            next = mergeMessage(next, message, false);
          return next;
        });
      })
      .catch((error) => {
        console.warn("[message-history] failed to restore messages", {
          conversationId,
          error,
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, setLoading, update]);
};
