import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ImInboundMessage } from "@workagent/contracts";

type InboxReceipt = {
  id: string;
  key: string;
  conversationKey: string;
  sessionId: string;
  status: "processing" | "delivered" | "failed";
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type InboxDocument = {
  version: 1;
  receipts: InboxReceipt[];
  conversations: Record<string, string>;
};

const empty = (): InboxDocument => ({
  version: 1,
  receipts: [],
  conversations: {},
});

export class InboxStore {
  readonly #path: string;
  #document: InboxDocument;

  constructor(dshHome: string) {
    this.#path = join(dshHome, "workagent", "im-inbox.json");
    this.#document = this.#read();
    let recovered = false;
    for (const receipt of this.#document.receipts) {
      if (receipt.status === "processing") {
        receipt.status = "failed";
        receipt.error = "runtime_restarted";
        receipt.updatedAt = new Date().toISOString();
        recovered = true;
      }
    }
    if (recovered) this.#write();
  }

  begin(
    message: ImInboundMessage,
    requestedSessionId?: string,
  ): {
    receipt: InboxReceipt;
    duplicate: boolean;
  } {
    const key = this.#messageKey(message);
    const existing = this.#document.receipts.find(
      (receipt) => receipt.key === key,
    );
    if (existing?.status === "delivered")
      return { receipt: structuredClone(existing), duplicate: true };
    if (existing?.status === "processing")
      throw new Error("im_delivery_in_progress");
    const now = new Date().toISOString();
    if (existing !== undefined) {
      existing.status = "processing";
      existing.error = null;
      existing.updatedAt = now;
      this.#write();
      return { receipt: structuredClone(existing), duplicate: false };
    }
    const conversationKey = this.#conversationKey(message);
    const sessionId =
      requestedSessionId ??
      this.#document.conversations[conversationKey] ??
      `session-inbox-${randomUUID()}`;
    this.#document.conversations[conversationKey] = sessionId;
    const receipt: InboxReceipt = {
      id: `inbox-${randomUUID()}`,
      key,
      conversationKey,
      sessionId,
      status: "processing",
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#document.receipts.push(receipt);
    this.#write();
    return { receipt: structuredClone(receipt), duplicate: false };
  }

  complete(id: string): InboxReceipt {
    const receipt = this.#required(id);
    receipt.status = "delivered";
    receipt.error = null;
    receipt.updatedAt = new Date().toISOString();
    this.#write();
    return structuredClone(receipt);
  }

  fail(id: string, error: unknown): void {
    const receipt = this.#required(id);
    receipt.status = "failed";
    receipt.error = error instanceof Error ? error.message : "delivery_failed";
    receipt.updatedAt = new Date().toISOString();
    this.#write();
  }

  #required(id: string): InboxReceipt {
    const receipt = this.#document.receipts.find((item) => item.id === id);
    if (receipt === undefined) throw new Error("im_receipt_not_found");
    return receipt;
  }

  #messageKey(message: ImInboundMessage): string {
    return JSON.stringify([
      message.connector_id,
      message.external_account_id,
      message.external_message_id,
    ]);
  }

  #conversationKey(message: ImInboundMessage): string {
    return JSON.stringify([
      message.connector_id,
      message.external_account_id,
      message.external_conversation_id,
    ]);
  }

  #read(): InboxDocument {
    try {
      const parsed = JSON.parse(
        readFileSync(this.#path, "utf8"),
      ) as InboxDocument;
      if (parsed.version !== 1 || !Array.isArray(parsed.receipts))
        throw new Error("invalid_im_inbox_document");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw error;
    }
  }

  #write(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.#document), { mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}
