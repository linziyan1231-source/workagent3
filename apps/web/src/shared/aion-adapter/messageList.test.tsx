import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationPort } from "../../features/conversation/conversationPort.js";
import { ipcBridge } from "./common.js";
import {
  MessageListProvider,
  useMessageList,
  useMessageLstCache,
} from "./messageList.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function MessageProbe({ conversationId }: { conversationId: string }) {
  useMessageLstCache(conversationId);
  const messages = useMessageList();
  return (
    <div>{messages.map((message) => message.content?.content).join("|")}</div>
  );
}

describe("Renderer live message cache adapter", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(conversationPort, "messages").mockResolvedValue([]);
    vi.spyOn(conversationPort, "pending").mockResolvedValue([]);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("shows a formal response-stream message without reloading history", async () => {
    await act(async () => {
      root.render(
        <MessageListProvider>
          <MessageProbe conversationId="session-1" />
        </MessageListProvider>,
      );
    });

    await act(async () => {
      ipcBridge.acpConversation.responseStream.emit({
        type: "error",
        data: { message: "STALE_REPLAY" },
        msg_id: "old-error",
        conversation_id: "session-1",
        created_at: Date.now() - 60_000,
      });
      ipcBridge.acpConversation.responseStream.emit({
        type: "user_content",
        data: "LIVE_MESSAGE",
        msg_id: "message-1",
        conversation_id: "session-1",
        created_at: Date.now(),
        position: "right",
      });
    });

    expect(container.textContent).toContain("LIVE_MESSAGE");
    expect(container.textContent).not.toContain("STALE_REPLAY");
  });
});
