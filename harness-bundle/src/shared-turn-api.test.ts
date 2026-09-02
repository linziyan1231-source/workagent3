import { describe, expect, it } from "vitest";
import { sharedTurnRuntimeRequestSchema } from "@workagent/contracts";

describe("@workagent/shared-turn contract", () => {
  it("keeps the owner-runtime workspace and frozen run identity explicit", () => {
    const parsed = sharedTurnRuntimeRequestSchema.parse({
      runId: "run_1234567890123456",
      conversationId: "conversation_123456",
      projectId: "project_1234567890",
      engine: "codex",
      modelId: "gpt-5",
      thinkingEffort: "high",
      context: "[Alice]\nPlease help",
      recoveryContext: "[Alice]\nPlease help",
      workspacePath: "C:\\shared\\owner\\project_1234567890",
      payerSid: "S-1-5-21-2000",
    });
    expect(parsed.workspacePath).toContain("project_1234567890");
    expect(parsed.payerSid).toBe("S-1-5-21-2000");
    expect(parsed.runId).toBe("run_1234567890123456");
  });
});
