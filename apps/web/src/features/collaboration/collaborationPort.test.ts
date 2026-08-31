import { afterEach, describe, expect, it, vi } from "vitest";
import { collaborationPort } from "./collaborationPort.js";

afterEach(() => {
  vi.unstubAllGlobals();
  collaborationPort.reconnectStream();
});

describe("collaboration HTTP/SSE client port", () => {
  it("creates formal shared conversations through the Collaboration API", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            conversation: {
              id: "conversation-1",
              project_id: "project-1",
              project_name: "Design",
              role: "owner",
              name: "Review",
              assistant_id: "codex",
              assistant_backend: "codex",
              model_id: "codex-native",
              thinking_effort: "medium",
              state: "idle",
              last_ai_message_seq: 0,
              pinned: false,
              hidden: false,
              created_at: "2026-09-01T00:00:00Z",
              updated_at: "2026-09-01T00:00:00Z",
            },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    const conversation = await collaborationPort.createConversation({
      project_id: "project-1",
      name: "Review",
      assistant_id: "codex",
      assistant_backend: "codex",
      model_id: "codex-native",
      thinking_effort: "medium",
    });

    expect(conversation.id).toBe("conversation-1");
    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/shared-conversations",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("delivers durable shared message envelopes from the formal EventSource", () => {
    class FakeEventSource {
      static readonly CLOSED = 2;
      static latest: FakeEventSource;
      readonly listeners = new Map<string, (event: MessageEvent) => void>();
      readyState = 1;

      constructor(
        readonly url: string,
        readonly options: EventSourceInit,
      ) {
        FakeEventSource.latest = this;
      }

      addEventListener(name: string, listener: EventListener) {
        this.listeners.set(name, listener as (event: MessageEvent) => void);
      }

      close() {
        this.readyState = FakeEventSource.CLOSED;
      }

      emit(payload: unknown) {
        this.listeners.get("message")?.({
          data: JSON.stringify(payload),
        } as MessageEvent);
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const received = vi.fn();
    const offMessage = collaborationPort.onStream(received);
    const release = collaborationPort.retainStream();

    FakeEventSource.latest.emit({
      event: "message.stream",
      payload: {
        conversation_id: "shared:conversation-1",
        type: "teammate_message",
        msg_id: "message-1",
        created_at: 1,
        data: { content: { content: "hello" } },
      },
    });

    expect(FakeEventSource.latest.url).toBe("/api/portal/shared-events");
    expect(FakeEventSource.latest.options.withCredentials).toBe(true);
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({ msg_id: "message-1" }),
    );
    offMessage();
    release();
  });

  it("updates formal shared conversation metadata through one resource", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ conversation: { id: "conversation-1" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    await collaborationPort.updateConversation("conversation-1", {
      name: "Renamed",
      pinned: true,
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/shared-conversations",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          name: "Renamed",
          pinned: true,
        }),
      }),
    );
  });

  it("cancels a shared AI turn through the collaboration port", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ stopped: true }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);

    await collaborationPort.cancelTurn("conversation-1");

    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/shared-runs/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ conversation_id: "conversation-1" }),
      }),
    );
  });
});
