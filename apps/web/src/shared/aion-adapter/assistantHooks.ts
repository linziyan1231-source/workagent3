import type { IProvider } from "@/common/config/storage";
import useSWR from "swr";
import { modelAccessPort } from "../../features/models/modelAccessPort.js";

export const useManagedAgentRuntimeCatalog = () => [];

export const refreshManagedAgentCatalogAndAssistants = async () => [];
export const getManagedAgents = async () => [];
export const useManagedAgents = () => ({
  agents: [],
  isLoading: false,
  isRefreshing: false,
  error: undefined,
  revalidate: async () => [],
  refreshCatalog: async () => [],
  refreshCustomAgents: async () => undefined,
});

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
