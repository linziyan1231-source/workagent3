import { z } from "zod";
import { engineIdSchema } from "./engine.js";
import {
  runtimeMcpServerSchema,
  skillCatalogEntrySchema,
} from "./capability.js";

export const presetSourceSchema = z.enum(["builtin", "user"]);
export const workspacePolicySchema = z.enum([
  "default",
  "required",
  "optional",
]);

export const presetDefinitionSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  source: presetSourceSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(1000),
  avatar: z.string().max(2048).nullable(),
  enabled: z.boolean(),
  engine: engineIdSchema,
  modelId: z.string().min(1).nullable(),
  systemPrompt: z.string().max(50_000),
  workspacePolicy: workspacePolicySchema,
  skillIds: z.array(z.string().min(1)),
  mcpServerIds: z.array(z.string().min(1)),
  toolAllowlist: z.array(z.string().min(1)),
  approvalPolicy: z.enum(["always_ask", "on_risk", "never"]),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type PresetDefinition = z.infer<typeof presetDefinitionSchema>;
export const presetDefinitionListSchema = z.array(presetDefinitionSchema);

export const presetMutationSchema = presetDefinitionSchema
  .omit({
    id: true,
    version: true,
    source: true,
    createdAt: true,
    updatedAt: true,
  })
  .partial({
    description: true,
    avatar: true,
    enabled: true,
    modelId: true,
    systemPrompt: true,
    workspacePolicy: true,
    skillIds: true,
    mcpServerIds: true,
    toolAllowlist: true,
    approvalPolicy: true,
  });
export type PresetMutation = z.infer<typeof presetMutationSchema>;

export const resolvedPresetSnapshotSchema = presetDefinitionSchema.extend({
  resolvedAt: z.iso.datetime({ offset: true }),
  resolvedSkills: z.array(skillCatalogEntrySchema).optional(),
  resolvedMcpServers: z.array(runtimeMcpServerSchema).optional(),
});
export type ResolvedPresetSnapshot = z.infer<
  typeof resolvedPresetSnapshotSchema
>;

export const presetBindingSchema = z.object({
  presetId: z.string().min(1),
  presetVersion: z.number().int().positive(),
  resolvedSnapshot: resolvedPresetSnapshotSchema,
});
export type PresetBinding = z.infer<typeof presetBindingSchema>;

export type PresetRuntimePort = {
  list(): readonly PresetDefinition[];
  get(id: string): PresetDefinition | undefined;
  create(input: PresetMutation): PresetDefinition;
  update(id: string, input: Partial<PresetMutation>): PresetDefinition;
  copy(id: string, name: string): PresetDefinition;
  delete(id: string): void;
  resolve(id: string): PresetBinding;
};
