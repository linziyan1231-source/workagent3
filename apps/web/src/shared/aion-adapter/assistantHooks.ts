import type { IProvider } from "@/common/config/storage";
import type { ManagedAgent } from "@renderer/utils/model/agentTypes";
import useSWR, { mutate } from "swr";
import type { EngineStatus } from "@workagent/contracts";
import { conversationPort } from "../../features/conversation/conversationPort.js";
import { modelAccessPort } from "../../features/models/modelAccessPort.js";

export const MANAGED_AGENTS_SWR_KEY = "workagent.engines.managed";

const toManagedAgent = (engine: EngineStatus): ManagedAgent => ({
  id: engine.id,
  name: engine.label,
  description: engine.detail,
  backend: engine.id,
  agent_type: engine.id === "harness" ? "aionrs" : "acp",
  agent_source: engine.id === "harness" ? "internal" : "builtin",
  enabled: true,
  installed: engine.state !== "unavailable",
  status:
    engine.state === "ready"
      ? "online"
      : engine.state === "unavailable"
        ? "missing"
        : engine.state === "unknown"
          ? "unchecked"
          : "offline",
  last_check_status: engine.state === "ready" ? "online" : "offline",
  last_check_error_code:
    engine.state === "needs_auth"
      ? "auth_required"
      : engine.state === "unavailable"
        ? "command_missing"
        : undefined,
  last_check_error_message: engine.detail,
  behavior_policy: {
    supports_side_question: engine.capabilities.steer,
  },
});

export const fetchManagedAgents = async (): Promise<ManagedAgent[]> =>
  (await conversationPort.engines()).map(toManagedAgent);

export const useManagedAgentRuntimeCatalog = (): ManagedAgent[] => {
  const { data } = useSWR<ManagedAgent[]>(
    MANAGED_AGENTS_SWR_KEY,
    fetchManagedAgents,
  );
  return data ?? [];
};

export const refreshManagedAgentCatalogAndAssistants = () =>
  mutate<ManagedAgent[]>(MANAGED_AGENTS_SWR_KEY);
export const getManagedAgents = fetchManagedAgents;
export const useManagedAgents = () => {
  const { data, error, isLoading, isValidating } = useSWR<ManagedAgent[]>(
    MANAGED_AGENTS_SWR_KEY,
    fetchManagedAgents,
  );
  const refresh = () => mutate<ManagedAgent[]>(MANAGED_AGENTS_SWR_KEY);
  return {
    agents: data ?? [],
    isLoading,
    isRefreshing: isValidating && !isLoading,
    error,
    revalidate: refresh,
    refreshCatalog: refresh,
    refreshCustomAgents: async () => {
      await refresh();
    },
  };
};

export const PROVIDERS_SWR_KEY = "providers";
export const PROVIDERS_SWR_OPTIONS = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  shouldRetryOnError: false,
};
export const fetchProviders = () => modelAccessPort.providers();
export const useProvidersQuery = () =>
  useSWR<IProvider[]>(PROVIDERS_SWR_KEY, fetchProviders, PROVIDERS_SWR_OPTIONS);

export const useModelProviderList = () => {
  const { data } = useProvidersQuery();
  const providers = (data ?? []).filter(
    (provider) => provider.enabled !== false,
  );
  return {
    providers,
    getAvailableModels: (provider: IProvider) =>
      provider.models.filter(
        (model) => provider.model_enabled?.[model] !== false,
      ),
    formatModelLabel: (_provider: unknown, modelName?: string) =>
      modelName ?? "",
  };
};
