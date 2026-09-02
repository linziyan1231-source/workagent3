import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { sharedTurnRuntimeRequestSchema } from "@workagent/contracts";
import { SharedTurnController } from "./shared-turn-api.js";
import {
  QuotaSharedTurnRunner,
  SharedTurnQuotaJournal,
  estimatedAutomationUnits,
} from "./quota-runner.js";

describe("@workagent/shared-turn contract", () => {
  it("keeps the owner-runtime workspace and frozen run identity explicit", () => {
    const parsed = sharedTurnRuntimeRequestSchema.parse({
      runId: "run_1234567890123456",
      conversationId: "conversation_123456",
      projectId: "project_1234567890",
      engine: "codex",
      modelId: "gpt-5",
      thinkingEffort: "high",
      context: "[Alice]\nPlease help",
      recoveryContext: "[Alice]\nPlease help",
      workspacePath: "C:\\shared\\owner\\project_1234567890",
      payerSid: "S-1-5-21-2000",
    });
    expect(parsed.workspacePath).toContain("project_1234567890");
    expect(parsed.payerSid).toBe("S-1-5-21-2000");
    expect(parsed.runId).toBe("run_1234567890123456");
  });
});

type Handler = (request: RequestStub, response: ResponseStub) => Promise<void>;

class RequestStub {
  readonly headers = { authorization: "Bearer shared-turn-test-token" };
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

const sharedTurnRoute = (
  runner: ConstructorParameters<typeof SharedTurnController>[2],
): Handler => {
  let route: Handler | undefined;
  const context = {
    effect(register: () => unknown) {
      register();
    },
    webServer: {
      register(options: { handler: Handler }) {
        route = options.handler;
        return () => undefined;
      },
    },
  };
  new SharedTurnController(context as never, "shared-turn-test-token", runner);
  // The registered handler fires the async work without returning its
  // promise, so drive it and then wait for the response to materialize.
  return async (request, response) => {
    await route!(request, response);
    await vi.waitFor(() => expect(response.status).not.toBe(0));
  };
};

// The exact wire shape the Portal marshals and the UserHost relays after
// injecting workspacePath: camelCase contract fields, payerSid frozen at
// admission, and no runtimeSessionId on the first turn of a conversation.
const wireRequest = {
  runId: "run_1234567890123456",
  conversationId: "conversation_123456",
  projectId: "project_1234567890",
  engine: "codex",
  modelId: "gpt-5",
  thinkingEffort: "high",
  context: "[Bob]\nPlease answer",
  recoveryContext: "[Alice]\nhi\n[Bob]\nPlease answer",
  workspacePath: "C:\\shared\\owner\\project_1234567890",
  payerSid: "S-1-5-21-2000",
};

const settledReservation = {
  runId: wireRequest.runId,
  sid: wireRequest.payerSid,
  modelId: "gpt-5",
  period: "daily" as const,
  periodKey: "2026-09-02",
  reservedUnits: estimatedAutomationUnits(wireRequest.context),
  actualUnits: null,
  status: "settled" as const,
};

describe("SharedTurnController end-to-end contract", () => {
  it("accepts the portal/userhost wire request and bills the frozen payer", async () => {
    const executeSharedTurn = vi.fn(async () => ({
      runId: wireRequest.runId,
      runtimeSessionId: "session-shared-1",
      assistantBody: "Shared answer",
      recovered: false,
    }));
    const reserve = vi.fn(async () => settledReservation);
    const settle = vi.fn(async () => undefined);
    const route = sharedTurnRoute(
      new QuotaSharedTurnRunner(
        { executeSharedTurn, cancelSharedTurn: vi.fn() },
        { reserve, settle },
        new SharedTurnQuotaJournal(mkdtempSync(join(tmpdir(), "wire-quota-"))),
      ),
    );

    const response = new ResponseStub();
    await route(
      new RequestStub("POST", "/v1/shared-turns", JSON.stringify(wireRequest)),
      response,
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(response.value)).toMatchObject({
      runId: wireRequest.runId,
      assistantBody: "Shared answer",
    });
    expect(executeSharedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: wireRequest.runId,
        workspacePath: wireRequest.workspacePath,
        payerSid: wireRequest.payerSid,
      }),
    );
    expect(reserve).toHaveBeenCalledWith({
      runId: wireRequest.runId,
      modelId: "gpt-5",
      estimatedUnits: estimatedAutomationUnits(wireRequest.context),
      payerSid: wireRequest.payerSid,
    });
    expect(settle).toHaveBeenCalledWith({
      runId: wireRequest.runId,
      actualUnits: estimatedAutomationUnits(wireRequest.context),
      payerSid: wireRequest.payerSid,
    });
  });

  it("settles the payer reservation with zero usage when the turn fails", async () => {
    const settle = vi.fn(async () => undefined);
    const journal = new SharedTurnQuotaJournal(
      mkdtempSync(join(tmpdir(), "wire-quota-")),
    );
    const route = sharedTurnRoute(
      new QuotaSharedTurnRunner(
        {
          executeSharedTurn: vi.fn(async () => {
            throw new Error("engine_failed");
          }),
          cancelSharedTurn: vi.fn(),
        },
        { reserve: vi.fn(async () => settledReservation), settle },
        journal,
      ),
    );

    const response = new ResponseStub();
    await route(
      new RequestStub("POST", "/v1/shared-turns", JSON.stringify(wireRequest)),
      response,
    );

    expect(response.status).toBe(400);
    expect(settle).toHaveBeenCalledWith({
      runId: wireRequest.runId,
      actualUnits: 0,
      payerSid: wireRequest.payerSid,
    });
    expect(journal.pending()).toEqual([]);
  });
});
