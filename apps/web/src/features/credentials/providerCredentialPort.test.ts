import { afterEach, describe, expect, it, vi } from "vitest";
import { providerCredentialPort } from "./providerCredentialPort.js";

afterEach(() => vi.unstubAllGlobals());

describe("managed Provider credential HTTP port", () => {
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
