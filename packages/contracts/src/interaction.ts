import { z } from "zod";

export const interactionStatusSchema = z.enum([
  "pending",
  "allowed",
  "rejected",
  "cancelled",
  "unavailable",
]);

export const pendingInteractionSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  kind: z.literal("approval"),
  summary: z.string(),
  tool: z.string().min(1),
  status: interactionStatusSchema,
  createdAt: z.iso.datetime({ offset: true }),
  resolvedAt: z.iso.datetime({ offset: true }).optional(),
  native: z.boolean().optional(),
  input: z.json().optional(),
  options: z.array(z.json()).optional(),
  choices: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string(),
        outcome: z.enum(["allow", "reject", "cancel"]),
        scope: z.enum(["once", "session", "rule", "remember"]),
      }),
    )
    .optional(),
  selectedOptionId: z.string().optional(),
});
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;

export const interactionApiSchemas = {
  pending: pendingInteractionSchema,
  pendingList: z.array(pendingInteractionSchema),
  response: z.object({
    accepted: z.boolean(),
    status: interactionStatusSchema.exclude(["pending"]),
  }),
} as const;
