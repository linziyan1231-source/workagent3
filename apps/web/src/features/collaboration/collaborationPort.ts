import { requestJson } from "../../shared/api/http.js";

export type SharedProject = {
  id: string;
  ownerUserId: number;
  name: string;
  state: string;
  currentRole: "owner" | "member";
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SharedConversation = {
  id: string;
  project_id: string;
  project_name: string;
  role: "owner" | "member";
  name: string;
  assistant_id: string;
  assistant_backend: "codex" | "kimi";
  model_id: string;
  thinking_effort: string;
  state: "idle" | "running" | "recovering" | "frozen";
  last_ai_message_seq: number;
  pinned: boolean;
  pinned_at?: string | null;
  hidden: boolean;
  created_at: string;
  updated_at: string;
};

export type SharedMessage = {
  seq: number;
  id: string;
  conversation_id: string;
  author_user_id?: number;
  author_name: string;
  kind: "user" | "assistant" | "system";
  body: string;
  mentions: Array<{ kind: "assistant" | "member" | "file"; id: string }>;
  attachments: string[];
  created_at: string;
  is_current_user: boolean;
};

export type SharedStreamMessage = {
  conversation_id: string;
  type: string;
  msg_id: string;
  created_at: number;
  data: Record<string, unknown>;
};

const streamListeners = new Set<(message: SharedStreamMessage) => void>();
let source: EventSource | null = null;
let consumers = 0;

const ensureStream = () => {
  if (source || typeof globalThis.EventSource === "undefined") return;
  const current = new EventSource("/api/portal/shared-events", {
    withCredentials: true,
  });
  source = current;
  current.addEventListener("message", (event) => {
    try {
      const envelope = JSON.parse(event.data) as {
        event?: string;
        payload?: SharedStreamMessage;
      };
      if (envelope.event !== "message.stream" || !envelope.payload) return;
      for (const listener of streamListeners) listener(envelope.payload);
    } catch {
      // EventSource preserves Last-Event-ID; malformed rows are ignored and
      // the next valid durable event can still be replayed.
    }
  });
  current.addEventListener("error", () => {
    if (current.readyState === EventSource.CLOSED && source === current)
      source = null;
  });
};

export const collaborationPort = {
  async listProjects(includeHidden = false) {
    return (
      await requestJson<{ projects: SharedProject[] }>(
        `/api/portal/shared-projects${includeHidden ? "?include_hidden=true" : ""}`,
      )
    ).projects;
  },
  async createProject(name: string) {
    return (
      await requestJson<{ project: SharedProject }>(
        "/api/portal/shared-projects",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        },
      )
    ).project;
  },
  async setProjectHidden(projectId: string, hidden: boolean) {
    await requestJson<void>(
      `/api/portal/shared-projects/${encodeURIComponent(projectId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hidden }),
      },
    );
  },
  async listConversations(includeHidden = false) {
    return (
      await requestJson<{ conversations: SharedConversation[] }>(
        `/api/portal/shared-conversations${includeHidden ? "?include_hidden=true" : ""}`,
      )
    ).conversations;
  },
  async getConversation(id: string) {
    return (
      await requestJson<{ conversation: SharedConversation }>(
        `/api/portal/shared-conversations?id=${encodeURIComponent(id)}`,
      )
    ).conversation;
  },
  async createConversation(
    input: Pick<
      SharedConversation,
      | "project_id"
      | "name"
      | "assistant_id"
      | "assistant_backend"
      | "model_id"
      | "thinking_effort"
    >,
  ) {
    return (
      await requestJson<{ conversation: SharedConversation }>(
        "/api/portal/shared-conversations",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      )
    ).conversation;
  },
  async setConversationHidden(conversationId: string, hidden: boolean) {
    return (
      await requestJson<{ conversation: SharedConversation }>(
        "/api/portal/shared-conversations",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversation_id: conversationId, hidden }),
        },
      )
    ).conversation;
  },
  async updateConversation(
    conversationId: string,
    updates: {
      name?: string;
      pinned?: boolean;
      hidden?: boolean;
      model_id?: string;
      thinking_effort?: string;
    },
  ) {
    return (
      await requestJson<{ conversation: SharedConversation }>(
        "/api/portal/shared-conversations",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversation_id: conversationId, ...updates }),
        },
      )
    ).conversation;
  },
  async listMessages(conversationId: string) {
    return (
      await requestJson<{ messages: SharedMessage[] }>(
        `/api/portal/shared-messages?conversation_id=${encodeURIComponent(conversationId)}&limit=200`,
      )
    ).messages;
  },
  async sendMessage(
    conversationId: string,
    body: string,
    mentions: SharedMessage["mentions"] = [],
    attachments: string[] = [],
  ) {
    return requestJson<{ message: SharedMessage; ai_started: boolean }>(
      "/api/portal/shared-messages",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          body,
          mentions,
          attachments,
        }),
      },
    );
  },
  onStream(listener: (message: SharedStreamMessage) => void) {
    streamListeners.add(listener);
    return () => streamListeners.delete(listener);
  },
  retainStream() {
    consumers++;
    ensureStream();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      consumers = Math.max(0, consumers - 1);
      if (consumers === 0) {
        source?.close();
        source = null;
      }
    };
  },
  reconnectStream() {
    source?.close();
    source = null;
    if (consumers > 0) ensureStream();
  },
};
