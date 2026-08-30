import { ConfigProvider, Select } from "@arco-design/web-react";
import type { Assistant } from "@/common/types/agent/assistantTypes";
import AssistantSelectionArea from "@renderer/pages/guid/components/AssistantSelectionArea";
import GuidActionRow from "@renderer/pages/guid/components/GuidActionRow";
import GuidInputCard from "@renderer/pages/guid/components/GuidInputCard";
import { useInputFocusRing } from "@renderer/hooks/chat/useInputFocusRing";
import guidStyles from "@renderer/pages/guid/index.module.css";
import type {
  EngineId,
  EngineStatus,
  PresetDefinition,
} from "@workagent/contracts";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  engine: EngineId;
  engines: EngineStatus[];
  presets: PresetDefinition[];
  presetId: string;
  disabled?: boolean;
  onEngineChange: (engine: EngineId) => void;
  onPresetChange: (preset: PresetDefinition) => void;
  onSend: (value: string) => void;
  onAttach: () => void;
};

const fallbackEngines: Array<{ id: EngineId; label: string }> = [
  { id: "harness", label: "Personal assistant" },
  { id: "codex", label: "Codex CLI" },
  { id: "kimi", label: "Kimi" },
];

/**
 * WorkAgent3 transport adapter around the production Renderer Guid component
 * tree. Only engine discovery and send/create are supplied by WorkAgent3.
 */
export function AionGuidEmptyState({
  engine,
  engines,
  presets,
  presetId,
  disabled,
  onEngineChange,
  onPresetChange,
  onSend,
}: Props) {
  const { t, i18n } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState("");
  const [focused, setFocused] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const { activeBorderColor, inactiveBorderColor, activeShadow } =
    useInputFocusRing();

  const available = useMemo(
    () =>
      fallbackEngines.map((item) => ({
        ...item,
        status: engines.find((status) => status.id === item.id),
      })),
    [engines],
  );
  const assistants: Assistant[] = presets
    .filter((preset) => preset.enabled)
    .map((preset, index) => {
      const status = engines.find((item) => item.id === preset.engine);
      return {
        id: preset.id,
        source: preset.source,
        name: preset.name,
        name_i18n: {},
        description_i18n: {},
        description: preset.description,
        avatar: preset.avatar ?? "🤖",
        enabled:
          status?.state !== "needs_auth" && status?.state !== "unavailable",
        sort_order: index,
        agent_id: preset.engine,
        agent: { type: preset.engine, source: "internal" },
        enabled_skills: preset.skillIds,
        custom_skill_names: [],
        disabled_builtin_skills: [],
        context_i18n: {},
        prompts: [],
        prompts_i18n: {},
        models: [],
        agent_status: status?.state === "ready" ? "online" : "offline",
        team_selectable: false,
        deletable: false,
      };
    });

  const submit = () => {
    const value = input.trim();
    if (!value || disabled) return;
    onSend(value);
    setInput("");
  };

  const modelSelector = (
    <Select
      value={engine}
      onChange={(value) => {
        const next = value as EngineId;
        onEngineChange(next);
      }}
      aria-label="Engine"
      style={{ minWidth: 118 }}
    >
      {available.map(({ id, label, status }) => (
        <Select.Option
          key={id}
          value={id}
          disabled={
            status?.state === "needs_auth" || status?.state === "unavailable"
          }
        >
          {status?.label ?? label}
        </Select.Option>
      ))}
    </Select>
  );

  const actionRow = (
    <GuidActionRow
      files={files}
      onFilesUploaded={(paths: string[]) =>
        setFiles((current) => [...current, ...paths])
      }
      modelSelectorNode={modelSelector}
      modeBackend={engine}
      selectedMode="default"
      dynamicModes={[]}
      onModeSelect={() => undefined}
      allSkills={[]}
      disabledBuiltinSkills={[]}
      enabledSkills={[]}
      onToggleSkill={() => undefined}
      mcpServers={[]}
      selectedMcpServerIds={[]}
      onToggleMcpServer={() => undefined}
      loading={false}
      isButtonDisabled={disabled || input.trim().length === 0}
      onSend={submit}
    />
  );

  return (
    <ConfigProvider
      getPopupContainer={() => containerRef.current ?? document.body}
    >
      <div ref={containerRef} className={guidStyles.guidContainer}>
        <div className={guidStyles.guidLayout}>
          <div className={guidStyles.heroHeader}>
            <p className="text-2xl font-semibold mb-0 text-0 text-center">
              {t("conversation.welcome.title")}
            </p>
          </div>
          <AssistantSelectionArea
            selectedAssistantId={presetId}
            assistants={assistants}
            localeKey={i18n.language}
            onSelectAssistant={(id) => {
              const next = presets.find((preset) => preset.id === id);
              if (next !== undefined) onPresetChange(next);
            }}
          />
          <GuidInputCard
            input={input}
            onInputChange={setInput}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            onPaste={() => undefined}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={t("conversation.welcome.placeholder")}
            isInputActive={focused}
            isFileDragging={false}
            activeBorderColor={activeBorderColor}
            inactiveBorderColor={inactiveBorderColor}
            activeShadow={activeShadow}
            dragHandlers={{}}
            files={files}
            onRemoveFile={(path: string) =>
              setFiles((current) => current.filter((item) => item !== path))
            }
            actionRow={actionRow}
            workspaceDir=""
            onSelectWorkspace={() => undefined}
            onClearWorkspace={() => undefined}
          />
        </div>
      </div>
    </ConfigProvider>
  );
}
