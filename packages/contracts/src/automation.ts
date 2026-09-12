import { z } from "zod";
import { engineIdSchema } from "./engine.js";

export const automationScheduleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("once"),
    at: z.iso.datetime({ offset: true }),
  }),
  z.object({
    kind: z.literal("interval"),
    everyMinutes: z.number().int().min(1).max(525_600),
  }),
  z.object({
    kind: z.literal("weekly"),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    timezone: z.string().min(1).max(100),
  }),
  z.object({
    kind: z.literal("cron"),
    expression: z.string().max(200),
    timezone: z.string().min(1).max(100),
  }),
]);
export type AutomationSchedule = z.infer<typeof automationScheduleSchema>;

export const automationDefinitionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1).max(200),
  enabled: z.boolean(),
  schedule: automationScheduleSchema,
  presetId: z.string().min(1),
  engine: engineIdSchema,
  acpCatalogId: z.string().min(1).optional(),
  workspaceId: z.string().min(1),
  input: z
    .string()
    .min(1)
    .max(64 * 1024),
  notificationPolicy: z.enum(["none", "on_failure", "always"]),
  messageNotificationEnabled: z.boolean().default(false),
  messageNotificationTargetId: z.string().min(1).nullable().default(null),
  executionMode: z
    .enum(["new_conversation", "existing"])
    .default("new_conversation"),
  conversationId: z.string().min(1).nullable().default(null),
  skillId: z.string().min(1).nullable().optional(),
  nextRunAt: z.iso.datetime({ offset: true }).nullable(),
  lastRunAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
export const automationDefinitionListSchema = z.array(
  automationDefinitionSchema,
);

export const automationMutationSchema = automationDefinitionSchema.pick({
  name: true,
  enabled: true,
  schedule: true,
  presetId: true,
  engine: true,
  acpCatalogId: true,
  workspaceId: true,
  input: true,
  notificationPolicy: true,
  messageNotificationEnabled: true,
  messageNotificationTargetId: true,
  executionMode: true,
  conversationId: true,
  skillId: true,
});
export type AutomationMutation = z.input<typeof automationMutationSchema>;

export const automationRunSchema = z.object({
  id: z.string().min(1),
  automationId: z.string().min(1),
  definitionSnapshot: automationDefinitionSchema,
  trigger: z.enum(["scheduled", "manual"]),
  scheduledFor: z.iso.datetime({ offset: true }),
  status: z.enum([
    "pending",
    "waiting",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "skipped_busy",
  ]),
  notBefore: z.iso.datetime({ offset: true }).nullable().default(null),
  busyRetryCount: z.number().int().nonnegative().default(0),
  lastWaitReason: z.string().nullable().default(null),
  submittedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  turnId: z.string().nullable().default(null),
  attempt: z.number().int().nonnegative(),
  sessionId: z.string().min(1).nullable(),
  result: z.string().nullable(),
  skillSuggestionPath: z.string().nullable().optional(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type AutomationRun = z.infer<typeof automationRunSchema>;
export const automationRunListSchema = z.array(automationRunSchema);

export const automationDocumentSchema = z.object({
  version: z.literal(1),
  definitions: z.array(automationDefinitionSchema),
  runs: z.array(automationRunSchema),
  quotaReconciledRunIds: z.array(z.string().min(1)).default([]),
  operations: z
    .array(z.object({ id: z.string(), input: z.string(), result: z.json() }))
    .default([]),
});
