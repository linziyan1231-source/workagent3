import { z } from "zod";
import {
  createEngineSessionSchema,
  engineCapabilitiesSchema,
  engineStatusSchema,
  engineEventSchema,
  engineIdSchema,
  assistantMessageKindSchema,
} from "./engine.js";
import { presetBindingSchema } from "./preset.js";

export const sessionLastTurnSchema = z.object({
  id: z.string().min(1),
  completedAt: z.iso.datetime({ offset: true }),
  status: z.enum(["completed", "failed", "cancelled"]),
});

export const runtimeSessionSchema = z.object({
  id: z.string().min(1),
  engine: engineIdSchema,
  title: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  workspaceId: z.string().min(1),
  preset: presetBindingSchema,
  modelId: z.string().optional(),
  thinkingEffort: z.string().optional(),
  permissionMode: z
    .enum(["read_only", "workspace_write", "full_access"])
    .optional(),
  parentSessionId: z.string().optional(),
  branchKind: z.enum(["fork", "edit", "side_chat"]).optional(),
  anchorMessageId: z.string().optional(),
  contextMode: z.enum(["native", "transcript"]).optional(),
  activity: z
    .object({
      state: z.enum(["idle", "running", "retrying"]),
      message: z.string().optional(),
    })
    .optional(),
  lastTurn: sessionLastTurnSchema.optional(),
});
export type RuntimeSession = z.infer<typeof runtimeSessionSchema>;

export const runtimeMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  kind: assistantMessageKindSchema.optional(),
  nativeTurnId: z.string().optional(),
  replyTo: z.object({ id: z.string(), text: z.string() }).optional(),
});
export type RuntimeMessage = z.infer<typeof runtimeMessageSchema>;

export const runtimeMessageSearchItemSchema = z.object({
  session: runtimeSessionSchema,
  message: runtimeMessageSchema,
});
export const runtimeMessageSearchResultSchema = z.object({
  items: z.array(runtimeMessageSearchItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().nonnegative(),
  pageSize: z.number().int().positive(),
  hasMore: z.boolean(),
});
export type RuntimeMessageSearchResult = z.infer<
  typeof runtimeMessageSearchResultSchema
>;

export const runtimeApiSchemas = {
  createSession: createEngineSessionSchema,
  engineCapabilities: z.record(engineIdSchema, engineCapabilitiesSchema),
  engineStatusList: z.array(engineStatusSchema),
  engineEvent: engineEventSchema,
  session: runtimeSessionSchema,
  sessionList: z.array(runtimeSessionSchema),
  message: runtimeMessageSchema,
  messageList: z.array(runtimeMessageSchema),
  messageSearchResult: runtimeMessageSearchResultSchema,
} as const;
