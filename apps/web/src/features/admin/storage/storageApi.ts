import { requestJson } from "../../../shared/api/http.js";

export type StorageUsage = Record<
  "personal" | "shared",
  { usedBytes: number; limitBytes: number; enabled: boolean; hard: boolean }
>;
export type StorageLimits = { personalBytes: number; sharedBytes: number };

export const storageApi = {
  usage: (username: string, signal?: AbortSignal) =>
    requestJson<StorageUsage>(
      `/api/portal/admin/storage?username=${encodeURIComponent(username)}`,
      { signal },
    ),
  update: (username: string, limits: StorageLimits) =>
    requestJson<StorageUsage>("/api/portal/admin/storage", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, limits }),
    }),
};

export const gibibytesToBytes = (value: FormDataEntryValue | null) =>
  Math.round(Number(value) * 1024 ** 3);
