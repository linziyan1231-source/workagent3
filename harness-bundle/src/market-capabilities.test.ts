import { expect, it } from "vitest";
import { presetBindingSchema } from "@workagent/contracts";
import { projectCapabilityBinding } from "./market-capabilities.js";

it("keeps project pins across personal updates and restores the original configuration on unsubscribe", () => {
  const original = presetBindingSchema.parse({
    presetId: "writer",
    presetVersion: 1,
    resolvedSnapshot: {
      id: "writer",
      version: 1,
      source: "user",
      description: "",
      avatar: null,
      enabled: true,
      modelId: null,
      createdAt: "2026-09-12T00:00:00Z",
      updatedAt: "2026-09-12T00:00:00Z",
      resolvedAt: "2026-09-12T00:00:00Z",
      name: "Writer",
      engine: "codex",
      systemPrompt: "Keep my task instructions",
      workspacePolicy: "optional",
      skillIds: ["private", "personal-v2"],
      mcpServerIds: [],
      toolAllowlist: [],
      approvalPolicy: "on_risk",
    },
  });
  const pinned = projectCapabilityBinding(original, {
    skillIds: ["project-v1"],
    mcpServerIds: [],
    entryIds: ["version-1"],
    excludedSkillIds: ["personal-v2", "project-v1"],
    excludedMcpIds: [],
  });
  expect(pinned.resolvedSnapshot.skillIds).toEqual(["private", "project-v1"]);
  const persisted = presetBindingSchema.parse(
    JSON.parse(JSON.stringify(pinned)),
  );
  const updated = projectCapabilityBinding(persisted, {
    skillIds: ["project-v3"],
    mcpServerIds: [],
    entryIds: ["version-3"],
    excludedSkillIds: ["personal-v2", "project-v1", "project-v3"],
    excludedMcpIds: [],
  });
  expect(updated.resolvedSnapshot.skillIds).toEqual(["private", "project-v3"]);
  const removed = projectCapabilityBinding(updated, {
    skillIds: [],
    mcpServerIds: [],
    entryIds: [],
    excludedSkillIds: [],
    excludedMcpIds: [],
  });
  expect(removed.resolvedSnapshot).toEqual(original.resolvedSnapshot);
});
