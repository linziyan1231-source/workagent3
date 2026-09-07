import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import { expect, it, vi } from "vitest";
import { ApprovalBridge } from "./approval-bridge.js";

function fixture(home = mkdtempSync(join(tmpdir(), "wa-approval-"))) {
  let handler!: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>;
  let harness!: (request: ApprovalRequest) => Promise<unknown>;
  const dispose: Array<() => void> = [];
  const ctx = {
    effect: (effect: () => () => void) => {
      dispose.push(effect());
    },
    on: (_event: string, callback: typeof harness) => {
      harness = callback;
      return () => {};
    },
    webServer: {
      register: (route: { handler: typeof handler }) => {
        handler = route.handler;
        return () => {};
      },
    },
  };
  const publish = vi.fn();
  const bridge = new ApprovalBridge(ctx as never, "secret", home, publish);
  async function http(
    method: string,
    url: string,
    body?: unknown,
    token = "secret",
  ) {
    const request = Readable.from(
      body === undefined ? [] : [JSON.stringify(body)],
    ) as IncomingMessage;
    Object.assign(request, {
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    let status = 0;
    let result: unknown;
    const response = {
      writeHead: (code: number) => {
        status = code;
      },
      end: (text: string) => {
        result = JSON.parse(text);
      },
    } as ServerResponse;
    await handler(request, response);
    return { status, body: result };
  }
  return {
    bridge,
    publish,
    http,
    home,
    harness: (request: ApprovalRequest) => harness(request),
    dispose: () => dispose.forEach((fn) => fn()),
    saved: () =>
      JSON.parse(
        readFileSync(join(home, "workagent", "interactions.json"), "utf8"),
      ),
  };
}
const request = (signal = new AbortController().signal) => ({
  turnId: "native-t",
  tool: "Write",
  summary: "Write a file",
  input: { path: "a.txt" },
  options: [{ optionId: "allow-42", kind: "allow_once" }],
  signal,
});
it.each(["allow", "reject"] as const)(
  "persists a native request and resolves %s through the authenticated interaction API",
  async (decision) => {
    const f = fixture();
    const pending = f.bridge.requestNative("session-1", request());
    const rows = (await f.http("GET", "/v1/interactions?sessionId=session-1"))
      .body as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "session-1",
      turnId: "native-t",
      status: "pending",
      input: { path: "a.txt" },
      options: [{ optionId: "allow-42", kind: "allow_once" }],
    });
    expect(
      (
        await f.http(
          "POST",
          `/v1/interactions/${rows[0]!.id}/respond`,
          { decision },
          "wrong",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await f.http("POST", `/v1/interactions/${rows[0]!.id}/respond`, {
          decision,
        })
      ).body,
    ).toMatchObject({ accepted: true });
    expect(await pending).toBe(decision);
    expect(f.saved()[0].status).toBe(
      decision === "allow" ? "allowed" : "rejected",
    );
    expect(
      (
        await f.http("POST", `/v1/interactions/${rows[0]!.id}/respond`, {
          decision,
        })
      ).body,
    ).toMatchObject({ accepted: false });
    f.dispose();
  },
);
it("aborts a pending native approval and rejects a late allow", async () => {
  const f = fixture();
  const abort = new AbortController();
  const pending = f.bridge.requestNative("session-1", request(abort.signal));
  const id = f.saved()[0].id;
  abort.abort();
  expect(await pending).toBe("cancel");
  expect(f.saved()[0].status).toBe("cancelled");
  expect(
    (
      await f.http("POST", `/v1/interactions/${id}/respond`, {
        decision: "allow",
      })
    ).status,
  ).toBe(409);
  expect((await f.http("GET", "/v1/interactions")).body).toEqual([]);
  f.dispose();
});
it("settles native waits at teardown and restores crashed pending records as unavailable", async () => {
  const f = fixture();
  const pending = f.bridge.requestNative("session-1", request());
  const restored = fixture(f.home);
  expect(restored.saved()[0].status).toBe("unavailable");
  expect((await restored.http("GET", "/v1/interactions")).body).toEqual([]);
  f.dispose();
  expect(await pending).toBe("cancel");
  restored.dispose();
});
it("retains the original Harness approval outcome vocabulary", async () => {
  const f = fixture();
  const pending = f.harness({
    agent: {
      id: "session-h",
      session: { events: [{ type: "turn/start", data: { turn: 7 } }] },
    },
    toolName: "shell",
    reason: "Run shell",
    signal: new AbortController().signal,
  } as never);
  const id = f.saved()[0].id;
  await f.http("POST", `/v1/interactions/${id}/respond`, { decision: "allow" });
  expect(await pending).toBe("allowed-once");
  f.dispose();
});
it("does not publish a pre-aborted native request", async () => {
  const f = fixture();
  const abort = new AbortController();
  abort.abort();
  expect(await f.bridge.requestNative("session-1", request(abort.signal))).toBe(
    "cancel",
  );
  expect(f.publish).not.toHaveBeenCalled();
  f.dispose();
});

it("can cancel synchronously while publishing the native approval without leaving a live interaction", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.publish.mockImplementation((_session, event) => {
    if (event.type === "approval.requested") controller.abort();
  });
  expect(
    await f.bridge.requestNative("session-1", request(controller.signal)),
  ).toBe("cancel");
  expect(f.saved()[0].status).toBe("cancelled");
  expect((await f.http("GET", "/v1/interactions")).body).toEqual([]);
  f.dispose();
});
it("removes its abort listener on decision and keeps native payload snapshots independent", async () => {
  const f = fixture();
  const controller = new AbortController();
  const removed = vi.spyOn(controller.signal, "removeEventListener");
  const native = request(controller.signal);
  const pending = f.bridge.requestNative("session-1", native);
  native.input.path = "changed";
  const id = f.saved()[0].id;
  expect(f.saved()[0].input.path).toBe("a.txt");
  await f.http("POST", `/v1/interactions/${id}/respond`, { decision: "allow" });
  expect(await pending).toBe("allow");
  expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  controller.abort();
  expect(f.saved()[0].status).toBe("allowed");
  f.dispose();
});

it("exposes only live native approvals and enforces session ownership on public responses", async () => {
  const f = fixture();
  const pending = f.bridge.requestNative("session-native", request());
  const approval = f.bridge.pendingNative()[0]!;
  expect(approval.sessionId).toBe("session-native");
  expect(f.bridge.respondNative("other", approval.id, "allow")).toBe(false);
  expect(f.bridge.respondNative("session-native", approval.id, "reject")).toBe(
    true,
  );
  expect(await pending).toBe("reject");
  expect(f.bridge.pendingNative()).toEqual([]);
  expect(f.bridge.respondNative("session-native", approval.id, "reject")).toBe(
    false,
  );
  f.dispose();
});
