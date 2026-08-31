import { Message } from "@arco-design/web-react";
import type {
  EngineId,
  EngineStatus,
  PresetDefinition,
  PresetMutation,
  RuntimeMcpServer,
  SkillCatalogEntry,
} from "@workagent/contracts";
import type { Assistant } from "@/common/types/agent/assistantTypes";
import AssistantEditorPage from "@renderer/pages/settings/AssistantSettings/AssistantEditorPage";
import DeleteAssistantModal from "@renderer/pages/settings/AssistantSettings/DeleteAssistantModal";
import AssistantHomeTabs from "@renderer/pages/settings/AssistantSettings/home/AssistantHomeTabs";
import type { AssistantEditorViewModel } from "@renderer/pages/settings/AssistantSettings/types";
import { toLegacyMcpServer } from "../../aion-adapter/ipcBridge.js";
import { useMemo, useState } from "react";

type Port = {
  create(input: PresetMutation): Promise<PresetDefinition>;
  update(id: string, input: Partial<PresetMutation>): Promise<PresetDefinition>;
  copy(id: string, name: string): Promise<PresetDefinition>;
  remove(id: string): Promise<void>;
};

type Props = {
  engines: EngineStatus[];
  port: Port;
  presets: PresetDefinition[];
  skills: SkillCatalogEntry[];
  mcpServers: RuntimeMcpServer[];
  onChange: (presets: PresetDefinition[]) => void;
  onStartChat: (preset: PresetDefinition) => void;
};

const toAssistant = (
  preset: PresetDefinition,
  engines: EngineStatus[],
): Assistant => {
  const status = engines.find((engine) => engine.id === preset.engine);
  return {
    id: preset.id,
    source: preset.source,
    name: preset.name,
    name_i18n: {},
    description: preset.description,
    description_i18n: {},
    avatar: preset.avatar ?? "🤖",
    enabled: preset.enabled,
    sort_order: 0,
    agent_id: preset.engine,
    agent: { type: preset.engine, source: "internal" },
    enabled_skills: preset.skillIds,
    custom_skill_names: [],
    disabled_builtin_skills: [],
    context: preset.systemPrompt,
    context_i18n: {},
    prompts: [],
    prompts_i18n: {},
    models: preset.modelId === null ? [] : [preset.modelId],
    agent_status: status?.state === "ready" ? "online" : "offline",
    team_selectable: false,
    deletable: preset.source === "user",
  };
};

export function AionPresetPage({
  engines,
  port,
  presets,
  skills,
  mcpServers,
  onChange,
  onStartChat,
}: Props) {
  const [message, messageContext] = Message.useMessage({ maxCount: 3 });
  const [editingId, setEditingId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [deleteId, setDeleteId] = useState<string>();
  const active = presets.find((preset) => preset.id === editingId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [avatar, setAvatar] = useState("🤖");
  const [engine, setEngine] = useState<EngineId>("harness");
  const [modelId, setModelId] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [mcpServerIds, setMcpServerIds] = useState<string[]>([]);
  const [promptViewMode, setPromptViewMode] = useState<"edit" | "preview">(
    "edit",
  );
  const assistants = useMemo(
    () => presets.map((preset) => toAssistant(preset, engines)),
    [engines, presets],
  );
  const availableSkills = useMemo(
    () =>
      skills
        .filter((skill) => skill.enabled && skill.health === "ready")
        .map((skill) => ({
          name: skill.name,
          description: skill.description,
          location: skill.relativePath,
          relative_location: skill.relativePath,
          is_auto_inject: false,
          is_custom: skill.source !== "builtin",
          source:
            skill.source === "builtin"
              ? "builtin"
              : skill.source === "market"
                ? "extension"
                : "custom",
        })),
    [skills],
  );
  const skillIdByName = useMemo(
    () => new Map(skills.map((skill) => [skill.name, skill.id])),
    [skills],
  );
  const skillNameById = useMemo(
    () => new Map(skills.map((skill) => [skill.id, skill.name])),
    [skills],
  );

  const begin = (preset?: PresetDefinition) => {
    setCreating(preset === undefined);
    setEditingId(preset?.id);
    setName(preset?.name ?? "");
    setDescription(preset?.description ?? "");
    setAvatar(preset?.avatar ?? "🤖");
    setEngine(preset?.engine ?? "harness");
    setModelId(preset?.modelId ?? "");
    setSystemPrompt(preset?.systemPrompt ?? "");
    setSkillIds(preset?.skillIds ?? []);
    setMcpServerIds(preset?.mcpServerIds ?? []);
  };

  const refreshItem = (preset: PresetDefinition) =>
    onChange([preset, ...presets.filter((item) => item.id !== preset.id)]);

  const save = async () => {
    const input: PresetMutation = {
      name,
      description,
      avatar,
      engine,
      modelId: modelId || null,
      systemPrompt,
      workspacePolicy: "default",
      skillIds,
      mcpServerIds,
      toolAllowlist: [],
      approvalPolicy: "on_risk",
      enabled: active?.enabled ?? true,
    };
    try {
      const saved = creating
        ? await port.create(input)
        : await port.update(editingId!, input);
      refreshItem(saved);
      setEditingId(undefined);
      setCreating(false);
      message.success?.("Assistant saved");
    } catch (error) {
      message.error?.(error instanceof Error ? error.message : "Save failed");
    }
  };

  const editor: AssistantEditorViewModel = {
    isCreating: creating,
    profile: {
      name,
      setName,
      description,
      setDescription,
      avatar,
      setAvatar,
      setAvatarPreview: () => undefined,
      builtinAvatarOptions: [],
    },
    agent: {
      value: engine,
      setValue: (value: string) => setEngine(value as EngineId),
      availableBackends: engines.map((item) => ({
        id: item.id,
        name: item.label,
        runtimeKey: item.id,
        modelOptions:
          modelId === "" ? [] : [{ value: modelId, label: modelId }],
      })),
    },
    prompts: { text: "", setText: () => undefined },
    defaults: {
      model: {
        mode: modelId ? "fixed" : "auto",
        setMode: (mode: "auto" | "fixed") => mode === "auto" && setModelId(""),
        value: modelId,
        setValue: setModelId,
      },
      thoughtLevel: {
        mode: "auto",
        setMode: () => undefined,
        value: "",
        setValue: () => undefined,
      },
      permission: {
        mode: "fixed",
        setMode: () => undefined,
        value: "default",
        setValue: () => undefined,
      },
      skills: { mode: "fixed", setMode: () => undefined },
      mcps: {
        mode: "fixed",
        setMode: () => undefined,
        availableServers: mcpServers.map(toLegacyMcpServer),
        selectedIds: mcpServerIds,
        setSelectedIds: setMcpServerIds,
      },
    },
    rules: {
      content: systemPrompt,
      setContent: setSystemPrompt,
      viewMode: promptViewMode,
      setViewMode: setPromptViewMode,
    },
    skills: {
      availableSkills,
      selectedSkills: skillIds.map((id) => skillNameById.get(id) ?? id),
      setSelectedSkills: (names: string[]) =>
        setSkillIds(names.map((name) => skillIdByName.get(name) ?? name)),
      pendingSkills: [],
      setDeletePendingSkillName: () => undefined,
      setDeleteCustomSkillName: () => undefined,
      builtinAutoSkills: [],
      disabledBuiltinSkills: [],
      setDisabledBuiltinSkills: () => undefined,
    },
    actions: {
      save: () => void save(),
      requestDelete: () => setDeleteId(editingId),
      duplicate: (assistant: Assistant) => {
        void port
          .copy(assistant.id, `${assistant.name} Copy`)
          .then(refreshItem)
          .catch(() => message.error?.("Duplicate failed"));
      },
    },
  };

  const showEditor = creating || active !== undefined;
  return (
    <div className="h-full w-full overflow-hidden bg-bg-0">
      {messageContext}
      {showEditor ? (
        <AssistantEditorPage
          editor={editor}
          activeAssistant={active ? toAssistant(active, engines) : null}
          onBack={() => {
            setEditingId(undefined);
            setCreating(false);
          }}
        />
      ) : (
        <AssistantHomeTabs
          assistants={assistants}
          localeKey="en-US"
          onOpenDetail={(assistant: Assistant) =>
            begin(presets.find((preset) => preset.id === assistant.id))
          }
          onOpenSettings={(assistant: Assistant) =>
            begin(presets.find((preset) => preset.id === assistant.id))
          }
          onDuplicate={(assistant: Assistant) => {
            void port
              .copy(assistant.id, `${assistant.name} Copy`)
              .then(refreshItem)
              .catch(() => message.error?.("Duplicate failed"));
          }}
          onDelete={(assistant: Assistant) => setDeleteId(assistant.id)}
          onCreate={() => begin()}
          onToggleEnabled={(assistant: Assistant, enabled: boolean) => {
            void port
              .update(assistant.id, { enabled })
              .then(refreshItem)
              .catch(() => message.error?.("Update failed"));
          }}
          onReorder={() => undefined}
          onStartChat={(assistant: Assistant) => {
            const preset = presets.find((item) => item.id === assistant.id);
            if (preset !== undefined) onStartChat(preset);
          }}
        />
      )}
      <DeleteAssistantModal
        visible={deleteId !== undefined}
        activeAssistant={
          deleteId
            ? (assistants.find((assistant) => assistant.id === deleteId) ??
              null)
            : null
        }
        onCancel={() => setDeleteId(undefined)}
        onConfirm={() => {
          if (deleteId === undefined) return;
          void port
            .remove(deleteId)
            .then(() => {
              onChange(presets.filter((preset) => preset.id !== deleteId));
              setDeleteId(undefined);
              setEditingId(undefined);
            })
            .catch(() => message.error?.("Delete failed"));
        }}
      />
    </div>
  );
}
