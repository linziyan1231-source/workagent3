import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { platformQuotaConfiguration } from "./quota-client.js";
import { WorkspaceStore } from "./workspace-store.js";
import type { CompletionNotifications } from "./completion-notifications.js";

export const collaborationId = (id: string) =>
  id.startsWith("collaboration:") ? id.slice(14) : undefined;
type Speech = {
  seq: number;
  id: string;
  conversation_id: string;
  author_name: string;
  body: string;
  kind: string;
  created_at: string;
  attachments: string[];
};
type Access = {
  conversation: { id: string; name: string; project_id: string };
  project: { id: string; name: string; ownerSid: string };
};

// Portal supplies membership-filtered speech; no human/status event is pushed.
export class CollaborationChannels {
  readonly #config;
  readonly #path: string;
  readonly #stores = new Map<string, WorkspaceStore>();
  #cursor: number | undefined;
  #polling = false;
  constructor(
    readonly home: string,
    readonly sharedRoot: string,
    configuration: NonNullable<ReturnType<typeof platformQuotaConfiguration>>,
  ) {
    this.#config = configuration;
    this.#path = join(
      home,
      "workagent",
      "collaboration-notification-cursor.json",
    );
    if (existsSync(this.#path))
      this.#cursor = JSON.parse(readFileSync(this.#path, "utf8")).cursor;
  }
  static fromEnvironment(home: string) {
    const config = platformQuotaConfiguration(process.env),
      root = process.env.WORKAGENT_SHARED_ROOT;
    return config && root
      ? new CollaborationChannels(home, root, config)
      : undefined;
  }
  async request<T>(
    action: string,
    input: Record<string, unknown> = {},
  ): Promise<T> {
    const response = await fetch(
      new URL("internal/runtime/collaboration", this.#config.baseURL),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...input, action, sid: this.#config.sid }),
        signal: AbortSignal.timeout(30000),
      },
    );
    const value = (await response.json()) as T & { error?: string };
    if (!response.ok)
      throw new Error(value.error || "collaboration_unavailable");
    return value;
  }
  access(id: string) {
    return this.request<Access>("access", { conversationId: id });
  }
  history(id: string, limit: number, head = 0, before = 0) {
    return this.request<{ messages: Speech[]; head: number }>("history", {
      conversationId: id,
      limit,
      head,
      before,
    });
  }
  async workspace(id: string) {
    const access = await this.access(id);
    const sid = access.project.ownerSid;
    let store = this.#stores.get(sid);
    if (!store) {
      store = new WorkspaceStore(
        join(dirname(this.sharedRoot), sid),
        join(this.home, "collaboration-files", sid),
        true,
      );
      this.#stores.set(sid, store);
    }
    return { store, projectId: access.project.id, access };
  }
  async poll(notifications: CompletionNotifications) {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const page = await this.request<{ cursor: number; messages: Speech[] }>(
        "feed",
        { after: this.#cursor },
      );
      for (const message of page.messages) {
        if (message.kind !== "assistant") continue;
        const sessionId = `collaboration:${message.conversation_id}`;
        if (!notifications.enabledFor(sessionId)) continue;
        let access: Access;
        try {
          access = await this.access(message.conversation_id);
        } catch (error) {
          if (
            error instanceof Error &&
            ["shared_project_not_found", "shared_project_forbidden"].includes(
              error.message,
            )
          )
            continue;
          throw error;
        }
        await notifications.complete({
          sessionId,
          turnId: message.id,
          title: access.conversation.name,
          reply: message.body,
          workspaceId: access.project.id,
          startedAt: message.created_at,
          collaboration: {
            conversationId: message.conversation_id,
            projectName: access.project.name,
            assistantName: message.author_name,
          },
        });
      }
      this.#cursor = page.cursor;
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(
        `${this.#path}.tmp`,
        JSON.stringify({ cursor: this.#cursor }),
        { mode: 0o600 },
      );
      renameSync(`${this.#path}.tmp`, this.#path);
    } finally {
      this.#polling = false;
    }
  }
}
