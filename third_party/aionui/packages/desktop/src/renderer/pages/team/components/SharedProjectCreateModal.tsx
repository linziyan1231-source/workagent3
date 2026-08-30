import React, { useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Message, Select } from '@arco-design/web-react';
import { Close } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import AionModal from '@renderer/components/base/AionModal';
import { useConversationAssistants } from '@renderer/pages/conversation/hooks/useConversationAssistants';
import { isSharedAssistant } from '@renderer/pages/conversation/components/sharedAssistantSelection';
import { useSharedRuntimeOptions } from '@renderer/pages/conversation/hooks/useSharedRuntimeOptions';
import { ipcBridge } from '@/common';
import type { PortalPrivateProject, PortalSharedInvite, PortalSharedUser } from '@/common/adapter/ipcBridge';

type SourceKind = 'new' | 'copy' | 'migrate';

type Props = {
  visible: boolean;
  onClose: () => void;
  onCreated: (conversationID: string) => void;
};

const SharedProjectCreateModal: React.FC<Props> = ({ visible, onClose, onCreated }) => {
  const { t } = useTranslation();
  const { presetAssistants } = useConversationAssistants();
  const [name, setName] = useState('');
  const [sourceKind, setSourceKind] = useState<SourceKind>('new');
  const [sourceProjectID, setSourceProjectID] = useState<string>();
  const [assistantID, setAssistantID] = useState<string>();
  const [modelID, setModelID] = useState<string>();
  const [thinkingEffort, setThinkingEffort] = useState<string>();
  const [projects, setProjects] = useState<PortalPrivateProject[]>([]);
  const [userQuery, setUserQuery] = useState('');
  const [userOptions, setUserOptions] = useState<PortalSharedUser[]>([]);
  const [inviteeIDs, setInviteeIDs] = useState<number[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PortalSharedInvite[]>([]);

  const refreshInvites = () =>
    ipcBridge.portal.listSharedInvites
      .invoke()
      .then((result) => setPendingInvites(result.invites))
      .catch(() => setPendingInvites([]));
  const [loading, setLoading] = useState(false);

  const assistants = useMemo(() => presetAssistants.filter(isSharedAssistant), [presetAssistants]);
  const selectedAssistant = assistants.find((assistant) => assistant.id === assistantID);
  const selectedBackend: 'codex' | 'kimi' | undefined = selectedAssistant
    ? ((selectedAssistant.agent?.acp_backend || selectedAssistant.agent?.type || '').toLowerCase().includes('kimi')
        ? 'kimi'
        : 'codex')
    : undefined;
  const { options: runtimeOptions } = useSharedRuntimeOptions(selectedBackend);

  useEffect(() => {
    if (!runtimeOptions) return;
    setModelID(runtimeOptions.default_model_id);
    setThinkingEffort(runtimeOptions.default_thinking_effort);
  }, [assistantID, runtimeOptions]);

  useEffect(() => {
    if (!visible) return;
    void ipcBridge.portal.listProjects.invoke().then((result) => setProjects(result.projects));
    void refreshInvites();
  }, [visible]);

  const acceptInvite = async (invite: PortalSharedInvite) => {
    setLoading(true);
    try {
      await ipcBridge.portal.acceptSharedInvite.invoke({ invite_id: invite.id });
      const conversations = await ipcBridge.database.getUserConversations.invoke({ limit: 200 });
      const target = conversations.items.find(
        (item) =>
          (item.extra as { shared?: { project_id?: string } } | undefined)?.shared?.project_id === invite.project_id
      );
      Message.success(t('team.create.inviteAccepted', { defaultValue: 'Invitation accepted' }));
      if (target) onCreated(target.id);
      close();
    } catch (error) {
      console.error('Failed to accept shared invitation:', error);
      Message.error(t('team.create.inviteAcceptFailed', { defaultValue: 'Invitation could not be accepted' }));
      void refreshInvites();
    } finally {
      setLoading(false);
    }
  };

  const declineInvite = async (invite: PortalSharedInvite) => {
    try {
      await ipcBridge.portal.declineSharedInvite.invoke({ invite_id: invite.id });
      await refreshInvites();
    } catch (error) {
      console.error('Failed to decline shared invitation:', error);
      Message.error(t('team.create.inviteDeclineFailed', { defaultValue: 'Invitation could not be declined' }));
    }
  };

  useEffect(() => {
    if (!visible || userQuery.trim().length < 1) {
      setUserOptions([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void ipcBridge.portal.searchSharedUsers
        .invoke({ q: userQuery.trim() })
        .then((result) => setUserOptions(result.users))
        .catch(() => setUserOptions([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [userQuery, visible]);

  const reset = () => {
    setName('');
    setSourceKind('new');
    setSourceProjectID(undefined);
    setAssistantID(undefined);
    setModelID(undefined);
    setThinkingEffort(undefined);
    setUserQuery('');
    setUserOptions([]);
    setInviteeIDs([]);
  };
  const close = () => {
    reset();
    onClose();
  };

  const create = async () => {
    if (!name.trim() || !selectedAssistant || !selectedBackend || !modelID || !thinkingEffort || (sourceKind !== 'new' && !sourceProjectID)) return;
    setLoading(true);
    try {
      const projectResult = await ipcBridge.portal.createSharedProject.invoke({
        name: name.trim(),
        source_kind: sourceKind,
        ...(sourceProjectID ? { source_project_id: sourceProjectID } : {}),
      });
      const project = projectResult.project;
      const conversationResult = await ipcBridge.portal.createSharedConversation.invoke({
        project_id: project.id,
        name: name.trim(),
        assistant_id: selectedAssistant.id,
        assistant_backend: selectedBackend,
        model_id: modelID,
        thinking_effort: thinkingEffort,
      });
      const inviteResults = await Promise.allSettled(
        inviteeIDs.map((target_user_id) =>
          ipcBridge.portal.createSharedInvite.invoke({ project_id: project.id, target_user_id })
        )
      );
      if (inviteResults.some((result) => result.status === 'rejected')) {
        Message.warning(
          t('team.create.sharedInvitePartial', {
            defaultValue: 'The project was created, but some invitations failed.',
          })
        );
      } else {
        Message.success(t('team.create.sharedCreated', { defaultValue: 'Shared project created' }));
      }
      onCreated(`shared:${conversationResult.conversation.id}`);
      close();
    } catch (error) {
      console.error('Failed to create shared project:', error);
      Message.error(t('team.create.sharedFailed', { defaultValue: 'Shared project could not be created' }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AionModal
      visible={visible}
      onCancel={close}
      style={{ width: 560 }}
      wrapStyle={{ zIndex: 10000 }}
      maskStyle={{ zIndex: 9999 }}
      contentStyle={{ background: 'var(--dialog-fill-0)', padding: 0, overflow: 'hidden' }}
      header={{
        render: () => (
          <div className='flex items-center justify-between border-b border-border-2 px-24px py-18px'>
            <h3 className='m-0 text-16px font-600 text-t-primary'>
              {t('team.create.userCollaboration', { defaultValue: 'User collaboration' })}
            </h3>
            <Button type='text' icon={<Close size='18' />} onClick={close} />
          </div>
        ),
      }}
      footer={
        <div className='flex justify-end gap-10px border-t border-border-2 px-24px py-16px'>
          <Button onClick={close}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
          <Button
            type='primary'
            loading={loading}
            disabled={!name.trim() || !assistantID || !modelID || !thinkingEffort || (sourceKind !== 'new' && !sourceProjectID)}
            onClick={() => void create()}
          >
            {t('common.create', { defaultValue: 'Create' })}
          </Button>
        </div>
      }
    >
      <Form layout='vertical' className='px-24px py-20px'>
        {pendingInvites.length > 0 && (
          <div className='mb-20px rounded-10px border border-border-2 bg-fill-1 p-14px'>
            <div className='mb-10px text-13px font-600 text-t-primary'>
              {t('team.create.pendingInvites', { defaultValue: 'Pending invitations' })}
            </div>
            <div className='flex flex-col gap-8px'>
              {pendingInvites.map((invite) => (
                <div key={invite.id} className='flex items-center gap-12px rounded-8px bg-bg-2 px-12px py-10px'>
                  <div className='min-w-0 flex-1'>
                    <div className='truncate text-13px font-500 text-t-primary'>{invite.project_name}</div>
                    <div className='truncate text-12px text-t-tertiary'>
                      {t('team.create.invitedBy', { defaultValue: 'Invited by' })}: {invite.inviter_name}
                    </div>
                  </div>
                  <Button size='mini' onClick={() => void declineInvite(invite)}>
                    {t('common.decline', { defaultValue: 'Decline' })}
                  </Button>
                  <Button size='mini' type='primary' loading={loading} onClick={() => void acceptInvite(invite)}>
                    {t('common.accept', { defaultValue: 'Accept' })}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
        <Form.Item label={t('team.create.sharedProjectName', { defaultValue: 'Shared project name' })} required>
          <Input value={name} onChange={setName} maxLength={128} autoFocus />
        </Form.Item>
        <Form.Item label={t('team.create.projectSource', { defaultValue: 'Project source' })} required>
          <Select
            value={sourceKind}
            onChange={(value) => {
              setSourceKind(value as SourceKind);
              setSourceProjectID(undefined);
            }}
          >
            <Select.Option value='new'>
              {t('team.create.emptyProject', { defaultValue: 'New empty project' })}
            </Select.Option>
            <Select.Option value='copy'>
              {t('team.create.copyProject', { defaultValue: 'Copy existing project' })}
            </Select.Option>
            <Select.Option value='migrate'>
              {t('team.create.migrateProject', { defaultValue: 'Migrate existing project' })}
            </Select.Option>
          </Select>
        </Form.Item>
        {sourceKind !== 'new' && (
          <Form.Item label={t('team.create.existingProject', { defaultValue: 'Existing project' })} required>
            <Select value={sourceProjectID} onChange={setSourceProjectID}>
              {projects.map((project) => (
                <Select.Option key={project.project_id} value={project.project_id}>
                  {project.name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
        )}
        <Form.Item label={t('team.create.fixedAssistant', { defaultValue: 'Assistant for this group chat' })} required>
          <Select value={assistantID} onChange={(value) => { setAssistantID(value); setModelID(undefined); setThinkingEffort(undefined); }}>
            {assistants.map((assistant) => (
              <Select.Option key={assistant.id} value={assistant.id}>
                {assistant.name}
              </Select.Option>
            ))}
          </Select>
        </Form.Item>
        <Form.Item label={t('common.model')} required>
          <Select value={modelID} onChange={(value) => { setModelID(value); setThinkingEffort(runtimeOptions?.model_defaults[value] || thinkingEffort); }}>
            {(runtimeOptions?.models ?? []).map((model) => (
              <Select.Option key={model} value={model}>{model}</Select.Option>
            ))}
          </Select>
        </Form.Item>
        <Form.Item label={t('agent.thoughtLevel.label')} required>
          <Select value={thinkingEffort} onChange={setThinkingEffort}>
            {(runtimeOptions?.thinking_efforts ?? []).map((effort) => (
              <Select.Option key={effort} value={effort}>{effort}</Select.Option>
            ))}
          </Select>
        </Form.Item>
        <Form.Item label={t('team.create.inviteMembers', { defaultValue: 'Invite members (optional)' })}>
          <Select
            mode='multiple'
            value={inviteeIDs}
            onChange={(value) => setInviteeIDs(value as number[])}
            onSearch={setUserQuery}
            filterOption={false}
            showSearch
            allowClear
          >
            {userOptions.map((user) => (
              <Select.Option key={user.id} value={user.id}>
                {user.display_name} (@{user.username})
              </Select.Option>
            ))}
          </Select>
        </Form.Item>
      </Form>
    </AionModal>
  );
};

export default SharedProjectCreateModal;
