import { useMessageAdapterState } from "./messageList.js";

export function useConversationRuntimeView() {
  const { processing } = useMessageAdapterState();
  return {
    view: { state: processing ? "processing" : "idle" },
    hydrated: true,
    state: processing ? "processing" : "idle",
    isProcessing: processing,
    canSendMessage: !processing,
    activeTurnId: null,
    markSendStarted: () => undefined,
    markSendAccepted: () => undefined,
    markSendFailed: () => undefined,
    markStopRequested: () => undefined,
    markStopAcknowledged: () => undefined,
    resetLocalGate: () => undefined,
  };
}
