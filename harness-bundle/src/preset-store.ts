import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  presetDefinitionSchema,
  presetMutationSchema,
  type PresetBinding,
  type PresetDefinition,
  type PresetMutation,
} from "@workagent/contracts";
import type { ModelAccessStore } from "./model-access-store.js";
import type { McpCatalogStore, SkillCatalogStore } from "./capability-store.js";

const builtin = (
  now: string,
  engine: "harness" | "codex" | "kimi",
): PresetDefinition => ({
  id: engine === "harness" ? "builtin-general" : `builtin-${engine}`,
  version: 1,
  source: "builtin",
  name:
    engine === "harness" ? "General" : engine === "codex" ? "Codex" : "Kimi",
  description: `General-purpose ${engine} assistant`,
  avatar: null,
  enabled: true,
  engine,
  modelId: engine === "harness" ? "harness-default" : `${engine}-native`,
  systemPrompt: "",
  workspacePolicy: "default",
  skillIds: [],
  mcpServerIds: [],
  toolAllowlist: [],
  approvalPolicy: "on_risk",
  createdAt: now,
  updatedAt: now,
});

export class PresetStore {
  readonly #path: string;
  readonly #models: ModelAccessStore;
  readonly #skills: SkillCatalogStore | undefined;
  readonly #mcp: McpCatalogStore | undefined;
  readonly #versions = new Map<string, PresetDefinition[]>();

  constructor(
    dshHome: string,
    models: ModelAccessStore,
    skills?: SkillCatalogStore,
    mcp?: McpCatalogStore,
  ) {
    this.#path = join(dshHome, "workagent", "presets.json");
    this.#models = models;
    this.#skills = skills;
    this.#mcp = mcp;
    if (existsSync(this.#path)) {
      const parsed: unknown = JSON.parse(readFileSync(this.#path, "utf8"));
      if (!Array.isArray(parsed))
        throw new Error("WorkAgent preset store is invalid");
      for (const raw of parsed) {
        const preset = presetDefinitionSchema.parse(raw);
        const versions = this.#versions.get(preset.id) ?? [];
        versions.push(preset);
        this.#versions.set(preset.id, versions);
      }
    }
    const now = new Date().toISOString();
    for (const engine of ["harness", "codex", "kimi"] as const) {
      const initial = builtin(now, engine);
      const versions = this.#versions.get(initial.id);
      if (versions === undefined) {
        this.#versions.set(initial.id, [initial]);
        continue;
      }
      const current = versions.at(-1)!;
      const configured = { ...initial, version: current.version };
      if (
        JSON.stringify({ ...current, createdAt: now, updatedAt: now }) !==
        JSON.stringify(configured)
      ) {
        versions.push({
          ...initial,
          version: current.version + 1,
          createdAt: current.createdAt,
        });
      }
    }
    if (!existsSync(this.#path) || this.#versions.size > 0) {
      this.#save();
    }
  }

  list(): readonly PresetDefinition[] {
    return [...this.#versions.values()]
      .map((versions) => versions.at(-1)!)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  get(id: string): PresetDefinition | undefined {
    return this.#versions.get(id)?.at(-1);
  }

  create(input: PresetMutation): PresetDefinition {
    const value = presetMutationSchema.parse(input);
    const now = new Date().toISOString();
    const preset = presetDefinitionSchema.parse({
      description: "",
      avatar: null,
      enabled: true,
      modelId: null,
      systemPrompt: "",
      workspacePolicy: "default",
      skillIds: [],
      mcpServerIds: [],
      toolAllowlist: [],
      approvalPolicy: "on_risk",
      ...value,
      id: `preset-${randomUUID()}`,
      version: 1,
      source: "user",
      createdAt: now,
      updatedAt: now,
    });
    this.#validate(preset);
    this.#versions.set(preset.id, [preset]);
    this.#save();
    return preset;
  }

  update(id: string, input: unknown): PresetDefinition {
    const current = this.#userPreset(id);
    const value = presetMutationSchema.partial().parse(input);
    const next = presetDefinitionSchema.parse({
      ...current,
      ...value,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    });
    this.#validate(next);
    this.#versions.get(id)!.push(next);
    this.#save();
    return next;
  }

  copy(id: string, name: string): PresetDefinition {
    const current = this.get(id);
    if (current === undefined) throw new Error("preset_not_found");
    return this.create({ ...current, name, engine: current.engine });
  }

  delete(id: string): void {
    this.#userPreset(id);
    this.#versions.delete(id);
    this.#save();
  }

  resolve(id: string): PresetBinding {
    const preset = this.get(id);
    if (preset === undefined) throw new Error("preset_not_found");
    if (!preset.enabled) throw new Error("preset_disabled");
    this.#validate(preset);
    return {
      presetId: preset.id,
      presetVersion: preset.version,
      resolvedSnapshot: {
        ...preset,
        resolvedAt: new Date().toISOString(),
        resolvedSkills: preset.skillIds.map(
          (id) => this.#skills!.getSkill(id)!,
        ),
        resolvedMcpServers: preset.mcpServerIds.map(
          (id) => this.#mcp!.getServer(id)!,
        ),
      },
    };
  }

  #userPreset(id: string): PresetDefinition {
    const current = this.get(id);
    if (current === undefined) throw new Error("preset_not_found");
    if (current.source !== "user") throw new Error("builtin_preset_immutable");
    return current;
  }

  #validate(preset: PresetDefinition): void {
    if (preset.modelId !== null) {
      const authorization = this.#models.authorizationFor(preset.modelId);
      if (!authorization.authorized)
        throw new Error(`invalid_model_binding:${authorization.reason}`);
      const model = this.#models.getModel(preset.modelId)!;
      if (model.providerId !== preset.engine)
        throw new Error("invalid_model_binding:engine_mismatch");
    }
    for (const id of preset.skillIds) {
      const skill = this.#skills?.getSkill(id);
      if (skill === undefined)
        throw new Error(`invalid_skill_binding:${id}:not_found`);
      if (!skill.enabled)
        throw new Error(`invalid_skill_binding:${id}:disabled`);
    }
    for (const id of preset.mcpServerIds) {
      const server = this.#mcp?.getServer(id);
      if (server === undefined)
        throw new Error(`invalid_mcp_binding:${id}:not_found`);
      if (!server.enabled)
        throw new Error(`invalid_mcp_binding:${id}:disabled`);
      if (server.oauthState === "needs_auth")
        throw new Error(`invalid_mcp_binding:${id}:needs_auth`);
    }
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const all = [...this.#versions.values()].flat();
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(all, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, this.#path);
  }
}
