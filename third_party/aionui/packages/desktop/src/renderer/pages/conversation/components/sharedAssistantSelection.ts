import type { Assistant } from '@/common/types/agent/assistantTypes';

const MANAGED_KIMI_MODELS = [
  'kimi-code/kimi-for-coding,thinking',
  'kimi-code/kimi-for-coding-highspeed,thinking',
  'kimi-code/kimi-k3,thinking',
];

export const sharedAssistantModels = (assistant: Assistant): string[] => {
  if (Array.isArray(assistant.models) && assistant.models.length > 0) return assistant.models;
  const backend = (assistant.agent?.acp_backend || assistant.agent?.type || '').toLowerCase();
  return backend.includes('kimi') ? MANAGED_KIMI_MODELS : [];
};

/**
 * Legacy assistant records can predate the `models` array. Keep collaboration
 * entry points tolerant of those records instead of crashing the whole shell.
 */
export const isSharedAssistant = (assistant: Assistant): boolean => {
  const backend = (assistant.agent?.acp_backend || assistant.agent?.type || '').toLowerCase();
  return (
    assistant.enabled &&
    sharedAssistantModels(assistant).length > 0 &&
    (backend.includes('codex') || backend.includes('kimi'))
  );
};
