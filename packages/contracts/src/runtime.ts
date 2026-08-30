import { z } from "zod";
import {
  createEngineSessionSchema,
  engineCapabilitiesSchema,
  engineEventSchema,
  engineIdSchema,
} from "./engine.js";

export const runtimeSessionSchema = z.object({
  id: z.string().min(1),
  engine: engineIdSchema,
  title: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type RuntimeSession = z.infer<typeof runtimeSessionSchema>;

export const runtimeApiSchemas = {
  createSession: createEngineSessionSchema,
  engineCapabilities: z.record(engineIdSchema, engineCapabilitiesSchema),
  engineEvent: engineEventSchema,
  session: runtimeSessionSchema,
  sessionList: z.array(runtimeSessionSchema),
} as const;
