import {
  providerHealthSchema,
  type ProviderHealth,
} from "@workagent/contracts";
import { requestJson } from "../../shared/api/http.js";

const endpoint = "/api/runtime/v1/provider-credentials/harness";

// The managed Harness Provider key never crosses the browser boundary: the
// only remaining operation is the health probe. Status (ready/needs_setup)
// comes from the credential listing.
export const providerCredentialPort = {
  async test(): Promise<ProviderHealth> {
    return providerHealthSchema.parse(
      await requestJson<unknown>(`${endpoint}/test`, { method: "POST" }),
    );
  },
};
