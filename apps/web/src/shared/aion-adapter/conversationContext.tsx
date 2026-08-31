import { createContext, useContext, type PropsWithChildren } from "react";

export type ConversationContextValue = {
  conversation_id: string;
  workspace?: string;
  type: "acp" | "codex" | "aionrs";
  backend?: string;
  agentName?: string;
  hideSendBox?: boolean;
  loadedSkills?: string[];
  loadedMcpServers?: string[];
  assistantId?: string;
};

const ConversationContext = createContext<ConversationContextValue | null>(
  null,
);

export function ConversationProvider({
  value,
  children,
}: PropsWithChildren<{ value: ConversationContextValue }>) {
  return (
    <ConversationContext.Provider value={value}>
      {children}
    </ConversationContext.Provider>
  );
}

export function useConversationContext() {
  const value = useContext(ConversationContext);
  if (!value) throw new Error("ConversationProvider is required");
  return value;
}

export const useConversationContextSafe = () => useContext(ConversationContext);
