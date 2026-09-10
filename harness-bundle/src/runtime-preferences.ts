import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { authorized } from "./index.js";

export class RuntimePreferences {
  readonly #path: string;
  readonly #turns = new Map<
    string,
    { turnId: string; timer: ReturnType<typeof setTimeout> }
  >();
  #value = { turnTimeoutSeconds: 0 };
  constructor(home: string) {
    this.#path = join(home, "workagent", "runtime-preferences.json");
    if (existsSync(this.#path))
      this.#value = this.#parse(JSON.parse(readFileSync(this.#path, "utf8")));
  }
  #parse(value: unknown) {
    const seconds = (value as { turnTimeoutSeconds?: unknown } | null)
      ?.turnTimeoutSeconds;
    if (
      typeof seconds !== "number" ||
      !Number.isInteger(seconds) ||
      seconds < 0 ||
      seconds > 86400
    )
      throw new Error("invalid_runtime_preferences");
    return { turnTimeoutSeconds: seconds };
  }
  get() {
    return { ...this.#value };
  }
  set(input: unknown) {
    const next = this.#parse(input);
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(`${this.#path}.tmp`, JSON.stringify(next), { mode: 0o600 });
    renameSync(`${this.#path}.tmp`, this.#path);
    this.#value = next;
    return this.get();
  }
  started(id: string, turnId: string, cancel: () => Promise<void>) {
    this.ended(id);
    if (!this.#value.turnTimeoutSeconds) return;
    const timer = setTimeout(() => {
      this.#turns.delete(id);
      void cancel().catch((error) =>
        console.error("workagent: timed-out turn cancellation failed", error),
      );
    }, this.#value.turnTimeoutSeconds * 1000);
    timer.unref?.();
    this.#turns.set(id, { turnId, timer });
  }
  ended(id: string, turnId?: string) {
    const pending = this.#turns.get(id);
    if (pending && (!turnId || pending.turnId === turnId)) {
      clearTimeout(pending.timer);
      this.#turns.delete(id);
    }
  }
  close() {
    for (const id of this.#turns.keys()) this.ended(id);
  }
  mount(ctx: Context, token: string) {
    ctx.effect(() => {
      const unregister = ctx.webServer.register({
        kind: "exact",
        path: "/v1/runtime-settings",
        handler: async (request, response) => {
          const json = (status: number, value: unknown) => {
            response.writeHead(status, {
              "content-type": "application/json",
              "cache-control": "no-store",
            });
            response.end(JSON.stringify(value));
          };
          if (!authorized(request, token))
            return json(401, { error: "authentication_required" });
          if (request.method === "GET") return json(200, this.get());
          if (request.method !== "PUT")
            return json(405, { error: "method_not_allowed" });
          try {
            let data = "";
            for await (const chunk of request) {
              data += String(chunk);
              if (data.length > 1024)
                throw new Error("invalid_runtime_preferences");
            }
            json(200, this.set(JSON.parse(data)));
          } catch {
            json(400, { error: "invalid_runtime_preferences" });
          }
        },
      });
      return () => {
        unregister();
        this.close();
      };
    }, "workagent: employee runtime settings");
  }
}
