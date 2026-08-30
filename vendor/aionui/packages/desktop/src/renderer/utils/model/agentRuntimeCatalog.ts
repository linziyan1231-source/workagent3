/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AcpModelInfo, AcpSessionConfigOption } from '@/common/types/platform/acpTypes';
import type { AgentModeOption } from './agentTypes';

const MANAGED_KIMI_MODEL_IDS = new Set([
  'kimi-code/kimi-for-coding',
  'kimi-code/kimi-for-coding,thinking',
  'kimi-code/kimi-for-coding-highspeed',
  'kimi-code/kimi-for-coding-highspeed,thinking',
  'kimi-code/kimi-k3',
  'kimi-code/kimi-k3,thinking',
]);

const MANAGED_KIMI_MODEL_CATALOGS = [
  new Set([
    'kimi-code/kimi-for-coding',
    'kimi-code/kimi-for-coding,thinking',
    'kimi-code/kimi-for-coding-highspeed',
    'kimi-code/kimi-for-coding-highspeed,thinking',
  ]),
  MANAGED_KIMI_MODEL_IDS,
];

const MANAGED_KIMI_THINKING_LABELS = new Map([
  ['kimi-code/kimi-for-coding,thinking', 'kimi-k2.7'],
  ['kimi-code/kimi-for-coding-highspeed,thinking', 'kimi-k2.7-highspeed'],
  ['kimi-code/kimi-k3,thinking', 'kimi-k3'],
]);

export type AgentRuntimeCatalog = {
  available_models?: unknown;
  available_modes?: unknown;
  config_options?: unknown;
};

export type AgentRuntimeSelectState = {
  id: string;
  currentValue?: string;
  options: AgentModeOption[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonPayload(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function normalizeConfigOptions(value: unknown): AcpSessionConfigOption[] {
  const payload = parseJsonPayload(value);
  if (Array.isArray(payload)) {
    return payload as AcpSessionConfigOption[];
  }

  if (!isRecord(payload) || !Array.isArray(payload.config_options)) {
    return [];
  }

  return payload.config_options as AcpSessionConfigOption[];
}

function normalizeModelOption(value: unknown): { id: string; label: string; description?: string } | null {
  if (typeof value === 'string' && value.trim()) {
    return { id: value, label: value };
  }

  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id : typeof value.value === 'string' ? value.value : '';
  if (!id) return null;
  const label = typeof value.label === 'string' ? value.label : typeof value.name === 'string' ? value.name : id;
  const description = typeof value.description === 'string' ? value.description : undefined;
  return { id, label, description };
}

function buildModelInfoFromPayload(value: unknown): AcpModelInfo | null {
  const payload = parseJsonPayload(value);
  if (!isRecord(payload) || !Array.isArray(payload.available_models)) {
    return null;
  }

  const available_models = payload.available_models.map(normalizeModelOption).filter((item) => item !== null);
  if (available_models.length === 0) return null;

  const current_model_id =
    typeof payload.current_model_id === 'string'
      ? payload.current_model_id
      : typeof payload.currentModelId === 'string'
        ? payload.currentModelId
        : (available_models[0]?.id ?? null);
  const matchedModel = available_models.find((model) => model.id === current_model_id);
  const current_model_label =
    typeof payload.current_model_label === 'string'
      ? payload.current_model_label
      : typeof payload.currentModelLabel === 'string'
        ? payload.currentModelLabel
        : (matchedModel?.label ?? current_model_id);

  return {
    current_model_id,
    current_model_label,
    available_models,
  };
}

function getConfigOptionCurrentValue(option: AcpSessionConfigOption): string | undefined {
  const optionRecord = option as AcpSessionConfigOption & { currentValue?: string };
  return option.current_value || option.selected_value || optionRecord.currentValue;
}

function buildModelInfoFromConfigOptions(configOptions: AcpSessionConfigOption[]): AcpModelInfo | null {
  const modelOption = configOptions.find((option) => option.category === 'model' && option.type === 'select');
  if (!modelOption?.options || modelOption.options.length === 0) return null;

  const available_models = modelOption.options.map((option) => ({
    id: option.value,
    label: option.label || option.name || option.value,
    description: option.description || undefined,
  }));
  const current_model_id = getConfigOptionCurrentValue(modelOption) || available_models[0]?.id || null;
  const matchedModel = available_models.find((model) => model.id === current_model_id);

  return {
    current_model_id,
    current_model_label: matchedModel?.label ?? current_model_id,
    available_models,
  };
}

export function isManagedKimiModelCatalog(values: string[]): boolean {
  const uniqueValues = new Set(values);
  return MANAGED_KIMI_MODEL_CATALOGS.some(
    (catalog) =>
      values.length === catalog.size &&
      uniqueValues.size === catalog.size &&
      [...uniqueValues].every((value) => catalog.has(value))
  );
}

export function getManagedKimiThinkingLabel(value: string): string | undefined {
  return MANAGED_KIMI_THINKING_LABELS.get(value);
}

export function toManagedKimiThinkingModel(value: string | null): string | null {
  if (!value || !MANAGED_KIMI_MODEL_IDS.has(value)) return value;
  return value.endsWith(',thinking') ? value : `${value},thinking`;
}

export function normalizeManagedKimiModelInfo(modelInfo: AcpModelInfo | null): AcpModelInfo | null {
  if (!modelInfo || !isManagedKimiModelCatalog(modelInfo.available_models.map((model) => model.id))) {
    return modelInfo;
  }

  const currentModelId = toManagedKimiThinkingModel(modelInfo.current_model_id);
  const availableModels = modelInfo.available_models
    .filter((model) => MANAGED_KIMI_THINKING_LABELS.has(model.id))
    .map((model) => Object.assign({}, model, { label: MANAGED_KIMI_THINKING_LABELS.get(model.id)! }));

  return {
    ...modelInfo,
    current_model_id: currentModelId,
    current_model_label:
      (currentModelId && MANAGED_KIMI_THINKING_LABELS.get(currentModelId)) || modelInfo.current_model_label,
    available_models: availableModels,
  };
}

export function buildAgentRuntimeModelInfo(agent: AgentRuntimeCatalog | null | undefined): AcpModelInfo | null {
  if (!agent) return null;

  return normalizeManagedKimiModelInfo(
    buildModelInfoFromConfigOptions(normalizeConfigOptions(agent.config_options)) ??
      buildModelInfoFromPayload(agent.available_models)
  );
}

function normalizeModeOption(value: unknown): AgentModeOption | null {
  if (typeof value === 'string' && value.trim()) {
    return { value, label: value };
  }

  if (!isRecord(value)) return null;
  const modeValue = typeof value.id === 'string' ? value.id : typeof value.value === 'string' ? value.value : '';
  if (!modeValue) return null;

  return {
    value: modeValue,
    label: typeof value.name === 'string' ? value.name : typeof value.label === 'string' ? value.label : modeValue,
    description: typeof value.description === 'string' ? value.description : undefined,
  };
}

function buildModeStateFromPayload(value: unknown): { currentMode?: string; options: AgentModeOption[] } {
  const payload = parseJsonPayload(value);
  if (!isRecord(payload) || !Array.isArray(payload.available_modes)) {
    return { options: [] };
  }

  return {
    currentMode:
      typeof payload.current_mode_id === 'string'
        ? payload.current_mode_id
        : typeof payload.currentModeId === 'string'
          ? payload.currentModeId
          : undefined,
    options: payload.available_modes.map(normalizeModeOption).filter((item) => item !== null),
  };
}

function buildModeStateFromConfigOptions(configOptions: AcpSessionConfigOption[]): {
  currentMode?: string;
  options: AgentModeOption[];
} {
  const modeOption = configOptions.find((option) => option.category === 'mode' && option.type === 'select');
  if (!modeOption?.options || modeOption.options.length === 0) {
    return { options: [] };
  }

  return {
    currentMode: getConfigOptionCurrentValue(modeOption),
    options: modeOption.options.map((option) => {
      const description = (option as unknown as Record<string, unknown>).description;
      return {
        value: option.value,
        label: option.label || option.name || option.value,
        description: typeof description === 'string' ? description : undefined,
      };
    }),
  };
}

export function buildAgentRuntimeModeState(agent: AgentRuntimeCatalog | null | undefined): {
  currentMode?: string;
  options: AgentModeOption[];
} {
  if (!agent) return { options: [] };

  const fromConfigOptions = buildModeStateFromConfigOptions(normalizeConfigOptions(agent.config_options));
  if (fromConfigOptions.options.length > 0) return fromConfigOptions;

  const fromTopLevelModes = buildModeStateFromPayload(agent.available_modes);
  if (fromTopLevelModes.options.length > 0) return fromTopLevelModes;

  return { options: [] };
}

export function buildAgentRuntimeThoughtLevel(
  agent: AgentRuntimeCatalog | null | undefined
): AgentRuntimeSelectState | null {
  if (!agent) return null;

  const configOptions = normalizeConfigOptions(agent.config_options);
  const thoughtLevel =
    configOptions.find((option) => option.category === 'thought_level') ??
    configOptions.find((option) => option.id === 'thought_level' || option.id === 'reasoning_effort');
  if (thoughtLevel?.type !== 'select' || !thoughtLevel.options?.length) return null;

  return {
    id: thoughtLevel.id,
    currentValue: getConfigOptionCurrentValue(thoughtLevel),
    options: thoughtLevel.options.map((option) => ({
      value: option.value,
      label: option.label || option.name || option.value,
      description: option.description,
    })),
  };
}
