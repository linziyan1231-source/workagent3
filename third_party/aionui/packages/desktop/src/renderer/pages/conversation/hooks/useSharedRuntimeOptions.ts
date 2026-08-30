import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type { PortalSharedRuntimeOptions } from '@/common/adapter/ipcBridge';

export const useSharedRuntimeOptions = (backend?: 'codex' | 'kimi') => {
  const { data, isLoading, error } = useSWR<PortalSharedRuntimeOptions>(
    backend ? `portal.sharedRuntimeOptions.${backend}` : null,
    () => ipcBridge.portal.getSharedRuntimeOptions.invoke({ backend: backend! })
  );
  return { options: data, isLoading, error };
};
