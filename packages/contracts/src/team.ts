import { z } from "zod";
import { engineIdSchema } from "./engine.js";

export const teamMemberSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  engine: engineIdSchema,
  presetId: z.string().min(1),
  role: z.enum(["lead", "member"]),
  status: z.enum(["idle", "running", "error"]),
  createdAt: z.iso.datetime({ offset: true }),
});
export type TeamMember = z.infer<typeof teamMemberSchema>;

export const teamTaskSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  memberId: z.string().min(1),
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
    "task.queued",
    "task.started",
    "task.completed",
    "task.failed",
    "task.cancelled",
    "mail.received",
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
    presetId: z.string().min(1),
  }),
});
export type TeamCreate = z.infer<typeof teamCreateSchema>;

export const teamDocumentSchema = z.object({
  version: z.literal(1),
  teams: z.array(teamSchema),
  tasks: z.array(teamTaskSchema),
  messages: z.array(teamMailboxMessageSchema),
  events: z.array(teamEventSchema),
  quotaReconciledTaskIds: z.array(z.string().min(1)).default([]),
});
