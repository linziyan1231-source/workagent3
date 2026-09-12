import {
  mkdirSync,
  readFileSync,
  existsSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AutomationQuotaPort } from "./quota-client.js";
import { estimatedAutomationUnits } from "./quota-runner.js";

type Entry = {
  runId: string;
  sessionId: string;
  modelId: string;
  engine?: "harness" | "codex" | "kimi" | "acp";
  estimatedUnits?: number;
  turnId?: string;
  finished?: boolean;
};

// The journal is written before reserve. An ambiguous HTTP result therefore
// cannot leave a reservation that startup reconciliation does not know about.
export class ConversationQuota {
  readonly #path: string;
  readonly #entries: Entry[];
  readonly #settling = new Map<string, Promise<void>>();
  readonly #pendingReservations = new Map<string, Set<Promise<unknown>>>();
  readonly #releasedSessions = new Set<string>();
  readonly ready: Promise<void>;

  constructor(
    home: string,
    readonly quota: AutomationQuotaPort | undefined,
  ) {
    this.#path = join(home, "workagent", "conversation-quota.json");
    this.#entries = existsSync(this.#path)
      ? (JSON.parse(readFileSync(this.#path, "utf8")) as Entry[])
      : [];
    this.ready = this.#recover();
    // Entrypoints await ready and fail closed if reconciliation failed.
    void this.ready.catch(() => undefined);
  }

  async #recover() {
    for (const entry of [...this.#entries]) await this.release(entry.runId);
  }

  async begin(
    sessionId: string,
    modelId: string,
    content: string,
    turnId?: string,
    engine?: "harness" | "codex" | "kimi" | "acp",
  ): Promise<string> {
    await this.ready;
    if (!this.quota) throw new Error("platform_quota_unconfigured");
    if (this.#releasedSessions.has(sessionId))
      throw new Error("session_deleted");
    // Complete durable settlements before admitting another input. The Portal
    // additionally waits for the gateway consumer's completeness checkpoint.
    await Promise.all(this.#settling.values());
    for (const entry of [...this.#entries])
      if (entry.finished) await this.release(entry.runId);
    if (this.#releasedSessions.has(sessionId))
      throw new Error("session_deleted");
    const entry = {
      runId: `conversation-${randomUUID()}`,
      sessionId,
      modelId,
      ...(engine ? { engine } : {}),
      estimatedUnits: estimatedAutomationUnits(content),
      ...(turnId ? { turnId } : {}),
    };
    this.#entries.push(entry);
    this.#save();
    const reservation = this.quota.reserve({
      runId: entry.runId,
      modelId,
      estimatedUnits: entry.estimatedUnits,
      ...(engine ? { engine } : {}),
    });
    const pending = this.#pendingReservations.get(sessionId) ?? new Set();
    pending.add(reservation);
    this.#pendingReservations.set(sessionId, pending);
    try {
      await reservation;
    } catch (error) {
      await this.release(entry.runId).catch(() => undefined);
      throw error;
    } finally {
      pending.delete(reservation);
      if (pending.size === 0) this.#pendingReservations.delete(sessionId);
    }
    if (this.#releasedSessions.has(sessionId))
      throw new Error("session_deleted");
    return entry.runId;
  }

  started(sessionId: string, turnId: string): void {
    let changed = false;
    for (const entry of this.#entries) {
      if (
        entry.sessionId === sessionId &&
        entry.turnId === undefined &&
        !entry.finished
      ) {
        entry.turnId = turnId;
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  async ended(sessionId: string, turnId: string): Promise<void> {
    for (const entry of [...this.#entries]) {
      if (entry.sessionId === sessionId && entry.turnId === turnId)
        await this.release(entry.runId);
    }
  }

  async releaseSession(sessionId: string): Promise<void> {
    this.#releasedSessions.add(sessionId);
    await Promise.allSettled([
      ...(this.#pendingReservations.get(sessionId) ?? []),
    ]);
    await Promise.all(
      [...this.#entries]
        .filter((entry) => entry.sessionId === sessionId)
        .map((entry) => this.release(entry.runId)),
    );
  }

  release(runId: string): Promise<void> {
    const previous = this.#settling.get(runId);
    if (previous) return previous;
    const operation = this.#release(runId).finally(() =>
      this.#settling.delete(runId),
    );
    this.#settling.set(runId, operation);
    return operation;
  }

  async #release(runId: string) {
    if (!this.quota) throw new Error("platform_quota_unconfigured");
    const entry = this.#entries.find((entry) => entry.runId === runId);
    if (entry) {
      entry.finished = true;
      this.#save();
    }
    try {
      // Actual model consumption is counted once from the gateway ledger,
      // including requests that consumed tokens before failure/cancellation.
      await this.quota.settle({
        runId,
        actualUnits:
          entry?.engine === "acp" && entry.turnId
            ? (entry.estimatedUnits ?? 0)
            : 0,
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "quota_reservation_not_found"
      )
        throw error;
    }
    const index = this.#entries.findIndex((entry) => entry.runId === runId);
    if (index !== -1) this.#entries.splice(index, 1);
    this.#save();
  }

  #save() {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.#entries), { mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}

export const quotaMessage = (code: string): string =>
  ({
    quota_exceeded: "使用额度不足，请联系管理员调整额度，或等待下一周期。",
    quota_usage_stale: "用量统计服务暂不可用，请稍后重试。",
    quota_usage_pending: "上一轮用量正在结算，请稍后重试。",
    platform_quota_unconfigured: "额度服务尚未配置，请联系管理员。",
    quota_not_configured: "此模型尚未配置使用额度，请联系管理员。",
  })[code] ?? code;
