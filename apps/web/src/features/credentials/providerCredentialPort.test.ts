import { afterEach, describe, expect, it, vi } from "vitest";
import { providerCredentialPort } from "./providerCredentialPort.js";

afterEach(() => vi.unstubAllGlobals());

describe("managed Provider credential HTTP port", () => {
  it("sends the secret only in the SID Runtime request body", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "provider-harness",
            kind: "provider",
            state: "ready",
            label: "Harness managed Provider",
            updatedAt: "2026-09-01T00:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    await providerCredentialPort.put("private-provider-key");

    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/provider-credentials/harness",
      expect.objectContaining({
        method: "PUT",
        body: "private-provider-key",
        credentials: "same-origin",
      }),
    );
  });

  it("revokes through the same SID Runtime port", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await providerCredentialPort.revoke();
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/provider-credentials/harness",
      expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
    );
  });

  it("runs the managed Provider probe through the SID Runtime", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "healthy",
            message: "provider_request_succeeded",
            elapsed_ms: 21,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(providerCredentialPort.test()).resolves.toMatchObject({
      status: "healthy",
      elapsed_ms: 21,
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/provider-credentials/harness/test",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
  });
});
