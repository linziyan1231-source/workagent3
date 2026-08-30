import {
  engineEventSchema,
  runtimeApiSchemas,
  type CreateEngineSession,
  type EngineEvent,
  type EngineStatus,
  interactionApiSchemas,
  type PendingInteraction,
  type RuntimeSession,
} from "@workagent/contracts";
import { requestJson } from "../../shared/api/http.js";

const runtimePath = "/api/runtime/v1/sessions";
const interactionPath = "/api/runtime/v1/interactions";
const enginePath = "/api/runtime/v1/engines";

export type ConversationPort = {
  create(input: CreateEngineSession): Promise<RuntimeSession>;
  engines(): Promise<EngineStatus[]>;
  list(): Promise<RuntimeSession[]>;
  pending(sessionId: string): Promise<PendingInteraction[]>;
  respond(interactionId: string, decision: "allow" | "reject"): Promise<void>;
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
