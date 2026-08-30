import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CredentialStatusStore,
  ModelAccessStore,
} from "./model-access-store.js";

describe("model access", () => {
  it("uses stable IDs and denies models outside the SID authorization set", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-models-"));
    mkdirSync(join(home, "workagent"), { recursive: true });
    writeFileSync(
      join(home, "workagent", "model-access.json"),
      JSON.stringify({
        models: [
          {
            id: "managed-model",
            providerId: "harness",
            displayName: "Managed",
            aliases: [],
            contextWindow: 32_000,
            inputPricePerMillion: 1,
            outputPricePerMillion: 2,
            health: "healthy",
          },
        ],
        authorizedModelIds: [],
      }),
    );
    const store = new ModelAccessStore(home);
    expect(store.authorizationFor("managed-model")).toEqual({
      modelId: "managed-model",
      authorized: false,
      reason: "model_not_authorized",
    });
  });

  it("projects native credential state without credential material", () => {
    const home = mkdtempSync(join(tmpdir(), "workagent-credentials-"));
    mkdirSync(join(home, ".codex"));
    const statuses = new CredentialStatusStore(home).listStatuses();
    expect(statuses.find((item) => item.id === "codex-native")?.state).toBe(
      "ready",
    );
    expect(JSON.stringify(statuses)).not.toMatch(/password|secret|token/i);
  });
});
