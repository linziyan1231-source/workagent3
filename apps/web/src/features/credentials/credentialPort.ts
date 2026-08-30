import {
  credentialCreateSchema,
  credentialStatusSchema,
  type CredentialCreate,
  type CredentialStatus,
} from "@workagent/contracts";
import { requestJson } from "../../shared/api/http.js";

const base = "/api/runtime/v1/credentials";

export const credentialPort = {
  async create(input: CredentialCreate): Promise<CredentialStatus> {
    return credentialStatusSchema.parse(
      await requestJson<unknown>(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(credentialCreateSchema.parse(input)),
      }),
    );
  },
  async revoke(id: string): Promise<void> {
    await requestJson<void>(`${base}/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
};
