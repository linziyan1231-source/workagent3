import React, { useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Message, Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import AionModal from '@renderer/components/base/AionModal';
import { useConversationAssistants } from '@renderer/pages/conversation/hooks/useConversationAssistants';
import { isSharedAssistant } from './sharedAssistantSelection';
import { ipcBridge } from '@/common';
import { useSharedRuntimeOptions } from '../hooks/useSharedRuntimeOptions';

type Props = {
  visible: boolean;
  projectID: string;
  projectName: string;
  onCancel: () => void;
  onCreated: (id: string) => void;
};

const SharedConversationCreateModal: React.FC<Props> = ({ visible, projectID, projectName, onCancel, onCreated }) => {
  const { t } = useTranslation();
  const { presetAssistants } = useConversationAssistants();
  const [name, setName] = useState('');
  const [assistantID, setAssistantID] = useState<string>();
  const [modelID, setModelID] = useState<string>();
  const [thinkingEffort, setThinkingEffort] = useState<string>();
  const [busy, setBusy] = useState(false);
  const assistants = useMemo(() => presetAssistants.filter(isSharedAssistant), [presetAssistants]);
  const assistant = assistants.find((item) => item.id === assistantID);
  const backend = assistant
    ? ((assistant.agent?.acp_backend || assistant.agent?.type || '').toLowerCase().includes('kimi') ? 'kimi' : 'codex')
    : undefined;
  const { options } = useSharedRuntimeOptions(backend);
  useEffect(() => {
    if (!options) return;
    setModelID(options.default_model_id);
    setThinkingEffort(options.default_thinking_effort);
  }, [assistantID, options]);
  const close = () => {
    setName('');
    setAssistantID(undefined);
    setModelID(undefined);
    setThinkingEffort(undefined);
    onCancel();
  };
  const create = async () => {
    if (!name.trim() || !assistant || !backend || !modelID || !thinkingEffort) return;
    setBusy(true);
    try {
      const result = await ipcBridge.portal.createSharedConversation.invoke({
        project_id: projectID,
        name: name.trim(),
        assistant_id: assistant.id,
        assistant_backend: backend,
        model_id: modelID,
        thinking_effort: thinkingEffort,
      });
      onCreated(`shared:${result.conversation.id}`);
      close();
    } catch {
      Message.error(
        t('team.create.sharedConversationFailed', { defaultValue: 'Shared conversation could not be created' })
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <AionModal
      visible={visible}
      onCancel={close}
      style={{ width: 500 }}
      header={{ title: t('conversation.workspace.createNewConversation') }}
      footer={
        <div className='flex justify-end gap-10px'>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button
            type='primary'
            loading={busy}
            disabled={!name.trim() || !assistantID || !modelID || !thinkingEffort}
            onClick={() => void create()}
          >
            {t('common.create')}
          </Button>
        </div>
      }
    >
      <Form layout='vertical'>
        <Form.Item label={t('team.create.sharedProjectName', { defaultValue: 'Shared project' })}>
          <Input value={projectName} disabled />
        </Form.Item>
        <Form.Item label={t('conversation.history.renamePlaceholder', { defaultValue: 'Conversation name' })} required>
          <Input value={name} onChange={setName} maxLength={128} autoFocus />
        </Form.Item>
        <Form.Item label={t('team.create.fixedAssistant', { defaultValue: 'Assistant' })} required>
          <Select
            value={assistantID}
            onChange={(value) => {
              setAssistantID(value);
              setModelID(undefined);
              setThinkingEffort(undefined);
            }}
          >
            {assistants.map((item) => (
              <Select.Option key={item.id} value={item.id}>
                {item.name}
              </Select.Option>
            ))}
          </Select>
        </Form.Item>
        <Form.Item label={t('common.model', { defaultValue: 'Model' })} required>
          <Select value={modelID} onChange={(value) => { setModelID(value); setThinkingEffort(options?.model_defaults[value] || thinkingEffort); }}>
            {(options?.models ?? []).map((model) => (
              <Select.Option key={model} value={model}>
                {model}
              </Select.Option>
            ))}
          </Select>
        </Form.Item>
        <Form.Item label={t('agent.thoughtLevel.label')} required>
          <Select value={thinkingEffort} onChange={setThinkingEffort}>
            {(options?.thinking_efforts ?? []).map((effort) => (
              <Select.Option key={effort} value={effort}>
                {effort}
              </Select.Option>
            ))}
          </Select>
        </Form.Item>
      </Form>
    </AionModal>
  );
};

export default SharedConversationCreateModal;
