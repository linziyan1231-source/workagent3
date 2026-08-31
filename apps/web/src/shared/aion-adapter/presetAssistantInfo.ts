import type { TChatConversation } from "@/common/config/storage";

export type PresetAssistantInfo = {
  name: string;
  logo: string;
  isEmoji: boolean;
  isFallback?: boolean;
  backend?: string;
  assistantId?: string;
};

export function usePresetAssistantInfo(_conversation?: TChatConversation) {
  return {
    info: undefined as PresetAssistantInfo | undefined,
    isLoading: false,
  };
}
