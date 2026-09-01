import {
  engineEventSchema,
  runtimeApiSchemas,
  type CreateEngineSession,
  type EngineEvent,
  type EngineStatus,
  interactionApiSchemas,
  type PendingInteraction,
  type RuntimeMessage,
  type RuntimeMessageSearchResult,
  type RuntimeSession,
} from "@workagent/contracts";
import { requestJson } from "../../shared/api/http.js";

const runtimePath = "/api/runtime/v1/sessions";
const interactionPath = "/api/runtime/v1/interactions";
const enginePath = "/api/runtime/v1/engines";

export type ConversationPort = {
  create(input: CreateEngineSession): Promise<RuntimeSession>;
  engines(): Promise<EngineStatus[]>;
  get(sessionId: string): Promise<RuntimeSession>;
  fork(
    sessionId: string,
    messageId: string,
    replacementContent?: string,
  ): Promise<RuntimeSession>;
  list(): Promise<RuntimeSession[]>;
  messages(sessionId: string): Promise<RuntimeMessage[]>;
  searchMessages(
    keyword: string,
    page: number,
    pageSize: number,
  ): Promise<RuntimeMessageSearchResult>;
  pending(sessionId: string): Promise<PendingInteraction[]>;
  respond(interactionId: string, decision: "allow" | "reject"): Promise<void>;
  rename(sessionId: string, title: string): Promise<RuntimeSession>;
  remove(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  send(
    sessionId: string,
    content: string,
    displayContent?: string,
    messageId?: string,
  ): Promise<void>;
  subscribe(
    sessionId: string,
    listener: (event: EngineEvent) => void,
  ): () => void;
};

export const conversationPort: ConversationPort = {
  async create(input) {
    const value = await requestJson<unknown>(runtimePath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return runtimeApiSchemas.session.parse(value);
  },
  async engines() {
    return runtimeApiSchemas.engineStatusList.parse(
      await requestJson<unknown>(enginePath),
    );
  },
  async list() {
    return runtimeApiSchemas.sessionList.parse(
      await requestJson<unknown>(runtimePath),
    );
  },
  async get(sessionId) {
    return runtimeApiSchemas.session.parse(
      await requestJson<unknown>(
        `${runtimePath}/${encodeURIComponent(sessionId)}`,
      ),
    );
  },
  async fork(sessionId, messageId, replacementContent) {
    return runtimeApiSchemas.session.parse(
      await requestJson<unknown>(
        `${runtimePath}/${encodeURIComponent(sessionId)}/fork`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId, replacementContent }),
        },
      ),
    );
  },
  async messages(sessionId) {
    return runtimeApiSchemas.messageList.parse(
      await requestJson<unknown>(
        `${runtimePath}/${encodeURIComponent(sessionId)}/messages`,
      ),
    );
  },
  async searchMessages(keyword, page, pageSize) {
    const query = new URLSearchParams({
      keyword,
      page: String(page),
      page_size: String(pageSize),
    });
    return runtimeApiSchemas.messageSearchResult.parse(
      await requestJson<unknown>(
        `/api/runtime/v1/messages/search?${query.toString()}`,
      ),
    );
  },
  async pending(sessionId) {
    return interactionApiSchemas.pendingList.parse(
      await requestJson<unknown>(
        `${interactionPath}?sessionId=${encodeURIComponent(sessionId)}`,
      ),
    );
  },
  async respond(interactionId, decision) {
    interactionApiSchemas.response.parse(
      await requestJson<unknown>(
        `${interactionPath}/${encodeURIComponent(interactionId)}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      ),
    );
  },
  async rename(sessionId, title) {
    return runtimeApiSchemas.session.parse(
      await requestJson<unknown>(
        `${runtimePath}/${encodeURIComponent(sessionId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title }),
        },
      ),
    );
  },
  async remove(sessionId) {
    await requestJson(`${runtimePath}/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  },
  async cancel(sessionId) {
    await requestJson(
      `${runtimePath}/${encodeURIComponent(sessionId)}/cancel`,
      { method: "POST" },
    );
  },
  async send(sessionId, content, displayContent, messageId) {
    await requestJson(`${runtimePath}/${encodeURIComponent(sessionId)}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, displayContent, messageId }),
    });
  },
  subscribe(sessionId, listener) {
    const source = new EventSource(
      `${runtimePath}/${encodeURIComponent(sessionId)}/events`,
    );
    source.onmessage = (message) => {
      try {
        const parsed = engineEventSchema.safeParse(JSON.parse(message.data));
        if (parsed.success) listener(parsed.data);
      } catch {
        // Ignore a malformed event; EventSource will continue with the next ID.
      }
    };
    return () => source.close();
  },
};
