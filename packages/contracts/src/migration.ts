import { z } from "zod";
import { engineIdSchema } from "./engine.js";

export const migrationStatusSchema = z.enum([
  "ready",
  "needs_auth",
  "needs_review",
  "failed",
]);
export type MigrationStatus = z.infer<typeof migrationStatusSchema>;

export const skillPackageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  source: z.enum(["builtin", "managed", "market", "user"]),
  contentPath: z.string().min(1),
  enabled: z.boolean(),
});
export type SkillPackage = z.infer<typeof skillPackageSchema>;

export const mcpTransportSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()),
  }),
  z.object({ kind: z.literal("http"), url: z.url() }),
  z.object({ kind: z.literal("sse"), url: z.url() }),
]);

export const mcpServerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  transport: mcpTransportSchema,
  enabled: z.boolean(),
  allowedTools: z.array(z.string().min(1)),
  oauthState: z.enum(["none", "ready", "needs_auth"]),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

export const mcpBindingSchema = z.object({
  id: z.string().min(1),
  serverId: z.string().min(1),
  engine: engineIdSchema,
  subjectId: z.string().min(1),
  subjectType: z.enum(["session", "assistant", "team_member"]),
});
export type McpBinding = z.infer<typeof mcpBindingSchema>;

export const skillMcpMigrationResultSchema = z.object({
  sourceId: z.string().min(1),
  targetId: z.string().min(1).optional(),
  kind: z.enum(["skill", "mcp_server", "mcp_binding", "oauth"]),
  status: migrationStatusSchema,
  reason: z.string().min(1).optional(),
});
export type SkillMcpMigrationResult = z.infer<
  typeof skillMcpMigrationResultSchema
>;

export const skillMcpInventorySchema = z.object({
  schemaVersion: z.literal(1),
  sid: z.string().regex(/^S-1-/),
  capturedAt: z.iso.datetime({ offset: true }),
  skills: z.array(skillPackageSchema),
  mcpServers: z.array(mcpServerSchema),
  bindings: z.array(mcpBindingSchema),
  results: z.array(skillMcpMigrationResultSchema),
});
export type SkillMcpInventory = z.infer<typeof skillMcpInventorySchema>;
