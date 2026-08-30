import { z } from "zod";

export const skillCatalogEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  source: z.enum(["builtin", "managed", "market", "user"]),
  enabled: z.boolean(),
  relativePath: z
    .string()
    .min(1)
    .refine((path) => !/^(?:[a-z]:|[/\\])/i.test(path)),
  requiredMcpServerIds: z.array(z.string().min(1)),
});
export type SkillCatalogEntry = z.infer<typeof skillCatalogEntrySchema>;
export const skillCatalogListSchema = z.array(skillCatalogEntrySchema);

export const runtimeMcpTransportSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()),
    environmentCredentialIds: z.record(z.string().min(1), z.string().min(1)),
  }),
  z.object({
    kind: z.literal("http"),
    url: z.url(),
    headerCredentialIds: z.record(z.string().min(1), z.string().min(1)),
  }),
  z.object({
    kind: z.literal("sse"),
    url: z.url(),
    headerCredentialIds: z.record(z.string().min(1), z.string().min(1)),
  }),
]);

export const runtimeMcpServerSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    description: z.string().max(1000).optional(),
    source: z.enum(["managed", "user"]),
    enabled: z.boolean(),
    transport: runtimeMcpTransportSchema,
    toolPolicy: z.enum(["all", "allowlist", "none"]),
    allowedTools: z.array(z.string().min(1)),
    oauthState: z.enum(["none", "ready", "needs_auth"]),
    health: z.enum(["unknown", "healthy", "unavailable", "needs_review"]),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((server, context) => {
    if (server.toolPolicy === "allowlist" && server.allowedTools.length === 0)
      context.addIssue({
        code: "custom",
        message: "allowlist requires at least one tool",
        path: ["allowedTools"],
      });
    if (server.toolPolicy !== "allowlist" && server.allowedTools.length !== 0)
      context.addIssue({
        code: "custom",
        message: "allowedTools is only valid for allowlist",
        path: ["allowedTools"],
      });
  });
export type RuntimeMcpServer = z.infer<typeof runtimeMcpServerSchema>;
export const runtimeMcpServerListSchema = z.array(runtimeMcpServerSchema);

export const runtimeMcpConnectionResultSchema = z.object({
  success: z.boolean(),
  server: runtimeMcpServerSchema,
  error: z.string().min(1).optional(),
});
export type RuntimeMcpConnectionResult = z.infer<
  typeof runtimeMcpConnectionResultSchema
>;

export const runtimeMcpMutationSchema = runtimeMcpServerSchema
  .omit({ id: true, createdAt: true, updatedAt: true, health: true })
  .safeExtend({ health: runtimeMcpServerSchema.shape.health.optional() })
  .superRefine((server, context) => {
    if (server.toolPolicy === "allowlist" && server.allowedTools.length === 0)
      context.addIssue({
        code: "custom",
        message: "allowlist requires at least one tool",
        path: ["allowedTools"],
      });
    if (server.toolPolicy !== "allowlist" && server.allowedTools.length !== 0)
      context.addIssue({
        code: "custom",
        message: "allowedTools is only valid for allowlist",
        path: ["allowedTools"],
      });
  });
export type RuntimeMcpMutation = z.infer<typeof runtimeMcpMutationSchema>;

export interface SkillCatalogPort {
  listSkills(): readonly SkillCatalogEntry[];
  getSkill(id: string): SkillCatalogEntry | undefined;
}

export interface McpCatalogPort {
  listServers(): readonly RuntimeMcpServer[];
  getServer(id: string): RuntimeMcpServer | undefined;
}
