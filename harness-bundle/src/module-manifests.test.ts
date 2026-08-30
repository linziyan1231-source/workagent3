import {
  moduleManifestListSchema,
  validateModuleGraph,
} from "@workagent/contracts";
import { describe, expect, it } from "vitest";
import { RUNTIME_MODULES } from "./module-manifests.js";

describe("runtime module manifests", () => {
  it("declare valid capabilities, owners, health checks, and an acyclic graph", () => {
    const manifests = moduleManifestListSchema.parse(RUNTIME_MODULES);
    expect(() => validateModuleGraph(manifests)).not.toThrow();
    expect(manifests.map((manifest) => manifest.id)).toContain(
      "workspace-runtime",
    );
  });
});
