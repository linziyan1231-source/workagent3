import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { JsonLineRpc } from "./jsonl-rpc.js";

describe("JSONL RPC transport", () => {
  it("correlates responses while delivering notifications", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const rpc = new JsonLineRpc(fromServer, toServer);
    const notifications: string[] = [];
    rpc.onNotification((method) => notifications.push(method));

    const pending = rpc.request<{ ok: boolean }>("initialize", {});
    const sent = JSON.parse(String(toServer.read())) as { id: number };
    fromServer.write('{"method":"turn/started","params":{}}\n');
    fromServer.write(
      `${JSON.stringify({ id: sent.id, result: { ok: true } })}\n`,
    );

    await expect(pending).resolves.toEqual({ ok: true });
    expect(notifications).toEqual(["turn/started"]);
  });

  it("rejects pending requests when the transport closes", async () => {
    const fromServer = new PassThrough();
    const rpc = new JsonLineRpc(fromServer, new PassThrough());
    const pending = rpc.request("thread/start", {});
    fromServer.end();
    await expect(pending).rejects.toThrow("transport closed");
  });

  it("bounds an unresponsive native request", async () => {
    const rpc = new JsonLineRpc(new PassThrough(), new PassThrough());
    await expect(rpc.request("account/read", {}, 5)).rejects.toThrow(
      "account/read timed out",
    );
  });
});
