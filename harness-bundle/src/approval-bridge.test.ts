import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalBridge } from "./approval-bridge.js";

type Handler = (request: RequestStub, response: ResponseStub) => Promise<void>;
type ApprovalHandler = (request: unknown) => Promise<string>;

class RequestStub {
  readonly headers = { authorization: "Bearer approval-test-token" };
  constructor(
    readonly method: string,
    readonly url: string,
    readonly value = "",
  ) {}
  async *[Symbol.asyncIterator]() {
    if (this.value !== "") yield Buffer.from(this.value);
  }
}

class ResponseStub {
  status = 0;
  value = "";
  writeHead(status: number) {
    this.status = status;
    return this;
  }
  end(value?: string) {
    this.value = value ?? "";
    return this;
  }
}

describe("ApprovalBridge", () => {
  it("persists before resolving and makes duplicate answers idempotent", async () => {
    let route: Handler | undefined;
    let answer: ApprovalHandler | undefined;
    const context = {
      effect(register: () => unknown) {
        register();
      },
      on(_event: string, handler: ApprovalHandler) {
        answer = handler;
        return () => undefined;
      },
      webServer: {
        register(options: { handler: Handler }) {
          route = options.handler;
          return () => undefined;
        },
      },
    };
    const home = mkdtempSync(join(tmpdir(), "workagent-approval-"));
    const events: unknown[] = [];
    new ApprovalBridge(
      context as never,
      "approval-test-token",
      home,
      (_sessionId, event) => events.push(event),
    );

    const outcome = answer!({
      agent: {
        id: "session-1",
        session: {
          events: [
            { type: "turn/start", data: { turn: 3 }, seq: 0, time: Date.now() },
          ],
        },
      },
      toolName: "pwsh",
      reason: "Run the build",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pendingResponse = new ResponseStub();
    await route!(
      new RequestStub("GET", "/v1/interactions?sessionId=session-1"),
      pendingResponse,
    );
    const pending = JSON.parse(pendingResponse.value);
    expect(pending).toMatchObject([
      { sessionId: "session-1", turnId: "turn-3", status: "pending" },
    ]);

    const respond = async () => {
      const response = new ResponseStub();
      await route!(
        new RequestStub(
          "POST",
          `/v1/interactions/${pending[0].id}/respond`,
          JSON.stringify({ decision: "allow" }),
        ),
        response,
      );
      return response;
    };
    expect(JSON.parse((await respond()).value)).toEqual({
      accepted: true,
      status: "allowed",
    });
    expect(await outcome).toBe("allowed-once");
    expect(JSON.parse((await respond()).value)).toEqual({
      accepted: false,
      status: "allowed",
    });
    expect(events).toHaveLength(2);
    expect(
      JSON.parse(
        readFileSync(join(home, "workagent", "interactions.json"), "utf8"),
      ),
    ).toMatchObject([{ status: "allowed" }]);
  });

  it("fails closed when a persisted approval no longer has a live resolver", async () => {
    let route: Handler | undefined;
    const context = {
      effect(register: () => unknown) {
        register();
      },
      on() {
        return () => undefined;
      },
      webServer: {
        register(options: { handler: Handler }) {
          route = options.handler;
          return () => undefined;
        },
      },
    };
    const home = mkdtempSync(join(tmpdir(), "workagent-approval-restart-"));
    const interactionPath = join(home, "workagent", "interactions.json");
    mkdirSync(join(home, "workagent"), { recursive: true });
    writeFileSync(
      interactionPath,
      JSON.stringify([
        {
          id: "interaction-restarted",
          sessionId: "session-1",
          turnId: "turn-4",
          kind: "approval",
          summary: "Delete generated files",
          tool: "pwsh",
          status: "pending",
          createdAt: "2026-08-31T06:00:00.000Z",
        },
      ]),
    );
    const events: unknown[] = [];
    new ApprovalBridge(
      context as never,
      "approval-test-token",
      home,
      (_sessionId, event) => events.push(event),
    );

    const pendingResponse = new ResponseStub();
    await route!(
      new RequestStub("GET", "/v1/interactions?sessionId=session-1"),
      pendingResponse,
    );
    expect(JSON.parse(pendingResponse.value)).toMatchObject([
      { id: "interaction-restarted", status: "pending" },
    ]);

    const response = new ResponseStub();
    await route!(
      new RequestStub(
        "POST",
        "/v1/interactions/interaction-restarted/respond",
        JSON.stringify({ decision: "allow" }),
      ),
      response,
    );
    expect(response.status).toBe(409);
    expect(JSON.parse(response.value)).toEqual({
      error: "interaction_no_longer_live",
    });
    expect(JSON.parse(readFileSync(interactionPath, "utf8"))).toMatchObject([
      { id: "interaction-restarted", status: "unavailable" },
    ]);
    expect(events).toMatchObject([
      {
        type: "approval.resolved",
        approvalId: "interaction-restarted",
        outcome: "unavailable",
      },
    ]);
  });
});
