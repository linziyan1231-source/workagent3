import { afterEach, describe, expect, it, vi } from "vitest";
import { ipcBridge } from "./common.js";

afterEach(() => vi.unstubAllGlobals());

describe("production Renderer Skill Market adapter", () => {
  it("routes the original install action through Portal", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "market-wiki" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    await ipcBridge.portal.installMarketSkill.invoke({ id: "market-wiki" });

    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/skill-market/install",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ id: "market-wiki" }),
        credentials: "same-origin",
      }),
    );
  });
});
