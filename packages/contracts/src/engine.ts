import { z } from "zod";

export const engineIdSchema = z.enum(["harness", "codex", "kimi", "acp"]);
export type EngineId = z.infer<typeof engineIdSchema>;
export const acpCatalogIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const validEngineSelection = (value: {
  engine: EngineId;
  acpCatalogId?: string | undefined;
}) =>
  value.engine === "acp"
    ? Boolean(value.acpCatalogId)
    : value.acpCatalogId === undefined;

export const engineCapabilitiesSchema = z.object({
  approval: z.boolean(),
  resume: z.boolean(),
  steer: z.boolean(),
  toolEvents: z.boolean(),
  usage: z.boolean(),
});
export type EngineCapabilities = z.infer<typeof engineCapabilitiesSchema>;

export const engineStatusSchema = z.object({
  id: engineIdSchema,
  acpCatalogId: acpCatalogIdSchema.optional(),
  label: z.string().min(1),
  available: z.boolean(),
  authenticated: z.boolean().nullable(),
  state: z.enum(["ready", "needs_auth", "unknown", "unavailable"]),
  detail: z.string().optional(),
  capabilities: engineCapabilitiesSchema,
});
export type EngineStatus = z.infer<typeof engineStatusSchema>;

export const createEngineSessionSchema = z
  .object({
    engine: engineIdSchema,
    acpCatalogId: acpCatalogIdSchema.optional(),
    title: z.string().trim().min(1).max(200),
    workspace: z.string().min(1),
    presetId: z.string().min(1).optional(),
    operationId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,160}$/)
      .optional(),
    modelId: z.string().trim().min(1).max(200).optional(),
    thinkingEffort: z.string().trim().min(1).max(80).optional(),
    permissionMode: z
      .enum(["read_only", "workspace_write", "full_access"])
      .optional(),
  })
  .refine(validEngineSelection, {
    message: "ACP selections require a catalog id; built-in engines forbid it",
    path: ["acpCatalogId"],
  });
export type CreateEngineSession = z.infer<typeof createEngineSessionSchema>;

export const sendEngineTurnSchema = z.object({
  clientRequestId: z.uuid(),
  content: z.string().trim().min(1),
  sessionId: z.string().min(1),
});
export type SendEngineTurn = z.infer<typeof sendEngineTurnSchema>;

const eventBaseSchema = z.object({
  eventId: z.string().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
  sessionId: z.string().min(1),
});

export const assistantMessageKindSchema = z.enum([
  "commentary",
  "question",
  "answer",
]);
const assistantIdentity = {
  messageId: z.string().min(1).optional(),
  kind: assistantMessageKindSchema.optional(),
};
const toolDetails = {
  input: z.json().optional(),
  output: z.json().optional(),
  result: z.json().optional(),
  locations: z.json().optional(),
  raw: z.json().optional(),
};

export const engineEventSchema = z.discriminatedUnion("type", [
  eventBaseSchema.extend({
    type: z.literal("process.updated"),
    turnId: z.string().min(1),
    processId: z.string().min(1),
    kind: z.enum(["plan", "reasoning"]),
    text: z.string().optional(),
    delta: z.string().optional(),
    data: z.json().optional(),
  }),
  eventBaseSchema.extend({
    type: z.literal("session.created"),
    engine: engineIdSchema,
  }),
  eventBaseSchema.extend({
    type: z.literal("turn.started"),
    turnId: z.string().min(1),
  }),
  eventBaseSchema.extend({
    type: z.literal("turn.retrying"),
    turnId: z.string().min(1),
    message: z.string(),
  }),
  eventBaseSchema.extend({
    type: z.literal("assistant.delta"),
    turnId: z.string().min(1),
    delta: z.string(),
    ...assistantIdentity,
  }),
  eventBaseSchema.extend({
    type: z.literal("assistant.completed"),
    turnId: z.string().min(1),
    content: z.string(),
    ...assistantIdentity,
  }),
  eventBaseSchema.extend({
    type: z.literal("turn.completed"),
    turnId: z.string().min(1),
  }),
  eventBaseSchema.extend({
    type: z.literal("tool.started"),
    turnId: z.string().min(1),
    toolCallId: z.string().min(1),
    tool: z.string().min(1),
    ...toolDetails,
  }),
  eventBaseSchema.extend({
    type: z.literal("tool.updated"),
    turnId: z.string().min(1),
    toolCallId: z.string().min(1),
    tool: z.string().min(1).optional(),
    ...toolDetails,
  }),
  eventBaseSchema.extend({
    type: z.literal("tool.completed"),
    turnId: z.string().min(1),
    toolCallId: z.string().min(1),
    failed: z.boolean(),
    tool: z.string().min(1).optional(),
    ...toolDetails,
  }),
  eventBaseSchema.extend({
    type: z.literal("approval.requested"),
    turnId: z.string().min(1),
    approvalId: z.string().min(1),
    summary: z.string(),
  }),
  eventBaseSchema.extend({
    type: z.literal("approval.resolved"),
    turnId: z.string().min(1),
    approvalId: z.string().min(1),
    outcome: z.enum(["allowed", "rejected", "cancelled", "unavailable"]),
  }),
  eventBaseSchema.extend({
    type: z.literal("turn.failed"),
    turnId: z.string().min(1),
    code: z.string().min(1),
    message: z.string(),
  }),
  eventBaseSchema.extend({
    type: z.literal("turn.cancelled"),
    turnId: z.string().min(1),
  }),
  eventBaseSchema.extend({ type: z.literal("session.closed") }),
  eventBaseSchema.extend({ type: z.literal("message.created") }),
  eventBaseSchema.extend({ type: z.literal("queue.changed") }),
]);
export type EngineEvent = z.infer<typeof engineEventSchema>;
