import type {
  PendingInteraction,
  RuntimeMessage,
} from "@workagent/contracts";
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
  interactions?: PendingInteraction[];
  loading?: boolean;
  processing?: boolean;
};

/** WorkAgent3 transcript boundary for the complete Web 78 MessageList. */
export function AionMessageList({
  conversationId,
  engine,
  workspace,
  messages,
  interactions = [],
  loading = false,
  processing = false,
}: Props) {
  const rendererMessages: RendererMessage[] = [
    ...messages.map<RendererMessage>((message, index) => ({
      id: message.id,
      conversation_id: conversationId,
      type: "text",
      content: { content: message.text },
      position: message.role === "user" ? "right" : "left",
      created_at: index,
    })),
    ...interactions.map<RendererMessage>((interaction) => ({
      id: interaction.id,
      conversation_id: conversationId,
      type: "acp_permission",
      content: {
        session_id: interaction.sessionId,
        options: [
          {
            option_id: "allow_permissions_turn",
            name: "Allow once",
            kind: "allow_once",
          },
          {
            option_id: "reject_permissions",
            name: "Reject",
            kind: "reject_once",
          },
        ],
        tool_call: {
          tool_call_id: interaction.turnId,
          title: interaction.tool,
          kind: "execute",
          raw_input: {
            description: interaction.summary,
            command: interaction.summary,
          },
        },
      },
      position: "left",
      created_at: Date.parse(interaction.createdAt),
    })),
  ];

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
