import { z } from "zod";
import { engineCapabilitiesSchema, engineIdSchema } from "./engine.js";

const moduleIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "invalid module ID");

export const moduleDependencySchema = z.object({
  id: moduleIdSchema,
  contract: z.string().min(1).max(120),
});

export const moduleManifestSchema = z.object({
  id: moduleIdSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "semantic version required"),
  layer: z.enum(["web", "platform", "runtime", "adapter"]),
  required: z.boolean(),
  capabilities: z.array(z.string().min(1)).min(1),
  dependencies: z.array(moduleDependencySchema),
  dataOwner: z.string().min(1),
  healthCheck: z.string().min(1),
});
export type ModuleManifest = z.infer<typeof moduleManifestSchema>;

export const moduleManifestListSchema = z.array(moduleManifestSchema);

export const moduleHealthSchema = z.enum([
  "healthy",
  "unhealthy",
  "unavailable",
  "unknown",
  "disabled",
]);

export const capabilityReadModelSchema = z.object({
  schemaVersion: z.literal(1),
  platformModules: z.array(
    z.object({ manifest: moduleManifestSchema, status: moduleHealthSchema }),
  ),
  runtimeModules: moduleManifestListSchema,
  runtimeStatus: moduleHealthSchema.exclude(["disabled"]),
  engines: z.partialRecord(engineIdSchema, engineCapabilitiesSchema),
});
export type CapabilityReadModel = z.infer<typeof capabilityReadModelSchema>;

export function validateModuleGraph(
  manifests: readonly ModuleManifest[],
): void {
  const modules = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  if (modules.size !== manifests.length) throw new Error("duplicate_module_id");
  for (const manifest of manifests) {
    for (const dependency of manifest.dependencies) {
      if (!modules.has(dependency.id))
        throw new Error(
          `missing_module_dependency:${manifest.id}:${dependency.id}`,
        );
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`cyclic_module_dependency:${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of modules.get(id)!.dependencies)
      visit(dependency.id);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of modules.keys()) visit(id);
}
