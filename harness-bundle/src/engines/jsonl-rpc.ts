import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

type RpcId = number | string;
type RpcMessage = {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type Pending = {
  reject: (reason: Error) => void;
  resolve: (value: unknown) => void;
};

export class JsonLineRpc {
  readonly #input: Writable;
  readonly #pending = new Map<RpcId, Pending>();
  readonly #notifications = new Set<
    (method: string, params: unknown) => void
  >();
  readonly #requests = new Set<
    (id: RpcId, method: string, params: unknown) => void
  >();
  #nextId = 1;

  constructor(output: Readable, input: Writable) {
    this.#input = input;
    const lines = createInterface({ input: output });
    lines.on("line", (line) => this.#receive(line));
    lines.once("close", () => this.close(new Error("RPC transport closed")));
    output.once("error", (error) => this.close(error));
    input.once("error", (error) => this.close(error));
  }

  notify(method: string, params: unknown): void {
    this.#write({ method, params });
  }

  onNotification(
    listener: (method: string, params: unknown) => void,
  ): () => void {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  onRequest(
    listener: (id: RpcId, method: string, params: unknown) => void,
  ): () => void {
    this.#requests.add(listener);
    return () => this.#requests.delete(listener);
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.#write({ id, method, params });
    });
  }

  respond(id: RpcId, result: unknown): void {
    this.#write({ id, result });
  }

  close(reason = new Error("RPC transport closed")): void {
    for (const pending of this.#pending.values()) pending.reject(reason);
    this.#pending.clear();
  }

  #receive(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && message.method !== undefined) {
      for (const listener of this.#requests)
        listener(message.id, message.method, message.params);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(
          new Error(
            message.error.message ??
              `RPC error ${message.error.code ?? "unknown"}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method !== undefined) {
      for (const listener of this.#notifications)
        listener(message.method, message.params);
    }
  }

  #write(message: RpcMessage): void {
    this.#input.write(`${JSON.stringify(message)}\n`);
  }
}
