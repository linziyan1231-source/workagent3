import { afterEach, describe, expect, it, vi } from "vitest";
import { skillPort } from "./skillPort.js";

const skill = {
  id: "skill-1",
  name: "Quantity surveyor",
  description: "Measure drawings",
  version: "1.0.0",
  source: "managed" as const,
  enabled: true,
  relativePath: "skills/quantity-surveyor",
  requiredMcpServerIds: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("Skill catalog HTTP port", () => {
  it("loads skills without absolute host paths", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify([skill]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(skillPort.list()).resolves.toEqual([skill]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/skills",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("encodes ids when changing enabled state", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...skill, enabled: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    await skillPort.setEnabled("skill/unsafe", false);
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/skills/skill%2Funsafe",
      expect.objectContaining({ method: "PATCH" }),
    );
  });
});
