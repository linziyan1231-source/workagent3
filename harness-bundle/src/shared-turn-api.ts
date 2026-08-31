import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  sharedTurnRuntimeRequestSchema,
  sharedTurnResultSchema,
  type SharedTurnResult,
  type SharedTurnRuntimeRequest,
} from "@workagent/contracts";
import { authorized } from "./index.js";

export interface SharedTurnRunnerPort {
  executeSharedTurn(
    request: SharedTurnRuntimeRequest,
  ): Promise<SharedTurnResult>;
  cancelSharedTurn(runId: string): Promise<void>;
}

const json = (
  response: ServerResponse,
  status: number,
  value: unknown,
): void => {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(value));
};

const body = async (request: IncomingMessage): Promise<unknown> => {
  let value = "";
  for await (const chunk of request) {
    value += String(chunk);
    if (value.length > 800 * 1024) throw new Error("request_too_large");
  }
  return JSON.parse(value);
};

export class SharedTurnController {
  constructor(ctx: Context, token: string, runner: SharedTurnRunnerPort) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: "prefix",
          path: "/v1/shared-turns",
          handler: (request, response) =>
            void this.#handle(request, response, token, runner),
        }),
      "workagent-shared-turn: runtime route",
    );
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
    token: string,
    runner: SharedTurnRunnerPort,
  ): Promise<void> {
    if (!authorized(request, token)) {
      json(response, 401, { error: "authentication_required" });
      return;
    }
    const path = new URL(request.url ?? "/", "http://runtime").pathname;
    if (path === "/v1/shared-turns" && request.method === "POST") {
      try {
        const input = sharedTurnRuntimeRequestSchema.parse(await body(request));
        json(
          response,
          200,
          sharedTurnResultSchema.parse(await runner.executeSharedTurn(input)),
        );
      } catch (error) {
        json(response, 400, {
          error: error instanceof Error ? error.message : "shared_turn_failed",
        });
      }
      return;
    }
    const cancel = /^\/v1\/shared-turns\/([^/]+)\/cancel$/.exec(path);
    if (cancel !== null && request.method === "POST") {
      await runner.cancelSharedTurn(decodeURIComponent(cancel[1] ?? ""));
      response.writeHead(204);
      response.end();
      return;
    }
    json(response, 404, { error: "not_found" });
  }
}
