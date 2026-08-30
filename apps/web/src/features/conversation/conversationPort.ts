import {
  engineEventSchema,
  runtimeApiSchemas,
  type CreateEngineSession,
  type EngineEvent,
  type RuntimeSession,
} from "@workagent/contracts";
import { requestJson } from "../../shared/api/http.js";

const runtimePath = "/api/runtime/v1/sessions";

export type ConversationPort = {
  create(input: CreateEngineSession): Promise<RuntimeSession>;
  list(): Promise<RuntimeSession[]>;
  send(sessionId: string, content: string): Promise<void>;
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
  async list() {
    return runtimeApiSchemas.sessionList.parse(
      await requestJson<unknown>(runtimePath),
    );
  },
  async send(sessionId, content) {
    await requestJson(`${runtimePath}/${encodeURIComponent(sessionId)}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
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
