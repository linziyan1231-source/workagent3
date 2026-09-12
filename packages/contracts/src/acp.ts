import { z } from "zod";
import { acpCatalogIdSchema } from "./engine.js";

export const acpCredentialFieldSchema = z.object({
  id: acpCatalogIdSchema,
  label: z.string().min(1).max(120),
  environment: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
  required: z.boolean(),
});
export const acpCatalogEntrySchema = z.object({
  id: acpCatalogIdSchema,
  label: z.string().min(1).max(120),
  packageRef: z.string().min(1),
  revision: z.string().min(1).max(120),
  command: z.string().min(1),
  resolvedCommand: z.string().min(1).optional(),
  args: z.array(z.string()).max(100),
  credentialFields: z.array(acpCredentialFieldSchema).max(20),
  billingModelId: z.string().min(1),
  enabled: z.boolean(),
  permissionModes: z
    .object({
      read_only: z.string().optional(),
      workspace_write: z.string().optional(),
      full_access: z.string().optional(),
    })
    .optional(),
});
export type AcpCatalogEntry = z.infer<typeof acpCatalogEntrySchema>;

export const nativeCommandCatalogSchema = z.object({
  supported: z.boolean(),
  revision: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string(),
      description: z.string().optional(),
      inputHint: z.string().optional(),
    }),
  ),
});
