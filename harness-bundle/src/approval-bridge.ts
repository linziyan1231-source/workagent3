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
import {
  nativeJson,
  type JsonValue,
  type NativeApprovalRequest,
  type NativeApprovalDecision,
} from "./engines/types.js";
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
  native?: boolean;
  summary: string;
  tool: string;
  status: InteractionStatus;
  createdAt: string;
  resolvedAt?: string;
  input?: JsonValue;
  options?: JsonValue[];
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

type Resolver = {
  resolve: (outcome: ApprovalOutcome) => void;
  cleanup: () => void;
};

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
  #disposed = false;
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
      () => () => {
        this.#disposed = true;
        for (const interaction of this.#interactions.values()) {
          if (interaction.status === "pending")
            this.#settle(interaction, "cancelled");
        }
      },
      "workagent-approval-bridge: settle pending on teardown",
    );
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
    return this.#request(
      {
        sessionId,
        turnId,
        tool: request.toolName,
        summary: request.reason?.trim() || `Allow ${request.toolName}?`,
      },
      request.signal,
    );
  }

  async requestNative(
    sessionId: string,
    request: NativeApprovalRequest,
  ): Promise<NativeApprovalDecision> {
    const outcome = await this.#request(
      {
        sessionId,
        native: true,
        turnId: request.turnId,
        tool: request.tool,
        summary: request.summary,
        ...(request.input === undefined
          ? {}
          : { input: nativeJson(request.input) }),
        ...(request.options === undefined
          ? {}
          : { options: nativeJson(request.options) as JsonValue[] }),
      },
      request.signal,
    );
    return outcome === "allowed-once"
      ? "allow"
      : outcome === "rejected"
        ? "reject"
        : "cancel";
  }

  pendingNative(): PendingInteraction[] {
    return [...this.#interactions.values()]
      .filter(
        (item) =>
          item.native === true &&
          item.status === "pending" &&
          this.#resolvers.has(item.id),
      )
      .map((item) => structuredClone(item));
  }

  respondNative(
    sessionId: string,
    approvalId: string,
    decision: NativeApprovalDecision,
  ): boolean {
    const interaction = this.#interactions.get(approvalId);
    if (
      !interaction ||
      interaction.native !== true ||
      interaction.sessionId !== sessionId ||
      interaction.status !== "pending" ||
      !this.#resolvers.has(approvalId)
    )
      return false;
    this.#settle(
      interaction,
      decision === "allow"
        ? "allowed"
        : decision === "reject"
          ? "rejected"
          : "cancelled",
    );
    return true;
  }

  #request(
    details: Pick<
      PendingInteraction,
      | "sessionId"
      | "turnId"
      | "tool"
      | "summary"
      | "input"
      | "options"
      | "native"
    >,
    signal?: AbortSignal,
  ): Promise<ApprovalOutcome> {
    if (signal?.aborted || this.#disposed) return Promise.resolve("cancelled");
    const interaction: PendingInteraction = {
      ...details,
      id: `interaction-${randomUUID()}`,
      kind: "approval",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.#interactions.set(interaction.id, interaction);
    this.#save();
    return new Promise<ApprovalOutcome>((resolve, reject) => {
      const cancel = () => this.#settle(interaction, "cancelled");
      this.#resolvers.set(interaction.id, {
        resolve,
        cleanup: () => signal?.removeEventListener("abort", cancel),
      });
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        this.#publish(interaction.sessionId, {
          type: "approval.requested",
          turnId: interaction.turnId,
          approvalId: interaction.id,
          summary: interaction.summary,
        });
      } catch (error) {
        this.#settle(interaction, "unavailable");
        reject(error);
      }
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
    const pending = this.#resolvers.get(interaction.id);
    this.#resolvers.delete(interaction.id);
    pending?.cleanup();
    try {
      this.#save();
      this.#publish(interaction.sessionId, {
        type: "approval.resolved",
        turnId: interaction.turnId,
        approvalId: interaction.id,
        outcome: status,
      });
    } finally {
      pending?.resolve(
        status === "allowed"
          ? "allowed-once"
          : status === "rejected"
            ? "rejected"
            : status,
      );
    }
  }

  #load(): void {
    if (!existsSync(this.#path)) return;
    const parsed: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
    if (!Array.isArray(parsed) || !parsed.every(valid))
      throw new Error("WorkAgent interaction index is invalid");
    let recovered = false;
    for (const interaction of parsed) {
      if (interaction.status === "pending") {
        interaction.status = "unavailable";
        interaction.resolvedAt = new Date().toISOString();
        recovered = true;
      }
      this.#interactions.set(interaction.id, interaction);
    }
    if (recovered) this.#save();
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
