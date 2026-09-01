import type { IncomingMessage, ServerResponse } from "node:http";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { authorized } from "./index.js";

export interface ProviderCredentialStore {
  describe(
    ref: ReturnType<typeof credentialRef>,
  ): Promise<{ configured: boolean; source?: string; writable: boolean }>;
  set(ref: ReturnType<typeof credentialRef>, value: string): Promise<void>;
  unset(ref: ReturnType<typeof credentialRef>): Promise<void>;
}

const managedProviderRef = credentialRef("DEEPSEEK_API_KEY");

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

const readSecret = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += value.length;
    if (size > 32 * 1024) throw new Error("provider_credential_too_large");
    chunks.push(value);
  }
  const secret = Buffer.concat(chunks).toString("utf8");
  for (const chunk of chunks) chunk.fill(0);
  if (secret.length === 0 || secret.includes("\0"))
    throw new Error("invalid_provider_credential");
  return secret;
};

export const createManagedProviderCredentialHandler =
  (token: string, credentials: ProviderCredentialStore) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!authorized(request, token)) {
      json(response, 401, { error: "authentication_required" });
      return;
    }
    try {
      if (request.method === "GET") {
        json(response, 200, await credentials.describe(managedProviderRef));
        return;
      }
      if (request.method === "PUT") {
        await credentials.set(managedProviderRef, await readSecret(request));
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }
      if (request.method === "DELETE") {
        await credentials.unset(managedProviderRef);
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }
      response.writeHead(405, { allow: "GET, PUT, DELETE" });
      response.end();
    } catch (error) {
      json(response, 400, {
        error:
          error instanceof Error ? error.message : "provider_credential_failed",
      });
    }
  };
