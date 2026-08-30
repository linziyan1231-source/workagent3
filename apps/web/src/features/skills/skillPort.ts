import {
  skillCatalogEntrySchema,
  skillCatalogListSchema,
  type SkillCatalogEntry,
} from "@workagent/contracts";
import { requestJson } from "../../shared/api/http.js";

const base = "/api/runtime/v1/skills";

export const skillPort = {
  async list(): Promise<SkillCatalogEntry[]> {
    return skillCatalogListSchema.parse(await requestJson<unknown>(base));
  },
  async setEnabled(id: string, enabled: boolean): Promise<SkillCatalogEntry> {
    return skillCatalogEntrySchema.parse(
      await requestJson<unknown>(`${base}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      }),
    );
  },
  async remove(id: string): Promise<void> {
    await requestJson<void>(`${base}/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
};
