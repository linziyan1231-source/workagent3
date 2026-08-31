import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserConfigService } from "./configService.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser Renderer config lifecycle", () => {
  it("uses defaults before login and reloads the authenticated settings", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "authentication_required" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            "theme.activeId": "dark",
            "ui.fontSize.chat": 16,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const configService = new BrowserConfigService(false);
    const observed: unknown[] = [];
    configService.subscribe("ui.fontSize.chat", (value) =>
      observed.push(value),
    );

    await expect(configService.initialize()).resolves.toBeUndefined();
    expect(configService.get("theme.activeId")).toBeUndefined();
    await configService.reload();

    expect(configService.get("theme.activeId")).toBe("dark");
    expect(configService.get("ui.fontSize.chat")).toBe(16);
    expect(observed).toEqual([16]);
  });
});
