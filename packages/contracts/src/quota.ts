import { z } from "zod";

export const quotaUsageSchema = z.object({
  limitUnits: z.number().int().nonnegative(),
  consumedUnits: z.number().int().nonnegative(),
  reservedUnits: z.number().int().nonnegative(),
  period: z.enum(["daily", "weekly"]),
  periodKey: z.string().min(1),
});

export type QuotaUsage = z.infer<typeof quotaUsageSchema>;
