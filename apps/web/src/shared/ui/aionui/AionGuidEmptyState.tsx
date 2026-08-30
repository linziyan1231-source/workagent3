/**
 * Adapted from AionUi Renderer pages/guid/GuidPage,
 * AssistantSelectionArea and GuidInputCard.
 */
import { Button, Input, Select } from "@arco-design/web-react";
import { ArrowUp, FolderOpen, Plus } from "@icon-park/react";
import type { EngineId, EngineStatus } from "@workagent/contracts";
import type { Assistant } from "@/common/types/agent/assistantTypes";
import AssistantSelectionArea from "@renderer/pages/guid/components/AssistantSelectionArea";
import guidStyles from "@renderer/pages/guid/index.module.css";
import { useState } from "react";

type Props = {
  engine: EngineId;
  engines: EngineStatus[];
  disabled?: boolean;
  onEngineChange: (engine: EngineId) => void;
  onSend: (value: string) => void;
  onAttach: () => void;
};

const promptExamples = [
  "Add a new LLM model and API key, then set it as the default model",
  "Help me configure remote access so I can use WorkAgent from my phone",
  "A conversation is stuck. Help me diagnose what went wrong",
  "Create a new assistant and bind a skill to it",
];

const fallbackEngines: Array<{ id: EngineId; label: string }> = [
  { id: "harness", label: "Personal assistant" },
  { id: "codex", label: "Codex CLI" },
  { id: "kimi", label: "Kimi" },
];

export function AionGuidEmptyState({
  engine,
  engines,
  disabled,
  onEngineChange,
  onSend,
  onAttach,
}: Props) {
  const [input, setInput] = useState("");
  const available = fallbackEngines.map((item) => ({
    ...item,
    status: engines.find((status) => status.id === item.id),
  }));
  const assistants: Assistant[] = available.map(
    ({ id, label, status }, index) => ({
      id,
      source: "generated",
      name: status?.label ?? label,
      name_i18n: {},
      description_i18n: {},
      avatar: "🤖",
      enabled: true,
      sort_order: index,
      agent_id: id,
      agent: { type: id, source: "internal" },
      enabled_skills: [],
      custom_skill_names: [],
      disabled_builtin_skills: [],
      context_i18n: {},
      prompts: [],
      prompts_i18n: {},
      models: [],
      agent_status: status?.state === "ready" ? "online" : "offline",
      team_selectable: false,
      deletable: false,
    }),
  );
  const submit = () => {
    const value = input.trim();
    if (!value || disabled) return;
    setInput("");
    onSend(value);
  };

  return (
    <div className={`${guidStyles.guidContainer} guid-container`}>
      <div className={`${guidStyles.guidLayout} guid-layout`}>
        <div className={`${guidStyles.heroHeader} guid-hero-header`}>
          <h1>Hi, what are we working on today?</h1>
        </div>

        <AssistantSelectionArea
          selectedAssistantId={engine}
          assistants={assistants}
          localeKey="en-US"
          onSelectAssistant={(id) => onEngineChange(id as EngineId)}
        />

        <div className={`${guidStyles.guidInputCardWrap} guid-input-card-wrap`}>
          <div className={`${guidStyles.guidInputInner} guid-input-inner`}>
            <Input.TextArea
              autoFocus
              autoSize={{ minRows: 2, maxRows: 12 }}
              value={input}
              placeholder="Send a message, upload files, open a folder, or create a scheduled task..."
              spellCheck={false}
              onChange={setInput}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <div className={`${guidStyles.actionRow} guid-action-row`}>
              <Button
                type="secondary"
                shape="circle"
                icon={<Plus />}
                aria-label="Attach files"
                onClick={onAttach}
              />
              <div className={`${guidStyles.actionSubmit} guid-action-submit`}>
                <Select
                  value={engine}
                  onChange={(value) => onEngineChange(value as EngineId)}
                  aria-label="Engine"
                  className="guid-model-select"
                >
                  {available.map(({ id, label, status }) => (
                    <Select.Option
                      key={id}
                      value={id}
                      disabled={
                        status?.state === "needs_auth" ||
                        status?.state === "unavailable"
                      }
                    >
                      {status?.label ?? label}
                    </Select.Option>
                  ))}
                </Select>
                <span className="guid-permission">Full auto</span>
                <Button
                  className="send-button-custom"
                  shape="circle"
                  type="primary"
                  icon={<ArrowUp size={17} />}
                  disabled={disabled || !input.trim()}
                  onClick={submit}
                  aria-label="Send"
                />
              </div>
            </div>
          </div>
          <button
            className={`${guidStyles.workspaceFootnote} guid-workspace-footnote`}
            type="button"
            onClick={onAttach}
          >
            <FolderOpen size={14} />
            <span>Work in a project</span>
          </button>
        </div>

        <div className={`${guidStyles.assistantPromptHint} guid-prompts`}>
          <span>Try these instructions</span>
          {promptExamples.map((prompt) => (
            <button key={prompt} type="button" onClick={() => setInput(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
