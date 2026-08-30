import { z } from "zod";

export const modelHealthSchema = z.enum([
  "healthy",
  "degraded",
  "unavailable",
  "unknown",
]);

export const modelCatalogEntrySchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  contextWindow: z.number().int().positive(),
  inputPricePerMillion: z.number().nonnegative().nullable(),
  outputPricePerMillion: z.number().nonnegative().nullable(),
  health: modelHealthSchema,
});
export type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>;

export const modelAuthorizationSchema = z.object({
  modelId: z.string().min(1),
  authorized: z.boolean(),
  reason: z.string().min(1).optional(),
});
export type ModelAuthorization = z.infer<typeof modelAuthorizationSchema>;

export const authorizedModelCatalogEntrySchema = modelCatalogEntrySchema.extend(
  {
    authorization: modelAuthorizationSchema,
  },
);
export type AuthorizedModelCatalogEntry = z.infer<
  typeof authorizedModelCatalogEntrySchema
>;
export const authorizedModelCatalogListSchema = z.array(
  authorizedModelCatalogEntrySchema,
);

export const credentialKindSchema = z.enum([
  "codex_native",
  "kimi_native",
  "provider",
  "mcp_oauth",
]);
export const credentialStatusSchema = z.object({
  id: z.string().min(1),
  kind: credentialKindSchema,
  state: z.enum(["ready", "needs_auth", "expired", "revoked", "unknown"]),
  label: z.string().min(1),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;
export const credentialStatusListSchema = z.array(credentialStatusSchema);

export interface ModelCatalogPort {
  listModels(): Promise<readonly ModelCatalogEntry[]>;
  getModel(modelId: string): Promise<ModelCatalogEntry | undefined>;
}

export interface ModelAuthorizationPort {
  authorizationFor(modelId: string): Promise<ModelAuthorization>;
}

export interface CredentialBrokerPort {
  listStatuses(): Promise<readonly CredentialStatus[]>;
  statusFor(id: string): Promise<CredentialStatus | undefined>;
  revoke(id: string): Promise<void>;
}
