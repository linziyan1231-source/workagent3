import { z } from "zod";
import { engineIdSchema } from "./engine.js";

export const sharedTurnRequestSchema = z.object({
  capabilities: z
    .object({
      skillIds: z.array(z.string()),
      mcpServerIds: z.array(z.string()),
      entryIds: z.array(z.string()),
      excludedSkillIds: z.array(z.string()).default([]),
      excludedMcpIds: z.array(z.string()).default([]),
    })
    .optional(),
  assistantId: z.string().min(1).optional(),
  sessionKey: z
    .string()
    .regex(/^session-shared-[A-Za-z0-9_-]+$/)
    .max(128)
    .optional(),
  runId: z.string().min(16).max(128),
  conversationId: z.string().min(16).max(128),
  projectId: z.string().min(16).max(128),
  engine: engineIdSchema,
  modelId: z.string().min(1).max(256),
  thinkingEffort: z.string().trim().min(1).max(32),
  quotaModelId: z.string().min(1).max(256).optional(),
  context: z
    .string()
    .min(1)
    .max(512 * 1024),
  recoveryContext: z
    .string()
    .min(1)
    .max(768 * 1024),
  runtimeSessionId: z.string().min(1).optional(),
});
export type SharedTurnRequest = z.infer<typeof sharedTurnRequestSchema>;

export const sharedTurnRuntimeRequestSchema = sharedTurnRequestSchema.extend({
  workspacePath: z.string().min(1),
  // Frozen at run admission: the member who mentioned the assistant pays.
  payerSid: z.string().startsWith("S-1-"),
});
export type SharedTurnRuntimeRequest = z.infer<
  typeof sharedTurnRuntimeRequestSchema
>;

export const sharedTurnResultSchema = z.object({
  runId: z.string().min(16).max(128),
  runtimeSessionId: z.string().min(1),
  assistantBody: z.string(),
  recovered: z.boolean(),
});
export type SharedTurnResult = z.infer<typeof sharedTurnResultSchema>;
