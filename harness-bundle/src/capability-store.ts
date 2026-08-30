import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  skillCatalogListSchema,
  type SkillCatalogEntry,
} from "@workagent/contracts";
export { McpProjectionStore as McpCatalogStore } from "./mcp-projection.js";

const writePrivate = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
};

export class SkillCatalogStore {
  readonly #path: string;
  readonly #skills = new Map<string, SkillCatalogEntry>();

  constructor(dshHome: string) {
    this.#path = join(dshHome, "workagent", "skills.json");
    if (!existsSync(this.#path)) return;
    for (const skill of skillCatalogListSchema.parse(
      JSON.parse(readFileSync(this.#path, "utf8")),
    ))
      this.#skills.set(skill.id, skill);
  }

  listSkills(): readonly SkillCatalogEntry[] {
    return [...this.#skills.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  getSkill(id: string): SkillCatalogEntry | undefined {
    return this.#skills.get(id);
  }

  setEnabled(id: string, enabled: boolean): SkillCatalogEntry {
    const skill = this.#skills.get(id);
    if (skill === undefined) throw new Error("skill_not_found");
    const next = { ...skill, enabled };
    this.#skills.set(id, next);
    writePrivate(this.#path, this.listSkills());
    return next;
  }
}
