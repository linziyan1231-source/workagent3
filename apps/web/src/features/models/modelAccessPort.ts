import {
  authorizedModelCatalogListSchema,
  credentialStatusListSchema,
  type AuthorizedModelCatalogEntry,
  type CredentialStatus,
} from "@workagent/contracts";
import type { IProvider } from "@/common/config/storage";
import { requestJson } from "../../shared/api/http.js";

export type ModelAccessSnapshot = {
  models: AuthorizedModelCatalogEntry[];
  credentials: CredentialStatus[];
};

const managedProvider = (providerId: string) => {
  if (providerId === "codex")
    return {
      id: "managed-cliproxy-chatgpt",
      name: "ChatGPT",
      platform: "openai",
    };
  if (providerId === "kimi")
    return {
      id: "managed-cliproxy-kimi",
      name: "KIMI",
      platform: "openai",
    };
  return {
    id: `managed-workagent-${providerId}`,
    name: providerId === "harness" ? "Harness" : providerId,
    platform: "openai",
  };
};

export const toRendererProviders = (
  models: readonly AuthorizedModelCatalogEntry[],
): IProvider[] => {
  const groups = new Map<string, AuthorizedModelCatalogEntry[]>();
  for (const model of models) {
    const current = groups.get(model.providerId) ?? [];
    current.push(model);
    groups.set(model.providerId, current);
  }
  return [...groups].map(([providerId, entries]) => {
    const provider = managedProvider(providerId);
    return {
      ...provider,
      base_url: "",
      api_key: "",
      models: entries.map((model) => model.id),
      enabled: entries.some((model) => model.authorization.authorized),
      model_enabled: Object.fromEntries(
        entries.map((model) => [model.id, model.authorization.authorized]),
      ),
      model_health: Object.fromEntries(
        entries.map((model) => [
          model.id,
          {
            status:
              model.health === "healthy"
                ? "healthy"
                : model.health === "unknown"
                  ? "unknown"
                  : "unhealthy",
          },
        ]),
      ),
    } satisfies IProvider;
  });
};

export const modelAccessPort = {
  async snapshot(): Promise<ModelAccessSnapshot> {
    const [models, credentials] = await Promise.all([
      requestJson<unknown>("/api/models"),
      requestJson<unknown>("/api/runtime/v1/credentials"),
    ]);
    return {
      models: authorizedModelCatalogListSchema.parse(models),
      credentials: credentialStatusListSchema.parse(credentials),
    };
  },
  async providers(): Promise<IProvider[]> {
    return toRendererProviders((await this.snapshot()).models);
  },
};
