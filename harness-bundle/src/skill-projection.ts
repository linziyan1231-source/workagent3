import { isAbsolute } from "node:path";
import {
  skillCatalogEntrySchema,
  type SkillCatalogEntry,
} from "@workagent/contracts";

export type ResolvedSkill = {
  entry: SkillCatalogEntry;
  root: string;
};

const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_skill_projection");
  return value as Record<string, unknown>;
};

const resolvedSkill = (value: unknown): ResolvedSkill => {
  const input = object(value);
  const entry = skillCatalogEntrySchema.parse(input.entry);
  if (typeof input.root !== "string" || !isAbsolute(input.root))
    throw new Error("invalid_skill_projection_root");
  return { entry, root: input.root };
};

const projection = (value: unknown): readonly ResolvedSkill[] => {
  const skills = object(value).skills;
  if (!Array.isArray(skills)) throw new Error("invalid_skill_projection");
  return skills.map(resolvedSkill);
};

export class SkillProjectionStore {
  nativeSkillPaths: string[] = [];
  readonly #skills = new Map<string, ResolvedSkill>();

  replace(value: unknown): void {
    const projected = projection(value);
    const paths = object(value).nativeSkillPaths ?? [];
    if (
      !Array.isArray(paths) ||
      paths.some((path) => typeof path !== "string" || !isAbsolute(path))
    )
      throw new Error("invalid_native_skill_paths");
    this.nativeSkillPaths = paths;
    const next = new Map<string, ResolvedSkill>();
    for (const skill of projected) {
      if (next.has(skill.entry.id)) throw new Error("duplicate_skill");
      next.set(skill.entry.id, skill);
    }
    this.#skills.clear();
    for (const [id, skill] of next) this.#skills.set(id, skill);
  }

  listSkills(): readonly SkillCatalogEntry[] {
    return [...this.#skills.values()]
      .map(({ entry }) => entry)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getSkill(id: string): SkillCatalogEntry | undefined {
    return this.#skills.get(id)?.entry;
  }

  resolveSkill(id: string): ResolvedSkill | undefined {
    return this.#skills.get(id);
  }
}
