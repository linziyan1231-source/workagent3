import { z } from "zod";
import { engineIdSchema } from "./engine.js";

export const sharedTurnRequestSchema = z.object({
  runId: z.string().min(16).max(128),
  conversationId: z.string().min(16).max(128),
  projectId: z.string().min(16).max(128),
  engine: engineIdSchema,
  modelId: z.string().min(1).max(256),
  thinkingEffort: z.enum(["low", "medium", "high"]),
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
