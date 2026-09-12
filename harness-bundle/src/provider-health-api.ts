import type { IncomingMessage, ServerResponse } from "node:http";
import { authorized } from "./runtime-http.js";

export type ProviderHealthResult = {
  status: "healthy" | "unhealthy";
  message: string;
  elapsed_ms: number;
};

export type ProviderHealthProbe = (
  signal: AbortSignal,
) => Promise<Omit<ProviderHealthResult, "elapsed_ms">>;

const writeJson = (
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

export const createManagedProviderHealthHandler =
  (token: string, probe: ProviderHealthProbe) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!authorized(request, token)) {
      writeJson(response, 401, { error: "authentication_required" });
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const result = await probe(controller.signal);
      writeJson(response, 200, {
        ...result,
        elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    } catch {
      writeJson(response, 200, {
        status: "unhealthy",
        message: controller.signal.aborted
          ? "provider_health_timeout"
          : "provider_health_failed",
        elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      } satisfies ProviderHealthResult);
    } finally {
      clearTimeout(timeout);
    }
  };
