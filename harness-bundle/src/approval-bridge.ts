import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import type {
  ApprovalOutcome,
  ApprovalRequest,
} from "@deepseek-ai/dsh-user-approval";
import { authorized } from "./index.js";

export type InteractionStatus =
  | "pending"
  | "allowed"
  | "rejected"
  | "cancelled"
  | "unavailable";

export type PendingInteraction = {
  id: string;
  sessionId: string;
  turnId: string;
  kind: "approval";
  summary: string;
  tool: string;
  status: InteractionStatus;
  createdAt: string;
  resolvedAt?: string;
};

type InteractionEvent =
  | {
      type: "approval.requested";
      turnId: string;
      approvalId: string;
      summary: string;
    }
  | {
      type: "approval.resolved";
      turnId: string;
      approvalId: string;
      outcome: Exclude<InteractionStatus, "pending">;
    };

type Resolver = (outcome: ApprovalOutcome) => void;

const valid = (value: unknown): value is PendingInteraction => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.sessionId === "string" &&
    typeof item.turnId === "string" &&
    item.kind === "approval" &&
    typeof item.summary === "string" &&
    typeof item.tool === "string" &&
    (item.status === "pending" ||
      item.status === "allowed" ||
      item.status === "rejected" ||
      item.status === "cancelled" ||
      item.status === "unavailable") &&
    typeof item.createdAt === "string" &&
    (item.resolvedAt === undefined || typeof item.resolvedAt === "string")
  );
};

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

const input = async (
  request: IncomingMessage,
): Promise<Record<string, unknown>> => {
  let text = "";
  for await (const chunk of request) {
    text += String(chunk);
    if (text.length > 16 * 1024) throw new Error("request_too_large");
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("object_required");
  return parsed as Record<string, unknown>;
};

export class ApprovalBridge {
  readonly #path: string;
  readonly #token: string;
  readonly #interactions = new Map<string, PendingInteraction>();
  readonly #resolvers = new Map<string, Resolver>();
  readonly #publish: (sessionId: string, event: InteractionEvent) => void;

  constructor(
    ctx: Context,
    token: string,
    dshHome: string,
    publish: (sessionId: string, event: InteractionEvent) => void,
  ) {
    this.#token = token;
    this.#path = join(dshHome, "workagent", "interactions.json");
    this.#publish = publish;
    this.#load();
    ctx.effect(
      () => ctx.on("approval/request", (request) => this.#ask(request)),
      "workagent-approval-bridge: Harness answerer",
    );
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: "prefix",
          path: "/v1/interactions",
          handler: (request, response) => this.#handle(request, response),
        }),
      "workagent-approval-bridge: interaction routes",
    );
  }

  async #ask(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const sessionId = String(request.agent.id);
    const latestTurn = [...request.agent.session.events]
      .reverse()
      .find((event) => event.type === "turn/start");
    const turnId =
      latestTurn?.type === "turn/start"
        ? `turn-${latestTurn.data.turn}`
        : "turn-unknown";
    const interaction: PendingInteraction = {
      id: `interaction-${randomUUID()}`,
      sessionId,
      turnId,
      kind: "approval",
      summary: request.reason?.trim() || `Allow ${request.toolName}?`,
      tool: request.toolName,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.#interactions.set(interaction.id, interaction);
    this.#save();
    this.#publish(sessionId, {
      type: "approval.requested",
      turnId,
      approvalId: interaction.id,
      summary: interaction.summary,
    });

    return new Promise<ApprovalOutcome>((resolve) => {
      this.#resolvers.set(interaction.id, resolve);
      const cancel = () => this.#settle(interaction, "cancelled");
      if (request.signal?.aborted) cancel();
      else request.signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!authorized(request, this.#token)) {
      json(response, 401, { error: "authentication_required" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://runtime");
    if (url.pathname === "/v1/interactions" && request.method === "GET") {
      const sessionId = url.searchParams.get("sessionId");
      json(
        response,
        200,
        [...this.#interactions.values()].filter(
          (item) =>
            item.status === "pending" &&
            (sessionId === null || item.sessionId === sessionId),
        ),
      );
      return;
    }
    const match = /^\/v1\/interactions\/([^/]+)\/respond$/.exec(url.pathname);
    if (match === null || request.method !== "POST") {
      json(response, 404, { error: "not_found" });
      return;
    }
    const id = decodeURIComponent(match[1] ?? "");
    const interaction = this.#interactions.get(id);
    if (interaction === undefined) {
      json(response, 404, { error: "interaction_not_found" });
      return;
    }
    let value: Record<string, unknown>;
    try {
      value = await input(request);
    } catch {
      json(response, 400, { error: "invalid_response" });
      return;
    }
    if (value.decision !== "allow" && value.decision !== "reject") {
      json(response, 400, { error: "invalid_decision" });
      return;
    }
    const status = value.decision === "allow" ? "allowed" : "rejected";
    if (interaction.status !== "pending") {
      if (interaction.status === status) {
        json(response, 200, { accepted: false, status: interaction.status });
      } else {
        json(response, 409, { error: "interaction_already_resolved" });
      }
      return;
    }
    if (!this.#resolvers.has(id)) {
      this.#settle(interaction, "unavailable");
      json(response, 409, { error: "interaction_no_longer_live" });
      return;
    }
    this.#settle(interaction, status);
    json(response, 200, { accepted: true, status });
  }

  #settle(
    interaction: PendingInteraction,
    status: Exclude<InteractionStatus, "pending">,
  ): void {
    if (interaction.status !== "pending") return;
    interaction.status = status;
    interaction.resolvedAt = new Date().toISOString();
    this.#save();
    const resolve = this.#resolvers.get(interaction.id);
    this.#resolvers.delete(interaction.id);
    this.#publish(interaction.sessionId, {
      type: "approval.resolved",
      turnId: interaction.turnId,
      approvalId: interaction.id,
      outcome: status,
    });
    resolve?.(
      status === "allowed"
        ? "allowed-once"
        : status === "rejected"
          ? "rejected"
          : status,
    );
  }

  #load(): void {
    if (!existsSync(this.#path)) return;
    const parsed: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
    if (!Array.isArray(parsed) || !parsed.every(valid))
      throw new Error("WorkAgent interaction index is invalid");
    for (const interaction of parsed)
      this.#interactions.set(interaction.id, interaction);
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    const retained = [...this.#interactions.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-1_000);
    writeFileSync(temporary, `${JSON.stringify(retained, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, this.#path);
  }
}
