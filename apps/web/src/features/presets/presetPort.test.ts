import { afterEach, describe, expect, it, vi } from "vitest";
import { presetPort } from "./presetPort.js";

afterEach(() => vi.unstubAllGlobals());

describe("PresetPort", () => {
  it("loads presets through the same-origin runtime proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(presetPort.list()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/v1/presets",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("writes assistant changes only through the preset runtime resource", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await presetPort.remove("preset/unsafe");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/v1/presets/preset%2Funsafe",
      expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
    );
  });
});
