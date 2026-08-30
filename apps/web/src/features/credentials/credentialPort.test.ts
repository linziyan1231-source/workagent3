import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialPort } from "./credentialPort.js";

afterEach(() => vi.unstubAllGlobals());

describe("credential HTTP port", () => {
  it("sends plaintext only to the broker creation endpoint", async () => {
    const fetch = vi.fn(
      async (_path: string, _request?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: "credential-1",
            kind: "mcp_header",
            state: "ready",
            label: "Authorization",
            updatedAt: "2026-08-31T00:00:00Z",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await credentialPort.create({
      kind: "mcp_header",
      label: "Authorization",
      secret: "Bearer private",
    });
    expect(result.id).toBe("credential-1");
    const [, request] = fetch.mock.calls[0]!;
    expect(JSON.parse(String(request?.body))).toEqual({
      kind: "mcp_header",
      label: "Authorization",
      secret: "Bearer private",
    });
  });
});
