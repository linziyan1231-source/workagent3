import { apiRoot, request } from "../../platform/api.js";
import { Select } from "../../ui/elements.js";
import {
  displayPresetName,
  displayValue,
  reasoningLabel,
} from "../../ui/labels.js";
import { AGENT_PICK_KEY } from "./state.js";
import React from "react";
import { createElement as h } from "react";

const MODEL_DEFAULTS_KEY = "workagent.model-defaults.v1";

const MODEL_DEFAULTS_EVENT = "workagent:model-defaults";

const permissionOptions = [
  ["read_only", "只读"],
  ["workspace_write", "项目内读写"],
  ["full_access", "完全访问"],
];

const readModelDefaults = () => localStorage.getItem(MODEL_DEFAULTS_KEY);

const subscribeModelDefaults = (listener) => {
  const onStorage = (event) => {
    if (event.key === MODEL_DEFAULTS_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(MODEL_DEFAULTS_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(MODEL_DEFAULTS_EVENT, listener);
  };
};

function parseModelDefaults(raw) {
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value))
      return value;
  } catch {
    /* A damaged browser preference falls back to the product defaults. */
  }
  return {};
}

function useModelDefaults() {
  const raw = React.useSyncExternalStore(
    subscribeModelDefaults,
    readModelDefaults,
  );
  return [
    parseModelDefaults(raw),
    (key, value) => {
      const saved = parseModelDefaults(readModelDefaults());
      localStorage.setItem(
        MODEL_DEFAULTS_KEY,
        JSON.stringify({
          ...saved,
          [key]: { ...saved[key], ...value },
        }),
      );
      window.dispatchEvent(new window.Event(MODEL_DEFAULTS_EVENT));
    },
    raw,
  ];
}

function defaultEffort(engine, model) {
  const options = model?.reasoning || [];
  if (engine === "codex" && options.some((option) => option.id === "low"))
    return "low";
  if (engine === "kimi") {
    const lowest = [
      "off",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ].find((id) => options.some((option) => option.id === id));
    return lowest || options[0]?.id || "";
  }
  return (
    options.find((option) => option.id === model?.defaultReasoning)?.id ||
    options[0]?.id ||
    ""
  );
}

const modelDefaultsKey = (group, preset) =>
  preset?.source === "user"
    ? `assistant:${preset.id}:${preset.engine}`
    : group?.engine;

function resolveModelDefaults(group, preferences, preset) {
  const models = group?.models || [];
  const saved = preferences[modelDefaultsKey(group, preset)];
  const preferred =
    group?.engine === "codex"
      ? ["gpt-6-astra"]
      : group?.engine === "kimi"
        ? ["kimi-code/kimi-k3", "kimi-k3", "k3"]
        : [];
  const model =
    models.find((model) => model.id === saved?.modelId) ||
    models.find((model) => model.id === preset?.modelId) ||
    models.find((model) => preferred.includes(model.id)) ||
    models.find((model) => model.isDefault) ||
    models[0];
  return {
    modelId: model?.id || "",
    thinkingEffort:
      model?.id === saved?.modelId &&
      model?.reasoning.some((option) => option.id === saved.thinkingEffort)
        ? saved.thinkingEffort
        : defaultEffort(group?.engine, model),
    permissionMode: permissionOptions.some(
      ([id]) => id === saved?.permissionMode,
    )
      ? saved.permissionMode
      : group?.engine === "acp" || preset?.engine === "acp"
        ? ""
        : "workspace_write",
  };
}

function ModelDefaultsFields({ group, preset, defaults, save }) {
  const model = group.models.find((model) => model.id === defaults.modelId);
  const name = preset
    ? displayPresetName(preset.name)
    : displayValue(group.engine);
  const key = modelDefaultsKey(group, preset);
  const field = (label, props) =>
    h(
      "label",
      null,
      h("span", null, label),
      h(Select, { "aria-label": `${name} ${label}`, ...props }),
    );
  return h(
    "div",
    { className: "workagent-model-defaults" },
    field("默认模型", {
      value: defaults.modelId,
      disabled: !group.models.length,
      options: group.models.length
        ? group.models.map((model) => [model.id, model.name])
        : [["", "暂无可用模型"]],
      onChange: (event) => {
        const next = group.models.find(
          (model) => model.id === event.target.value,
        );
        save(key, {
          modelId: next.id,
          thinkingEffort: defaultEffort(group.engine, next),
        });
      },
    }),
    field("默认思考强度", {
      value: defaults.thinkingEffort,
      disabled: !model?.reasoning.length,
      options: model?.reasoning.length
        ? model.reasoning.map((option) => [option.id, reasoningLabel(option)])
        : [["", "未提供思考选项"]],
      onChange: (event) =>
        save(key, {
          modelId: defaults.modelId,
          thinkingEffort: event.target.value,
        }),
    }),
    field("默认权限", {
      value: defaults.permissionMode,
      options:
        group.engine === "acp"
          ? [
              ["", "使用引擎原生审批"],
              ...permissionOptions.filter(
                ([id]) => group.permissionModes?.[id],
              ),
            ]
          : permissionOptions,
      onChange: (event) =>
        save(key, {
          permissionMode: event.target.value,
        }),
    }),
  );
}

// Shared-project personal tasks start from the hero's saved agent and the
// persisted model defaults, without the composer's ephemeral draft choices.
async function personalTaskDefaults() {
  const picked = localStorage.getItem(AGENT_PICK_KEY) || "builtin-general";
  const [presets, modelOptions] = await Promise.all([
    request(`${apiRoot}/presets`),
    request(`${apiRoot}/model-options`),
  ]);
  const enabled = (Array.isArray(presets) ? presets : []).filter(
    (preset) => preset.enabled,
  );
  const preset =
    enabled.find((row) => row.id === picked) ||
    enabled.find((row) => row.id === "builtin-general") ||
    enabled[0];
  const group = (Array.isArray(modelOptions) ? modelOptions : []).find(
    (row) =>
      row.engine === preset?.engine &&
      row.acpCatalogId === preset?.acpCatalogId,
  );
  const defaults = resolveModelDefaults(
    group,
    parseModelDefaults(readModelDefaults()),
    preset,
  );
  return {
    engine: preset?.engine || "harness",
    ...(preset?.acpCatalogId ? { acpCatalogId: preset.acpCatalogId } : {}),
    presetId: preset?.id || "builtin-general",
    modelId: defaults.modelId,
    thinkingEffort: defaults.thinkingEffort,
    ...(defaults.permissionMode
      ? { permissionMode: defaults.permissionMode }
      : {}),
  };
}

export {
  permissionOptions,
  useModelDefaults,
  defaultEffort,
  resolveModelDefaults,
  ModelDefaultsFields,
  personalTaskDefaults,
};
