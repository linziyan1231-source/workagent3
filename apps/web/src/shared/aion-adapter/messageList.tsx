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
import { collaborationPort } from "../../features/collaboration/collaborationPort.js";
import { ipcBridge } from "./common.js";

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

type LiveResponseMessage = Parameters<
  typeof ipcBridge.acpConversation.responseStream.emit
>[0];

const toLiveRendererMessage = (
  message: LiveResponseMessage,
): RendererMessage | undefined => {
  if (message.type === "teammate_message") {
    const data = message.data as RendererMessage;
    return { ...data, id: data.id ?? message.msg_id };
  }
  if (
    message.type === "text" ||
    message.type === "content" ||
    message.type === "user_content"
  ) {
    return {
      id: message.msg_id,
      msg_id: message.msg_id,
      conversation_id: message.conversation_id,
      type: "text",
      position:
        message.position ??
        (message.type === "user_content" ? "right" : "left"),
      created_at: message.created_at ?? Date.now(),
      status: message.status,
      content: {
        content:
          typeof message.data === "string"
            ? message.data
            : JSON.stringify(message.data),
        ...(message.replace === true ? { replace: true } : {}),
      },
    };
  }
  if (message.type === "error") {
    const errorData = message.data as { message?: unknown } | null;
    const content =
      typeof message.data === "string"
        ? message.data
        : typeof errorData?.message === "string"
          ? errorData.message
          : JSON.stringify(message.data);
    return {
      id: message.msg_id,
      msg_id: message.msg_id,
      conversation_id: message.conversation_id,
      type: "tips",
      position: "center",
      created_at: message.created_at ?? Date.now(),
      content: { content, type: "error" },
    };
  }
  return undefined;
};

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
    const shared = conversationId.startsWith("shared:");
    const restoredMessages: Promise<RendererMessage[]> = shared
      ? collaborationPort
          .listMessages(conversationId.slice("shared:".length))
          .then((messages) =>
            messages.map((message) => ({
              id: message.id,
              msg_id: message.id,
              conversation_id: conversationId,
              type: "text",
              position:
                message.kind === "system"
                  ? "center"
                  : message.is_current_user
                    ? "right"
                    : "left",
              created_at: Date.parse(message.created_at),
              content: {
                content: message.body,
                teammateMessage: message.kind === "user",
                senderName: message.author_name,
                senderUserId: message.author_user_id
                  ? String(message.author_user_id)
                  : undefined,
              },
            })),
          )
      : conversationPort.messages(conversationId).then((messages) =>
          messages.map((message) => ({
            id: message.id,
            msg_id: message.id,
            conversation_id: message.sessionId,
            type: "text",
            position: message.role === "user" ? "right" : "left",
            created_at: Date.parse(message.createdAt),
            content: { content: message.text },
          })),
        );
    void Promise.all([
      restoredMessages,
      shared
        ? Promise.resolve([])
        : conversationPort.pending(conversationId).catch(() => []),
    ])
      .then(([restored, pending]) => {
        if (cancelled) return;
        for (const interaction of pending) {
          restored.push({
            id: `confirmation:${interaction.id}`,
            msg_id: `confirmation:${interaction.id}`,
            conversation_id: conversationId,
            type: "permission",
            position: "left",
            created_at: Date.parse(interaction.createdAt),
            content: {
              id: interaction.id,
              call_id: interaction.id,
              title: interaction.tool,
              action: "exec",
              description: interaction.summary,
              command_type: interaction.tool,
              options: [
                { label: "Allow once", value: "allow_once" },
                { label: "Decline", value: "decline" },
              ],
            },
          });
        }
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

  useEffect(() => {
    const subscribedAt = Date.now();
    const off = ipcBridge.acpConversation.responseStream.on((message) => {
      if (message.conversation_id !== conversationId) return;
      if (
        typeof message.created_at === "number" &&
        message.created_at < subscribedAt - 1_000
      )
        return;
      const transformed = toLiveRendererMessage(message);
      if (transformed) update((list) => mergeMessage(list, transformed, false));
    });
    return () => {
      off();
    };
  }, [conversationId, update]);
};
