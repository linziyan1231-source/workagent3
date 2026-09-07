import { z } from "zod";

export const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  directory: z.string().min(1).max(120).optional(),
  scope: z.enum(["personal", "team"]).default("personal"),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const workspaceEntrySchema = z.object({
  name: z.string().min(1),
  path: z
    .string()
    .min(1)
    .refine(
      (path) =>
        !path.startsWith("/") &&
        !path.startsWith("\\") &&
        !path.includes(":") &&
        !path.split(/[\\/]/).includes(".."),
      "relative workspace path required",
    ),
  kind: z.enum(["directory", "file"]),
  size: z.number().int().nonnegative(),
  modifiedAt: z.iso.datetime({ offset: true }),
});
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;

export const workspaceAssetSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  kind: z.enum(["attachment", "artifact"]),
  name: z.string().min(1).max(255),
  path: workspaceEntrySchema.shape.path,
  mediaType: z.string().min(1).max(200),
  size: z.number().int().nonnegative(),
  createdAt: z.iso.datetime({ offset: true }),
});
export type WorkspaceAsset = z.infer<typeof workspaceAssetSchema>;

export const workspaceApiSchemas = {
  workspace: workspaceSchema,
  workspaceList: z.array(workspaceSchema),
  entry: workspaceEntrySchema,
  entryList: z.array(workspaceEntrySchema),
  asset: workspaceAssetSchema,
  assetList: z.array(workspaceAssetSchema),
} as const;
