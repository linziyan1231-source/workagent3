import {
  authorizedModelCatalogListSchema,
  quotaUsageSchema,
  type AuthorizedModelCatalogEntry,
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
