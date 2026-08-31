import { z } from "zod";

export const quotaUsageSchema = z.object({
  limitUnits: z.number().int().nonnegative(),
  consumedUnits: z.number().int().nonnegative(),
  reservedUnits: z.number().int().nonnegative(),
  period: z.enum(["daily", "weekly"]),
  periodKey: z.string().min(1),
});

export type QuotaUsage = z.infer<typeof quotaUsageSchema>;

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
});
export type QuotaReserveRequest = z.infer<typeof quotaReserveRequestSchema>;

export const quotaSettleRequestSchema = z.object({
  runId: z.string().min(1),
  sid: z.string().startsWith("S-1-"),
  actualUnits: z.number().int().nonnegative(),
});
export type QuotaSettleRequest = z.infer<typeof quotaSettleRequestSchema>;
