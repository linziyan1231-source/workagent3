import { z } from "zod";
import { engineIdSchema } from "./engine.js";

export const teamMemberSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  engine: engineIdSchema,
  acpCatalogId: z.string().min(1).optional(),
  presetId: z.string().min(1),
  role: z.enum(["lead", "member"]),
  status: z.enum(["idle", "running", "error"]),
  sessionId: z.string().min(1).nullable().default(null),
  createdAt: z.iso.datetime({ offset: true }),
});
export type TeamMember = z.infer<typeof teamMemberSchema>;

export const teamTaskSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  memberId: z.string().min(1),
  version: z.number().int().positive().default(1),
  dependsOnIds: z.array(z.string().min(1)).default([]),
  createdByMemberId: z.string().nullable().default(null),
  title: z.string().trim().min(1).max(200),
  input: z
    .string()
    .trim()
    .min(1)
    .max(64 * 1024),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  sessionId: z.string().min(1).nullable(),
  result: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }).nullable(),
  finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type TeamTask = z.infer<typeof teamTaskSchema>;

export const teamMailboxMessageSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  fromMemberId: z.string().min(1).nullable(),
  toMemberId: z.string().min(1).nullable(),
  body: z
    .string()
    .trim()
    .min(1)
    .max(64 * 1024),
  createdAt: z.iso.datetime({ offset: true }),
  readAt: z.iso.datetime({ offset: true }).nullable(),
});
export type TeamMailboxMessage = z.infer<typeof teamMailboxMessageSchema>;

export const teamEventSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: z.enum([
    "team.updated",
    "team.created",
    "team.renamed",
    "team.removed",
    "member.added",
    "member.renamed",
    "member.removed",
    "task.queued",
    "task.started",
    "task.completed",
    "task.failed",
    "task.cancelled",
    "mail.received",
    "run.updated",
    "dispatch.updated",
    "task.updated",
  ]),
  subjectId: z.string().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
});
export type TeamEvent = z.infer<typeof teamEventSchema>;

export const teamSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  workspaceId: z.string().min(1),
  sessionMode: z.string().trim().min(1).max(40).nullable().default(null),
  members: z.array(teamMemberSchema).min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type Team = z.infer<typeof teamSchema>;
export const teamListSchema = z.array(teamSchema);
export const teamTaskListSchema = z.array(teamTaskSchema);
export const teamMailboxMessageListSchema = z.array(teamMailboxMessageSchema);
export const teamEventListSchema = z.array(teamEventSchema);

export const teamCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  workspaceId: z.string().min(1),
  lead: z.object({
    name: z.string().trim().min(1).max(120),
    engine: engineIdSchema,
    acpCatalogId: z.string().min(1).optional(),
    presetId: z.string().min(1),
    modelId: z.string().trim().min(1).max(200).optional(),
    thinkingEffort: z.string().trim().min(1).max(80).optional(),
    permissionMode: z
      .enum(["read_only", "workspace_write", "full_access"])
      .optional(),
  }),
});
export type TeamCreate = z.infer<typeof teamCreateSchema>;

export const teamRunSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  input: z.string(),
  status: z.enum([
    "running",
    "paused",
    "paused_limit",
    "completed",
    "cancelled",
    "interrupted",
  ]),
  segment: z.number().int().positive(),
  dispatchCount: z.number().int().nonnegative(),
  recruitedCount: z.number().int().nonnegative(),
  reason: z.string().nullable(),
  result: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TeamRun = z.infer<typeof teamRunSchema>;
export const teamDispatchSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  runId: z.string(),
  memberId: z.string(),
  taskId: z.string().nullable(),
  messageIds: z.array(z.string()),
  input: z.string(),
  parentId: z.string().nullable(),
  depth: z.number().int().nonnegative(),
  fanoutMemberIds: z.array(z.string()).default([]),
  status: z.enum([
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  turnId: z.string().nullable(),
  submittedAt: z.string().nullable(),
  notBefore: z.string().nullable().default(null),
  result: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type TeamDispatch = z.infer<typeof teamDispatchSchema>;

export const teamDocumentSchema = z.object({
  version: z.literal(1),
  teams: z.array(teamSchema),
  tasks: z.array(teamTaskSchema),
  messages: z.array(teamMailboxMessageSchema),
  events: z.array(teamEventSchema),
  eventSequence: z.number().int().nonnegative().default(0),
  quotaReconciledTaskIds: z.array(z.string().min(1)).default([]),
  runs: z.array(teamRunSchema).default([]),
  dispatches: z.array(teamDispatchSchema).default([]),
  operations: z
    .array(z.object({ id: z.string(), input: z.string(), result: z.json() }))
    .default([]),
});
