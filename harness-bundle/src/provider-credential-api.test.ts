import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createManagedProviderCredentialHandler,
  type ProviderCredentialStore,
} from "./provider-credential-api.js";

type RecordedResponse = {
  body: string;
  headers: Record<string, string>;
  status: number;
};

const invoke = async (
  store: ProviderCredentialStore,
  method: string,
  body = "",
  token = "runtime-token",
): Promise<RecordedResponse> => {
  const request = Readable.from(body === "" ? [] : [body]) as IncomingMessage;
  Object.assign(request, {
    headers: { authorization: `Bearer ${token}` },
    method,
  });
  const recorded: RecordedResponse = { body: "", headers: {}, status: 0 };
  const response = new EventEmitter() as ServerResponse;
  Object.assign(response, {
    writeHead: (status: number, headers: Record<string, string> = {}) => {
      recorded.status = status;
      recorded.headers = headers;
      return response;
    },
    end: (value = "") => {
      recorded.body = value;
      return response;
    },
  });
  await createManagedProviderCredentialHandler("runtime-token", store)(
    request,
    response,
  );
  return recorded;
};

describe("managed Provider credential projection", () => {
  it("stores, describes, and removes the official DSH credential reference", async () => {
    let value: string | undefined;
    let reference = "";
    const store: ProviderCredentialStore = {
      describe: async () => ({
        configured: value !== undefined,
        ...(value === undefined ? {} : { source: "file" }),
        writable: true,
      }),
      set: async (ref, next) => {
        reference = ref;
        value = next;
      },
      unset: async (ref) => {
        reference = ref;
        value = undefined;
      },
    };

    expect((await invoke(store, "PUT", "private-provider-key")).status).toBe(
      204,
    );
    expect(reference).toBe("DEEPSEEK_API_KEY");
    expect(value).toBe("private-provider-key");
    const status = await invoke(store, "GET");
    expect(status.status).toBe(200);
    expect(JSON.parse(status.body)).toEqual({
      configured: true,
      source: "file",
      writable: true,
    });
    expect(status.body).not.toContain("private-provider-key");
    expect((await invoke(store, "DELETE")).status).toBe(204);
    expect(value).toBeUndefined();
  });

  it("rejects unauthenticated, empty, and oversized writes", async () => {
    let writes = 0;
    const store: ProviderCredentialStore = {
      describe: async () => ({ configured: false, writable: true }),
      set: async () => {
        writes++;
      },
      unset: async () => undefined,
    };
    expect((await invoke(store, "PUT", "secret", "wrong")).status).toBe(401);
    expect((await invoke(store, "PUT")).status).toBe(400);
    expect((await invoke(store, "PUT", "x".repeat(32 * 1024 + 1))).status).toBe(
      400,
    );
    expect(writes).toBe(0);
  });
});
