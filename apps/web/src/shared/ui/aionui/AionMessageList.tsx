import type { RuntimeMessage } from "@workagent/contracts";
import MessageList from "@renderer/pages/conversation/Messages/MessageList";
import { ConversationProvider } from "../../aion-adapter/conversationContext.js";
import {
  WorkAgentMessageListProvider,
  type RendererMessage,
} from "../../aion-adapter/messageList.js";

type Props = {
  conversationId: string;
  engine: "harness" | "codex" | "kimi";
  workspace?: string;
  messages: Array<Pick<RuntimeMessage, "id" | "role" | "text">>;
  loading?: boolean;
  processing?: boolean;
};

/** WorkAgent3 transcript boundary for the complete Web 78 MessageList. */
export function AionMessageList({
  conversationId,
  engine,
  workspace,
  messages,
  loading = false,
  processing = false,
}: Props) {
  const rendererMessages = messages.map<RendererMessage>((message, index) => ({
    id: message.id,
    conversation_id: conversationId,
    type: "text",
    content: { content: message.text },
    position: message.role === "user" ? "right" : "left",
    created_at: index,
  }));

  return (
    <ConversationProvider
      value={{
        conversation_id: conversationId,
        workspace,
        type: engine === "codex" ? "codex" : "acp",
        backend: engine,
      }}
    >
      <WorkAgentMessageListProvider
        messages={rendererMessages}
        loading={loading}
        processing={processing}
      >
        <MessageList className="flex-1" />
      </WorkAgentMessageListProvider>
    </ConversationProvider>
  );
}
