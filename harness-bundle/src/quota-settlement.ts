import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AutomationQuotaPort } from "./quota-client.js";
import { waitForShutdown } from "./shutdown.js";

type Completion = { runId: string; actualUnits: number };

// Completed accounting survives independently of task success, cancellation,
// or failure. Only run IDs and the frozen completed amounts belong here.
export class PersonalQuotaSettlements {
  readonly #path: string;
  readonly #pending = new Map<string, number>();
  readonly #active = new Map<string, Promise<void>>();

  constructor(
    dshHome: string,
    readonly quota: AutomationQuotaPort,
  ) {
    this.#path = join(dshHome, "workagent", "personal-quota-settlements.json");
    if (!existsSync(this.#path)) return;
    const document = JSON.parse(readFileSync(this.#path, "utf8")) as {
      entries: Completion[];
    };
    if (
      !Array.isArray(document.entries) ||
      !document.entries.every(
        (entry) =>
          typeof entry.runId === "string" &&
          Number.isSafeInteger(entry.actualUnits) &&
          entry.actualUnits >= 0,
      )
    )
      throw new Error("personal_quota_settlements_invalid");
    for (const entry of document.entries)
      this.#pending.set(entry.runId, entry.actualUnits);
  }

  get(runId: string): number | undefined {
    return this.#pending.get(runId);
  }

  track(runId: string, actualUnits: number): void {
    if (this.#pending.has(runId)) return;
    const pending = new Map(this.#pending);
    pending.set(runId, actualUnits);
    this.#save(pending);
    this.#pending.set(runId, actualUnits);
  }

  // Only a definitive admission rejection can discard an unexecuted run.
  // Transport failures must retain the completion for a later retry.
  discard(runId: string): void {
    if (!this.#pending.has(runId)) return;
    const pending = new Map(this.#pending);
    pending.delete(runId);
    this.#save(pending);
    this.#pending.delete(runId);
  }

  settle(runId: string, actualUnits: number): Promise<void> {
    const active = this.#active.get(runId);
    if (active) return active;
    try {
      this.track(runId, actualUnits);
    } catch (error) {
      return Promise.reject(error);
    }
    const completed = this.#pending.get(runId)!;
    const work = Promise.resolve()
      .then(async () => {
        // A definitive reserve rejection can arrive while recovery is queued.
        if (!this.#pending.has(runId)) return;
        await this.quota.settle({ runId, actualUnits: completed });
        this.discard(runId);
      })
      .finally(() => this.#active.delete(runId));
    this.#active.set(runId, work);
    return work;
  }

  startRecovery(): () => Promise<void> {
    let stopped = false;
    let stopping: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recover = async () => {
      for (const [runId, actualUnits] of [...this.#pending]) {
        if (stopped) break;
        // A concurrent live completion may already have settled this snapshot.
        if (!this.#pending.has(runId)) continue;
        try {
          await this.settle(runId, actualUnits);
        } catch {
          /* The durable completion retries with the same amount. */
        }
      }
    };
    let work = Promise.resolve();
    const run = () => {
      work = recover().finally(() => {
        if (stopped) return;
        timer = setTimeout(run, 5000);
        timer.unref?.();
      });
    };
    run();
    return () => {
      if (stopping) return stopping;
      stopped = true;
      if (timer) clearTimeout(timer);
      stopping = waitForShutdown(
        Promise.allSettled([work, ...this.#active.values()]),
        5000,
      );
      return stopping;
    };
  }

  #save(pending: Map<string, number>): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, entries: [...pending].map(([runId, actualUnits]) => ({ runId, actualUnits })) }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporary, this.#path);
  }
}
