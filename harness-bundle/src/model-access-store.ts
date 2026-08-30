import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  modelCatalogEntrySchema,
  type CredentialStatus,
  type ModelAuthorization,
  type ModelCatalogEntry,
} from "@workagent/contracts";

const DEFAULT_MODELS: readonly ModelCatalogEntry[] = [
  {
    id: "harness-default",
    providerId: "harness",
    displayName: "Harness default",
    aliases: ["default"],
    contextWindow: 128_000,
    inputPricePerMillion: null,
    outputPricePerMillion: null,
    health: "unknown",
  },
  {
    id: "codex-native",
    providerId: "codex",
    displayName: "Codex native",
    aliases: [],
    contextWindow: 128_000,
    inputPricePerMillion: null,
    outputPricePerMillion: null,
    health: "unknown",
  },
  {
    id: "kimi-native",
    providerId: "kimi",
    displayName: "Kimi native",
    aliases: [],
    contextWindow: 128_000,
    inputPricePerMillion: null,
    outputPricePerMillion: null,
    health: "unknown",
  },
];

export class ModelAccessStore {
  readonly #models: readonly ModelCatalogEntry[];
  readonly #authorized: ReadonlySet<string>;

  constructor(dshHome: string) {
    const path = join(dshHome, "workagent", "model-access.json");
    if (!existsSync(path)) {
      this.#models = DEFAULT_MODELS;
      this.#authorized = new Set(DEFAULT_MODELS.map((model) => model.id));
      return;
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("WorkAgent model access configuration is invalid");
    const value = parsed as Record<string, unknown>;
    if (
      !Array.isArray(value.models) ||
      !Array.isArray(value.authorizedModelIds)
    )
      throw new Error("WorkAgent model access configuration is invalid");
    this.#models = value.models.map((model) =>
      modelCatalogEntrySchema.parse(model),
    );
    this.#authorized = new Set(
      value.authorizedModelIds.map((id) => {
        if (typeof id !== "string" || id.length === 0)
          throw new Error("WorkAgent model authorization is invalid");
        return id;
      }),
    );
  }

  listModels(): readonly ModelCatalogEntry[] {
    return this.#models;
  }

  getModel(modelId: string): ModelCatalogEntry | undefined {
    return this.#models.find((model) => model.id === modelId);
  }

  authorizationFor(modelId: string): ModelAuthorization {
    if (this.getModel(modelId) === undefined)
      return { modelId, authorized: false, reason: "model_not_found" };
    return this.#authorized.has(modelId)
      ? { modelId, authorized: true }
      : { modelId, authorized: false, reason: "model_not_authorized" };
  }
}

export class CredentialStatusStore {
  readonly #dshHome: string;

  constructor(dshHome: string) {
    this.#dshHome = dshHome;
  }

  listStatuses(): readonly CredentialStatus[] {
    return [
      this.#native("codex-native", "codex_native", "Codex", ".codex"),
      this.#native("kimi-native", "kimi_native", "Kimi", ".kimi"),
    ];
  }

  statusFor(id: string): CredentialStatus | undefined {
    return this.listStatuses().find((status) => status.id === id);
  }

  #native(
    id: string,
    kind: "codex_native" | "kimi_native",
    label: string,
    directory: string,
  ): CredentialStatus {
    return {
      id,
      kind,
      label,
      state: existsSync(join(this.#dshHome, directory))
        ? "ready"
        : "needs_auth",
      updatedAt: null,
    };
  }
}
