import { z } from "zod";
import { engineIdSchema } from "./engine.js";

export const automationScheduleSchema = z.discriminatedUnion("kind", [
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
  workspaceId: z.string().min(1),
  input: z
    .string()
    .min(1)
    .max(64 * 1024),
  notificationPolicy: z.enum(["none", "on_failure", "always"]),
  nextRunAt: z.iso.datetime({ offset: true }).nullable(),
  lastRunAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;

export const automationMutationSchema = automationDefinitionSchema.pick({
  name: true,
  enabled: true,
  schedule: true,
  presetId: true,
  engine: true,
  workspaceId: true,
  input: true,
  notificationPolicy: true,
});
export type AutomationMutation = z.infer<typeof automationMutationSchema>;

export const automationRunSchema = z.object({
  id: z.string().min(1),
  automationId: z.string().min(1),
  trigger: z.enum(["scheduled", "manual"]),
  scheduledFor: z.iso.datetime({ offset: true }),
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]),
  attempt: z.number().int().nonnegative(),
  sessionId: z.string().min(1).nullable(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type AutomationRun = z.infer<typeof automationRunSchema>;

export const automationDocumentSchema = z.object({
  version: z.literal(1),
  definitions: z.array(automationDefinitionSchema),
  runs: z.array(automationRunSchema),
});
