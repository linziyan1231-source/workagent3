import { z } from "zod";

export const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
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

export const workspaceApiSchemas = {
  workspace: workspaceSchema,
  workspaceList: z.array(workspaceSchema),
  entry: workspaceEntrySchema,
  entryList: z.array(workspaceEntrySchema),
} as const;
