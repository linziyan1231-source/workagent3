import { usePresets } from "./api.js";
import { apiRoot } from "../../platform/api.js";
import { useResource } from "../../platform/resources.js";
import { AssistantAvatar } from "./avatar-components.js";
import { Section, Status } from "../../ui/elements.js";
import {
  displayPresetName,
  displayValue,
  reasoningLabel,
} from "../../ui/labels.js";
import {
  ModelDefaultsFields,
  resolveModelDefaults,
  useModelDefaults,
} from "./model-defaults.js";
import { createElement as h } from "react";

function ModelsSection() {
  const [state] = useResource(`${apiRoot}/model-options`);
  const [presets] = usePresets();
  const [preferences, save] = useModelDefaults();
  const groups = [
    ...presets.rows
      .filter((preset) => preset.source === "user")
      .map((preset) => ({
        preset,
        group: state.rows.find((group) => group.engine === preset.engine) || {
          engine: preset.engine,
          state: "unavailable",
          models: [],
        },
      })),
    ...state.rows.map((group) => ({ group })),
  ];
  return h(
    Section,
    { title: "模型" },
    h(
      "div",
      { className: "workagent-section-intro" },
      h(
        "p",
        null,
        "为各助手设置新对话的默认模型、思考强度和权限。更改自动保存在当前浏览器；输入框的临时选择不会修改默认值。模型列表每次打开网页时自动更新。",
      ),
    ),
    h(Status, { state }),
    presets.loading || presets.error ? h(Status, { state: presets }) : null,
    ...groups.map(({ group, preset }) =>
      h(
        "section",
        {
          key: preset?.id || group.engine,
          className: "workagent-model-group",
          "data-preset-id": preset?.id,
        },
        h(
          "header",
          null,
          h(AssistantAvatar, {
            preset: preset || { engine: group.engine },
          }),
          h(
            "strong",
            null,
            preset
              ? displayPresetName(preset.name)
              : displayValue(group.engine),
          ),
          preset
            ? h(
                "span",
                { className: "workagent-muted" },
                `${displayValue(group.engine)}${preset.enabled ? "" : " · 已关闭"}`,
              )
            : null,
          h(
            "span",
            { className: `workagent-status-pill is-${group.state}` },
            group.state === "ready"
              ? `已获取 ${group.models.length} 个模型`
              : group.state === "empty"
                ? "暂无模型"
                : "暂时无法获取",
          ),
        ),
        h(ModelDefaultsFields, {
          group,
          preset,
          defaults: resolveModelDefaults(group, preferences, preset),
          save,
        }),
        group.state !== "ready"
          ? h(
              "p",
              { className: "workagent-muted" },
              "请检查助手的连接与授权后重新打开网页。",
            )
          : null,
        ...(preset ? [] : group.models).map((model) =>
          h(
            "article",
            { key: model.id, className: "workagent-model-row" },
            h(
              "div",
              null,
              h("strong", null, model.name),
              model.id === resolveModelDefaults(group, preferences).modelId
                ? h("span", { className: "workagent-default-tag" }, "默认")
                : null,
              h("small", null, model.id),
            ),
            h(
              "div",
              { className: "workagent-reasoning-tags" },
              ...(model.reasoning.length
                ? model.reasoning.map((option) =>
                    h("span", { key: option.id }, reasoningLabel(option)),
                  )
                : [h("span", { key: "none" }, "未提供思考选项")]),
            ),
          ),
        ),
      ),
    ),
  );
}

export { ModelsSection };
