import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const brandLogo = resolve(
  process.cwd(),
  "../../third_party/aionui/packages/desktop/src/renderer/assets/logos/brand/app.png",
);

describe("formal Renderer brand asset", () => {
  it("keeps the deployable Puxin logo instead of the sanitized binary placeholder", () => {
    const contents = readFileSync(brandLogo);
    expect(contents.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(contents.length).toBeGreaterThan(100_000);
  });
});
