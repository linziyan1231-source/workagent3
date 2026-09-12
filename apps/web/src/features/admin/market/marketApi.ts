import { postJson, requestJson } from "../../../shared/api/http.js";

export type Entry = {
  id: string;
  seriesId: string;
  name: string;
  kind: string;
  version: string;
  publisher: string;
  releaseNotes: string;
  revoked: boolean;
};
export type Action = {
  id: string;
  seriesId: string;
  action: string;
  reason: string;
  createdAt: string;
  actor: string;
  targets: { sid: string; state: string; error?: string }[];
};
export type MarketCatalog = { entries: Entry[]; actions: Action[] };
export const marketApi = {
  catalog: () => requestJson<MarketCatalog>("/api/portal/admin/marketplace"),
  act: (selection: {
    seriesId: string;
    targetId: string;
    action: string;
    reason: string;
  }) => postJson<void>("/api/portal/admin/marketplace", selection),
  retry: (retryId: string) =>
    postJson<void>("/api/portal/admin/marketplace", { retryId }),
};
