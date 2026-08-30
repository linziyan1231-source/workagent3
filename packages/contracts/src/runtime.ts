import { z } from "zod";
import {
  createEngineSessionSchema,
  engineCapabilitiesSchema,
  engineStatusSchema,
  engineEventSchema,
  engineIdSchema,
} from "./engine.js";

export const runtimeSessionSchema = z.object({
  id: z.string().min(1),
  engine: engineIdSchema,
  title: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  workspaceId: z.string().min(1),
});
export type RuntimeSession = z.infer<typeof runtimeSessionSchema>;

export const runtimeMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type RuntimeMessage = z.infer<typeof runtimeMessageSchema>;

export const runtimeApiSchemas = {
  createSession: createEngineSessionSchema,
  engineCapabilities: z.record(engineIdSchema, engineCapabilitiesSchema),
  engineStatusList: z.array(engineStatusSchema),
  engineEvent: engineEventSchema,
  session: runtimeSessionSchema,
  sessionList: z.array(runtimeSessionSchema),
  message: runtimeMessageSchema,
  messageList: z.array(runtimeMessageSchema),
} as const;
