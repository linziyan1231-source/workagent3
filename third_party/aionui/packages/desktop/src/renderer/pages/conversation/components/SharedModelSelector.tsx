import React, { useEffect, useState } from 'react';
import { Dropdown, Menu, Message } from '@arco-design/web-react';
import { Brain, Down } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import RuntimeSelectorPill from '@/renderer/components/agent/RuntimeSelectorPill';
import { useSharedRuntimeOptions } from '../hooks/useSharedRuntimeOptions';

type Props = {
  conversationID: string;
  backend: 'codex' | 'kimi';
  initialModelID: string;
  initialThinkingEffort: string;
  running: boolean;
};

const SharedModelSelector: React.FC<Props> = ({
  conversationID,
  backend,
  initialModelID,
  initialThinkingEffort,
  running,
}) => {
  const { t } = useTranslation();
  const { options } = useSharedRuntimeOptions(backend);
  const [modelID, setModelID] = useState(initialModelID);
  const [thinkingEffort, setThinkingEffort] = useState(initialThinkingEffort);
  const [busy, setBusy] = useState(false);

  useEffect(() => setModelID(initialModelID), [initialModelID]);
  useEffect(() => setThinkingEffort(initialThinkingEffort), [initialThinkingEffort]);

  const select = async (nextModel: string, nextEffort: string) => {
    if ((nextModel === modelID && nextEffort === thinkingEffort) || busy || running) return;
    setBusy(true);
    try {
      const result = await ipcBridge.portal.updateSharedConversationModel.invoke({
        conversation_id: conversationID.replace(/^shared:/, ''),
        model_id: nextModel,
        thinking_effort: nextEffort,
      });
      setModelID(result.conversation.model_id);
      setThinkingEffort(result.conversation.thinking_effort);
      Message.success(t('agent.model.switchSuccess'));
    } catch {
      Message.error(t('agent.config.failed'));
    } finally {
      setBusy(false);
    }
  };

  const selectable = Boolean(options && !running);
  const pill = (
    <RuntimeSelectorPill
      className='sendbox-model-btn header-model-btn agent-mode-compact-pill'
      label={`${modelID} · ${thinkingEffort}`}
      leading={<Brain theme='outline' size='14' />}
      trailing={selectable ? <Down size='12' /> : undefined}
      loading={busy}
      style={{ cursor: selectable ? 'pointer' : 'default' }}
    />
  );
  if (!options || running) return pill;
  return (
    <Dropdown
      trigger='click'
      droplist={
        <Menu>
          <Menu.ItemGroup title={t('common.model')}>
            {options.models.map((model) => (
              <Menu.Item key={`model:${model}`} onClick={() => void select(model, options.model_defaults[model] || thinkingEffort)}>
                {model === modelID ? `✓ ${model}` : model}
              </Menu.Item>
            ))}
          </Menu.ItemGroup>
          <Menu.ItemGroup title={t('agent.thoughtLevel.label')}>
            {options.thinking_efforts.map((effort) => (
              <Menu.Item key={`effort:${effort}`} onClick={() => void select(modelID, effort)}>
                {effort === thinkingEffort ? `✓ ${effort}` : effort}
              </Menu.Item>
            ))}
          </Menu.ItemGroup>
        </Menu>
      }
    >
      {pill}
    </Dropdown>
  );
};

export default SharedModelSelector;
