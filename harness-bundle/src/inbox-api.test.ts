import { createServer, request } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createInboxHandler, type InboxExecution } from "./inbox-api.js";
import { InboxStore } from "./inbox-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

const call = (port: number, token: string | undefined, value: unknown) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = JSON.stringify(value);
    const req = request(
      {
        port,
        method: "POST",
        path: "/v1/inbox/messages",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += String(chunk)));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: text }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });

const delivery = {
  message: {
    connector_id: "weixin",
    external_account_id: "bot-1",
    external_conversation_id: "chat-1",
    external_message_id: "message-1",
    sender: { id: "wx-user", display_name: "Alice" },
    text: "hello",
    attachments: [],
    received_at: "2026-08-31T02:00:00Z",
  },
};

it("authenticates, deduplicates, and reuses an inbox session", async () => {
  const home = mkdtempSync(join(tmpdir(), "workagent-inbox-api-"));
  roots.push(home);
  const executions: InboxExecution[] = [];
  const store = new InboxStore(home);
  const server = createServer(
    createInboxHandler("runtime-token", store, {
      executeInbox: async (input) => {
        executions.push(input);
        return { sessionId: input.sessionId };
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("missing address");
    expect((await call(address.port, undefined, delivery)).status).toBe(401);
    const first = await call(address.port, "runtime-token", delivery);
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({ duplicate: false });
    const duplicate = await call(address.port, "runtime-token", delivery);
    expect(JSON.parse(duplicate.body)).toMatchObject({
      duplicate: true,
      runtime_session_id: executions[0]!.sessionId,
    });
    const secondMessage = structuredClone(delivery);
    secondMessage.message.external_message_id = "message-2";
    await call(address.port, "runtime-token", secondMessage);
    expect(executions).toHaveLength(2);
    expect(executions[1]!.sessionId).toBe(executions[0]!.sessionId);
    expect(executions[0]!.input).toContain(
      "[External message from Alice via weixin]",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("recovers an interrupted receipt as retryable after restart", () => {
  const home = mkdtempSync(join(tmpdir(), "workagent-inbox-recovery-"));
  roots.push(home);
  const store = new InboxStore(home);
  store.begin(delivery.message);
  const path = join(home, "workagent", "im-inbox.json");
  expect(readFileSync(path, "utf8")).toContain('"status":"processing"');
  new InboxStore(home);
  expect(readFileSync(path, "utf8")).toContain('"status":"failed"');
});
