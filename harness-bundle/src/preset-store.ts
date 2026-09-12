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
  legacyPresetProjectionSchema,
  presetMutationSchema,
  type PresetBinding,
  type PresetDefinition,
  type PresetMutation,
  type LegacyPresetAsset,
  validEngineSelection,
} from "@workagent/contracts";
import type { ModelAccessStore } from "./model-access-store.js";
import type { McpCatalogStore, SkillCatalogStore } from "./capability-store.js";
import { butlerPrompt } from "./butler.js";

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
  enabled: engine !== "harness",
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
  readonly #builtinSettingsPath: string;
  readonly #builtinEnabled: Record<string, boolean>;
  readonly #builtinAvatarsPath: string;
  readonly #builtinAvatars: Record<string, string | null>;
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
    this.#builtinSettingsPath = join(
      dshHome,
      "workagent",
      "builtin-assistants.json",
    );
    this.#builtinEnabled = existsSync(this.#builtinSettingsPath)
      ? JSON.parse(readFileSync(this.#builtinSettingsPath, "utf8"))
      : {};
    this.#builtinAvatarsPath = join(
      dshHome,
      "workagent",
      "builtin-avatars.json",
    );
    this.#builtinAvatars = existsSync(this.#builtinAvatarsPath)
      ? JSON.parse(readFileSync(this.#builtinAvatarsPath, "utf8"))
      : {};
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
    const butler = {
      ...builtin(now, "codex"),
      id: "builtin-puxin-butler",
      name: "AI管家",
      description: "配置 MCP、技能、助手和消息渠道，查询用法并诊断问题",
      systemPrompt: butlerPrompt(),
    };
    for (const initial of [
      ...(["harness", "codex", "kimi"] as const).map((engine) =>
        builtin(now, engine),
      ),
      butler,
    ]) {
      initial.enabled = this.#builtinEnabled[initial.id] ?? initial.enabled;
      initial.avatar = this.#builtinAvatars[initial.id] ?? initial.avatar;
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
    const current = this.get(id);
    if (current === undefined) throw new Error("preset_not_found");
    const value = presetMutationSchema.partial().parse(input);
    if (
      current.source === "builtin" &&
      (Object.keys(value).length === 0 ||
        Object.keys(value).some((key) => key !== "enabled" && key !== "avatar"))
    )
      throw new Error("builtin_preset_immutable");
    const next = presetDefinitionSchema.parse({
      ...current,
      ...value,
      ...(value.engine && value.engine !== "acp"
        ? { acpCatalogId: undefined }
        : {}),
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    });
    const cosmeticOnly = Object.keys(value).every((key) => key === "avatar");
    const disabling =
      value.enabled === false && Object.keys(value).length === 1;
    if (!disabling && !cosmeticOnly) this.#validate(next);
    if (current.source === "builtin") {
      if (value.avatar !== undefined) {
        this.#builtinAvatars[id] = next.avatar;
        const temporary = `${this.#builtinAvatarsPath}.${process.pid}.tmp`;
        writeFileSync(
          temporary,
          `${JSON.stringify(this.#builtinAvatars, null, 2)}\n`,
          {
            encoding: "utf8",
            mode: 0o600,
          },
        );
        renameSync(temporary, this.#builtinAvatarsPath);
      }
      this.#builtinEnabled[id] = next.enabled;
      const temporary = `${this.#builtinSettingsPath}.${process.pid}.tmp`;
      writeFileSync(
        temporary,
        `${JSON.stringify(this.#builtinEnabled, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      renameSync(temporary, this.#builtinSettingsPath);
    }
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
    const skillIds = [
      ...new Set([
        ...preset.skillIds,
        ...(this.#skills?.listSkills() ?? [])
          .filter(
            (skill) =>
              skill.referenceDirectory &&
              skill.enabled &&
              skill.compatibleEngines?.includes(preset.engine) !== false &&
              skill.health === "ready" &&
              skill.requiredMcpServerIds.every(
                (id) => this.#mcp?.resolveServer(id)?.state === "ready",
              ),
          )
          .map((skill) => skill.id),
      ]),
    ];
    const mcpServerIds = [
      ...new Set([
        ...preset.mcpServerIds,
        ...(this.#mcp?.listServers() ?? [])
          .filter(
            (server) =>
              server.transport.globalSource &&
              server.enabled &&
              this.#mcp?.resolveServer(server.id)?.state === "ready" &&
              (server.transport.kind !== "sse" || preset.engine === "kimi") &&
              (server.toolPolicy === "all" || preset.engine === "codex"),
          )
          .map((server) => server.id),
      ]),
    ];
    return {
      presetId: preset.id,
      presetVersion: preset.version,
      resolvedSnapshot: {
        ...preset,
        skillIds,
        mcpServerIds,
        resolvedAt: new Date().toISOString(),
        resolvedSkills: skillIds.map((id) => this.#skills!.getSkill(id)!),
        resolvedMcpServers: mcpServerIds.map((id) => this.#mcp!.getServer(id)!),
      },
    };
  }

  importLegacy(input: unknown): {
    results: Array<{
      sourceId: string;
      targetId: string;
      kind: "preset" | "skill_binding" | "mcp_binding";
      status: "ready" | "needs_auth" | "needs_review" | "failed";
      reason?: string;
    }>;
  } {
    const projection = legacyPresetProjectionSchema.parse(input);
    const presetResults = projection.presets.map((asset) => {
      const targetId = `legacy-preset:${encodeURIComponent(asset.oldId)}`;
      const existing = this.get(targetId);
      if (existing !== undefined) {
        if (
          existing.source !== "user" ||
          existing.createdAt !== projection.capturedAt
        )
          return {
            sourceId: asset.oldId,
            targetId,
            kind: "preset" as const,
            status: "needs_review" as const,
            reason: "preset_id_conflict",
          };
        const result = this.#legacyResult(asset, existing);
        if (
          result.status === "ready" &&
          asset.enabled &&
          !existing.enabled &&
          existing.version === 1 &&
          existing.updatedAt === projection.capturedAt
        ) {
          this.#versions.get(targetId)!.push({
            ...existing,
            version: 2,
            enabled: true,
            updatedAt: new Date().toISOString(),
          });
          this.#save();
        }
        return result;
      }
      const now = projection.capturedAt;
      const candidate = presetDefinitionSchema.parse({
        id: targetId,
        version: 1,
        source: "user",
        name: asset.name,
        description: asset.description,
        avatar: asset.avatar,
        enabled: false,
        engine: asset.engine,
        modelId: asset.modelId,
        systemPrompt: asset.systemPrompt,
        workspacePolicy: "default",
        skillIds: asset.skillIds,
        mcpServerIds: asset.mcpServerIds,
        toolAllowlist: [],
        approvalPolicy: asset.approvalPolicy,
        createdAt: now,
        updatedAt: now,
      });
      const result = this.#legacyResult(asset, candidate);
      const imported = {
        ...candidate,
        enabled: asset.enabled && result.status === "ready",
      };
      this.#versions.set(targetId, [imported]);
      this.#save();
      return result.status === "ready" && !asset.enabled
        ? { ...result, status: "ready" as const }
        : result;
    });
    const results = presetResults.flatMap((result, index) => {
      const asset = projection.presets[index]!;
      return [
        result,
        ...asset.skillBindingIds.map((sourceId) => ({
          ...result,
          sourceId,
          kind: "skill_binding" as const,
        })),
        ...asset.mcpBindingIds.map((sourceId) => ({
          ...result,
          sourceId,
          kind: "mcp_binding" as const,
        })),
      ];
    });
    return { results };
  }

  #legacyResult(asset: LegacyPresetAsset, preset: PresetDefinition) {
    const issues = [...asset.migrationIssues];
    try {
      this.#validate({ ...preset, enabled: asset.enabled });
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "invalid_preset");
    }
    if (preset.version > 1) {
      try {
        this.#validate(preset);
        if (preset.enabled || !asset.enabled)
          return {
            sourceId: asset.oldId,
            targetId: preset.id,
            kind: "preset" as const,
            status: "ready" as const,
          };
      } catch {
        // The current user-edited version remains reviewable below.
      }
    }
    const uniqueIssues = [...new Set(issues)].sort();
    if (uniqueIssues.length === 0)
      return {
        sourceId: asset.oldId,
        targetId: preset.id,
        kind: "preset" as const,
        status: "ready" as const,
      };
    return {
      sourceId: asset.oldId,
      targetId: preset.id,
      kind: "preset" as const,
      status: uniqueIssues.some((issue) => issue.includes("needs_auth"))
        ? ("needs_auth" as const)
        : ("needs_review" as const),
      reason: uniqueIssues.join(","),
    };
  }

  #userPreset(id: string): PresetDefinition {
    const current = this.get(id);
    if (current === undefined) throw new Error("preset_not_found");
    if (current.source !== "user") throw new Error("builtin_preset_immutable");
    return current;
  }

  #validate(preset: PresetDefinition): void {
    if (!validEngineSelection(preset)) throw new Error("invalid_acp_selection");
    if (preset.modelId !== null && preset.engine !== "acp") {
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
      if (preset.enabled && !skill.enabled)
        throw new Error(`invalid_skill_binding:${id}:disabled`);
      if (preset.enabled && skill.health === "unavailable")
        throw new Error(
          `invalid_skill_binding:${id}:${skill.unavailableReason ?? "unavailable"}`,
        );
    }
    for (const id of preset.mcpServerIds) {
      const server = this.#mcp?.getServer(id);
      if (server === undefined)
        throw new Error(`invalid_mcp_binding:${id}:not_found`);
      if (preset.enabled && !server.enabled)
        throw new Error(`invalid_mcp_binding:${id}:disabled`);
      if (preset.enabled && server.oauthState === "needs_auth")
        throw new Error(`invalid_mcp_binding:${id}:needs_auth`);
      if (
        preset.enabled &&
        (server.health === "unavailable" || server.health === "needs_review")
      )
        throw new Error(`invalid_mcp_binding:${id}:${server.health}`);
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
