import {
  authorizedModelCatalogListSchema,
  gatewayUsageSchema,
  quotaUsageSchema,
  type AuthorizedModelCatalogEntry,
  type GatewayUsage,
  type QuotaUsage,
} from "@workagent/contracts";
import { ApiError, requestJson } from "../../shared/api/http.js";

export type ModelQuotaUsage = {
  model: AuthorizedModelCatalogEntry;
  usage: QuotaUsage | null;
};

export const quotaPort = {
  async usage(modelId: string): Promise<QuotaUsage | null> {
    try {
      return quotaUsageSchema.parse(
        await requestJson<unknown>(
          `/api/quota/usage?model_id=${encodeURIComponent(modelId)}`,
        ),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },

  // Authoritative gateway usage drained by the Employee Manager; 503 means the
  // quota module is not wired and the page hides the gateway section.
  async gatewayUsage(): Promise<GatewayUsage | null> {
    try {
      return gatewayUsageSchema.parse(
        await requestJson<unknown>("/api/quota/gateway-usage"),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 503) return null;
      throw error;
    }
  },

  async list(): Promise<ModelQuotaUsage[]> {
    const models = authorizedModelCatalogListSchema.parse(
      await requestJson<unknown>("/api/models"),
    );
    const authorized = models.filter((model) => model.authorization.authorized);
    return Promise.all(
      authorized.map(async (model) => ({
        model,
        usage: await this.usage(model.id),
      })),
    );
  },
};
