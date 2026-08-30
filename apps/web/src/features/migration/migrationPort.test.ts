import { afterEach, describe, expect, it, vi } from "vitest";
import { migrationPort } from "./migrationPort.js";

afterEach(() => vi.unstubAllGlobals());

describe("migration HTTP port", () => {
  it("loads terminal results without filesystem paths or credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              results: [
                {
                  sourceId: "old-mcp",
                  targetId: "new-mcp",
                  kind: "mcp_server",
                  status: "needs_auth",
                  reason: "oauth_reauthorization_required",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    await expect(migrationPort.skillMcpReport()).resolves.toMatchObject({
      results: [{ status: "needs_auth" }],
    });
  });
});
