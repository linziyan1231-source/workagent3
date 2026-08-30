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
export const PROVIDERS_SWR_OPTIONS = {};
export const fetchProviders = async () => [];
export const useProvidersQuery = () => ({
  data: [],
  isLoading: false,
  error: undefined,
});

export const useModelProviderList = () => ({
  providers: [],
  getAvailableModels: () => [],
  formatModelLabel: (_provider: unknown, modelName?: string) => modelName ?? "",
});
