import { z } from "zod";

export const quotaUsageSchema = z.object({
  limitUnits: z.number().int().nonnegative(),
  consumedUnits: z.number().int().nonnegative(),
  reservedUnits: z.number().int().nonnegative(),
  period: z.enum(["daily", "weekly"]),
  periodKey: z.string().min(1),
});

export type QuotaUsage = z.infer<typeof quotaUsageSchema>;

// Authoritative per-request token usage drained from the model gateway by the
// Employee Manager, shown next to the internal run records on the usage page.
export const gatewayModelUsageSchema = z.object({
  model: z.string().min(1),
  totalTokens: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
});
export type GatewayModelUsage = z.infer<typeof gatewayModelUsageSchema>;

export const gatewayUsageSchema = z.object({
  dailyPeriodKey: z.string().min(1),
  dailyTokens: z.number().int().nonnegative(),
  weeklyPeriodKey: z.string().min(1),
  weeklyTokens: z.number().int().nonnegative(),
  models: z.array(gatewayModelUsageSchema),
});
export type GatewayUsage = z.infer<typeof gatewayUsageSchema>;

export const quotaReservationSchema = z.object({
  runId: z.string().min(1),
  sid: z.string().startsWith("S-1-"),
  modelId: z.string().min(1),
  period: z.enum(["daily", "weekly"]),
  periodKey: z.string().min(1),
  reservedUnits: z.number().int().nonnegative(),
  actualUnits: z.number().int().nonnegative().nullable(),
  status: z.enum(["reserved", "settled"]),
});
export type QuotaReservation = z.infer<typeof quotaReservationSchema>;

export const quotaReserveRequestSchema = z.object({
  runId: z.string().min(1),
  sid: z.string().startsWith("S-1-"),
  modelId: z.string().min(1),
  estimatedUnits: z.number().int().nonnegative(),
  // Shared runs bill the frozen triggerer while the caller authenticates as
  // the runtime owner SID.
  payerSid: z.string().startsWith("S-1-").optional(),
});
export type QuotaReserveRequest = z.infer<typeof quotaReserveRequestSchema>;

export const quotaSettleRequestSchema = z.object({
  runId: z.string().min(1),
  sid: z.string().startsWith("S-1-"),
  actualUnits: z.number().int().nonnegative(),
  payerSid: z.string().startsWith("S-1-").optional(),
});
export type QuotaSettleRequest = z.infer<typeof quotaSettleRequestSchema>;
