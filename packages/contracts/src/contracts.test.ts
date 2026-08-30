import { describe, expect, it } from "vitest";
import {
  engineEventSchema,
  moduleManifestListSchema,
  credentialStatusSchema,
  presetBindingSchema,
  skillMcpInventorySchema,
  validateModuleGraph,
  workspaceEntrySchema,
} from "./index.js";

describe("engine events", () => {
  it("accepts the minimal normalized assistant event", () => {
    const event = engineEventSchema.parse({
      type: "assistant.delta",
      eventId: "evt-1",
      occurredAt: "2026-08-30T10:00:00+08:00",
      sessionId: "session-1",
      turnId: "turn-1",
      delta: "hello",
    });

    expect(event.type).toBe("assistant.delta");
  });

  it("rejects an event outside the public runtime contract", () => {
    expect(() => engineEventSchema.parse({ type: "internal.trace" })).toThrow();
  });
});

describe("credential contract", () => {
  it("cannot represent credential plaintext", () => {
    expect(credentialStatusSchema.keyof().options).not.toContain("secret");
    expect(credentialStatusSchema.keyof().options).not.toContain("token");
  });
});

describe("preset contract", () => {
  it("keeps the resolved version in the session binding", () => {
    const now = "2026-08-30T10:00:00+08:00";
    const binding = presetBindingSchema.parse({
      presetId: "preset-1",
      presetVersion: 2,
      resolvedSnapshot: {
        id: "preset-1",
        version: 2,
        source: "user",
        name: "Builder",
        description: "",
        avatar: null,
        enabled: true,
        engine: "codex",
        modelId: null,
        systemPrompt: "Build it.",
        workspacePolicy: "default",
        skillIds: [],
        mcpServerIds: [],
        toolAllowlist: [],
        approvalPolicy: "on_risk",
        createdAt: now,
        updatedAt: now,
        resolvedAt: now,
      },
    });
    expect(binding.resolvedSnapshot.version).toBe(binding.presetVersion);
  });
});

describe("workspace contract", () => {
  it("does not expose absolute host paths", () => {
    expect(() =>
      workspaceEntrySchema.parse({
        name: "secret.txt",
        path: "C:\\private\\secret.txt",
        kind: "file",
        size: 1,
        modifiedAt: "2026-08-30T10:00:00+08:00",
      }),
    ).toThrow();
    expect(workspaceEntrySchema.keyof().options).not.toContain("absolutePath");
  });
});

describe("migration inventory", () => {
  it("requires a Windows SID as the tenant identity", () => {
    expect(() =>
      skillMcpInventorySchema.parse({
        schemaVersion: 1,
        sid: "user-a",
        capturedAt: "2026-08-30T10:00:00+08:00",
        skills: [],
        mcpServers: [],
        bindings: [],
        results: [],
      }),
    ).toThrow();
  });
});

describe("module manifests", () => {
  const manifest = (id: string, dependencies: string[] = []) => ({
    id,
    version: "1.0.0",
    layer: "runtime" as const,
    required: true,
    capabilities: [`${id}.read`],
    dependencies: dependencies.map((dependency) => ({
      id: dependency,
      contract: `${dependency}/v1`,
    })),
    configSchema: `${id}/config/v1`,
    dataOwner: id,
    healthCheck: `${id}/health/v1`,
  });

  it("accepts an acyclic declared dependency graph", () => {
    const parsed = moduleManifestListSchema.parse([
      manifest("engine-registry"),
      manifest("personal-work", ["engine-registry"]),
    ]);
    expect(() => validateModuleGraph(parsed)).not.toThrow();
  });

  it("rejects missing and cyclic module dependencies", () => {
    expect(() =>
      validateModuleGraph([manifest("personal-work", ["engine-registry"])]),
    ).toThrow("missing_module_dependency");
    expect(() =>
      validateModuleGraph([
        manifest("personal-work", ["workspace-runtime"]),
        manifest("workspace-runtime", ["personal-work"]),
      ]),
    ).toThrow("cyclic_module_dependency");
  });
});
