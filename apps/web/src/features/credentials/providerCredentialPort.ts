import {
  credentialStatusSchema,
  providerHealthSchema,
  type CredentialStatus,
  type ProviderHealth,
} from "@workagent/contracts";
import { requestJson } from "../../shared/api/http.js";

const endpoint = "/api/runtime/v1/provider-credentials/harness";

export const providerCredentialPort = {
  async put(secret: string): Promise<CredentialStatus> {
    return credentialStatusSchema.parse(
      await requestJson<unknown>(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: secret,
      }),
    );
  },
  async revoke(): Promise<void> {
    await requestJson<void>(endpoint, { method: "DELETE" });
  },
  async test(): Promise<ProviderHealth> {
    return providerHealthSchema.parse(
      await requestJson<unknown>(`${endpoint}/test`, { method: "POST" }),
    );
  },
};
