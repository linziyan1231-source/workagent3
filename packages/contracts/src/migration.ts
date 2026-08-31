import { z } from "zod";
import { engineIdSchema } from "./engine.js";

export const migrationStatusSchema = z.enum([
  "ready",
  "needs_auth",
  "needs_review",
  "failed",
]);
export type MigrationStatus = z.infer<typeof migrationStatusSchema>;

export const skillPackageSchema = z
  .object({
    oldId: z.string().min(1),
    targetId: z.string().min(1).optional(),
    name: z.string().min(1),
    description: z.string(),
    version: z.string().min(1),
    legacySource: z.enum(["builtin", "extension", "cron", "market", "user"]),
    contentPath: z.string().min(1),
    enabled: z.boolean(),
    deleted: z.boolean(),
    bindingObjectIds: z.array(z.string().min(1)),
    requiredMcpServerIds: z.array(z.string().min(1)),
  })
  .strict();
export type SkillPackage = z.infer<typeof skillPackageSchema>;

export const mcpTransportSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()),
      environmentCredentialIds: z.record(z.string().min(1), z.string().min(1)),
    })
    .strict(),
  z
    .object({
      kind: z.literal("http"),
      url: z.url(),
      headerCredentialIds: z.record(z.string().min(1), z.string().min(1)),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sse"),
      url: z.url(),
      headerCredentialIds: z.record(z.string().min(1), z.string().min(1)),
    })
    .strict(),
]);

export const mcpServerSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    source: z.enum(["managed", "user"]),
    transport: mcpTransportSchema,
    enabled: z.boolean(),
    toolPolicy: z.enum(["all", "allowlist", "none"]),
    allowedTools: z.array(z.string().min(1)),
    oauthState: z.enum(["none", "ready", "needs_auth"]),
  })
  .strict();
export type McpServer = z.infer<typeof mcpServerSchema>;

export const mcpBindingSchema = z
  .object({
    id: z.string().min(1),
    serverId: z.string().min(1),
    engine: engineIdSchema,
    subjectId: z.string().min(1),
    subjectType: z.enum(["session", "assistant", "team_member"]),
  })
  .strict();
export type McpBinding = z.infer<typeof mcpBindingSchema>;

export const skillBindingSchema = z
  .object({
    id: z.string().min(1),
    skillId: z.string().min(1),
    engine: engineIdSchema,
    subjectId: z.string().min(1),
    subjectType: z.enum(["session", "assistant", "team_member"]),
  })
  .strict();
export type SkillBinding = z.infer<typeof skillBindingSchema>;

export const legacyPresetAssetSchema = z
  .object({
    oldId: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000),
    avatar: z.string().max(2048).nullable(),
    engine: engineIdSchema,
    modelId: z.string().min(1).nullable(),
    systemPrompt: z.string().max(50_000),
    enabled: z.boolean(),
    skillIds: z.array(z.string().min(1)),
    mcpServerIds: z.array(z.string().min(1)),
    skillBindingIds: z.array(z.string().min(1)).default([]),
    mcpBindingIds: z.array(z.string().min(1)).default([]),
    approvalPolicy: z.enum(["always_ask", "on_risk", "never"]),
    migrationIssues: z.array(z.string().min(1)),
  })
  .strict();
export type LegacyPresetAsset = z.infer<typeof legacyPresetAssetSchema>;

export const legacyPresetProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    sid: z.string().regex(/^S-1-/),
    capturedAt: z.iso.datetime({ offset: true }),
    presets: z.array(legacyPresetAssetSchema),
  })
  .strict();
export type LegacyPresetProjection = z.infer<
  typeof legacyPresetProjectionSchema
>;

export const skillMcpMigrationResultSchema = z
  .object({
    sourceId: z.string().min(1),
    targetId: z.string().min(1).optional(),
    kind: z.enum([
      "skill",
      "mcp_server",
      "skill_binding",
      "mcp_binding",
      "preset",
      "oauth",
    ]),
    status: migrationStatusSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();
export type SkillMcpMigrationResult = z.infer<
  typeof skillMcpMigrationResultSchema
>;

export const skillMcpMigrationReportSchema = z
  .object({ results: z.array(skillMcpMigrationResultSchema) })
  .strict();
export type SkillMcpMigrationReport = z.infer<
  typeof skillMcpMigrationReportSchema
>;

export const skillMcpInventorySchema = z
  .object({
    schemaVersion: z.literal(1),
    sid: z.string().regex(/^S-1-/),
    capturedAt: z.iso.datetime({ offset: true }),
    skills: z.array(skillPackageSchema),
    mcpServers: z.array(mcpServerSchema),
    skillBindings: z.array(skillBindingSchema),
    mcpBindings: z.array(mcpBindingSchema),
    presets: z.array(legacyPresetAssetSchema).default([]),
    results: z.array(skillMcpMigrationResultSchema),
  })
  .strict();
export type SkillMcpInventory = z.infer<typeof skillMcpInventorySchema>;
