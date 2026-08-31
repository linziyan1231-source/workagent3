import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  imInboxDeliverySchema,
  type ImInboundMessage,
} from "@workagent/contracts";
import { authorized } from "./index.js";
import { InboxStore } from "./inbox-store.js";

export type InboxExecution = {
  receiptId: string;
  sessionId: string;
  title: string;
  input: string;
};

export type InboxRunnerPort = {
  executeInbox(input: InboxExecution): Promise<{ sessionId: string }>;
};

const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(value));
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  let value = "";
  for await (const chunk of request) {
    value += String(chunk);
    if (value.length > 2 * 1024 * 1024) throw new Error("request_too_large");
  }
  return JSON.parse(value);
};

const prompt = (message: ImInboundMessage): string => {
  const source = `${message.sender.display_name} via ${message.connector_id}`;
  const attachments = message.attachments
    .map((item) => `- ${item.name} (${item.content_type}, ${item.size} bytes)`)
    .join("\n");
  return [
    `[External message from ${source}]`,
    message.text,
    attachments === "" ? "" : `Attachments:\n${attachments}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
};

export const createInboxHandler =
  (token: string, store: InboxStore, runner: InboxRunnerPort) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!authorized(request, token))
      return json(response, 401, { error: "authentication_required" });
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }
    let begun: ReturnType<InboxStore["begin"]> | undefined;
    try {
      const delivery = imInboxDeliverySchema.parse(await readBody(request));
      begun = store.begin(delivery.message, delivery.session_id);
      if (begun.duplicate)
        return json(response, 200, {
          runtime_session_id: begun.receipt.sessionId,
          runtime_receipt_id: begun.receipt.id,
          duplicate: true,
        });
      const result = await runner.executeInbox({
        receiptId: begun.receipt.id,
        sessionId: begun.receipt.sessionId,
        title: `${delivery.message.connector_id} · ${delivery.message.sender.display_name}`,
        input: prompt(delivery.message),
      });
      store.complete(begun.receipt.id);
      return json(response, 200, {
        runtime_session_id: result.sessionId,
        runtime_receipt_id: begun.receipt.id,
        duplicate: false,
      });
    } catch (error) {
      if (begun !== undefined && !begun.duplicate)
        store.fail(begun.receipt.id, error);
      const code = error instanceof Error ? error.message : "invalid_request";
      if (code === "request_too_large")
        return json(response, 413, { error: code });
      if (code === "im_delivery_in_progress")
        return json(response, 409, { error: code });
      return json(response, 400, { error: "invalid_request" });
    }
  };

export class InboxController {
  constructor(
    ctx: Context,
    token: string,
    store: InboxStore,
    runner: InboxRunnerPort,
  ) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: "exact",
          path: "/v1/inbox/messages",
          handler: createInboxHandler(token, store, runner),
        }),
      "workagent-runtime-api: external IM inbox route",
    );
  }
}
