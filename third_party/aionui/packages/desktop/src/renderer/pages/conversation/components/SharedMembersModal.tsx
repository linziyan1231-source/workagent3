import React, { useEffect, useState } from 'react';
import { Button, Message, Popconfirm, Select } from '@arco-design/web-react';
import { Close, DeleteOne, Peoples, Transfer } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import AionModal from '@renderer/components/base/AionModal';
import { copyText } from '@renderer/utils/ui/clipboard';
import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import type { PortalSharedMember, PortalSharedUser } from '@/common/adapter/ipcBridge';

type Props = { visible: boolean; projectID: string; role: 'owner' | 'member'; onClose: () => void };

const SharedMembersModal: React.FC<Props> = ({ visible, projectID, role, onClose }) => {
  const { t } = useTranslation();
  const [members, setMembers] = useState<PortalSharedMember[]>([]);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<PortalSharedUser[]>([]);
  const [selected, setSelected] = useState<number>();
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const result = await ipcBridge.portal.listSharedMembers.invoke({ project_id: projectID });
    setMembers(result.members);
  };
  useEffect(() => {
    if (visible) void refresh();
  }, [visible, projectID]);
  useEffect(() => {
    if (!visible || query.trim().length < 1) {
      setOptions([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void ipcBridge.portal.searchSharedUsers.invoke({ q: query.trim() }).then((result) => setOptions(result.users));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, visible]);

  const invite = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await ipcBridge.portal.createSharedInvite.invoke({ project_id: projectID, target_user_id: selected });
      Message.success(t('team.create.inviteSent', { defaultValue: 'Invitation sent' }));
      setSelected(undefined);
      setQuery('');
    } catch (error) {
      if (isBackendHttpError(error) && error.code === 'SHARED_INVITE_ALREADY_PENDING') {
        Message.warning(t('team.create.inviteAlreadyPending', { defaultValue: 'An invitation is already pending' }));
      } else if (isBackendHttpError(error) && error.code === 'SHARED_MEMBER_ALREADY_EXISTS') {
        Message.warning(t('team.create.memberAlreadyExists', { defaultValue: 'This user is already a member' }));
      } else {
        Message.error(t('team.create.inviteFailed', { defaultValue: 'Invitation could not be sent' }));
      }
    } finally {
      setBusy(false);
    }
  };

  const copyInviteLink = async () => {
    setBusy(true);
    try {
      const result = await ipcBridge.portal.createSharedInviteLink.invoke({ project_id: projectID });
      const url = `${window.location.origin}${window.location.pathname}#/shared-invite/${result.token}`;
      await copyText(url);
      Message.success(t('team.create.inviteLinkCopied', { defaultValue: 'Invite link copied' }));
    } catch {
      Message.error(t('team.create.inviteLinkFailed', { defaultValue: 'Invite link could not be created' }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (member: PortalSharedMember) => {
    setBusy(true);
    try {
      await ipcBridge.portal.removeSharedMember.invoke({ project_id: projectID, user_id: member.id });
      await refresh();
      Message.success(t('team.create.memberRemoved', { defaultValue: 'Member access removed' }));
    } catch {
      Message.error(t('team.create.memberRemoveFailed', { defaultValue: 'Member access could not be removed' }));
    } finally {
      setBusy(false);
    }
  };

  const transfer = async (member: PortalSharedMember) => {
    setBusy(true);
    try {
      await ipcBridge.portal.transferSharedProject.invoke({ project_id: projectID, new_owner_user_id: member.id });
      Message.success(t('team.create.ownerTransferred', { defaultValue: 'Ownership transferred' }));
      onClose();
    } catch {
      Message.error(
        t('team.create.ownerTransferFailed', {
          defaultValue: 'Ownership could not be transferred. Check the new owner’s shared-space quota.',
        })
      );
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    setBusy(true);
    try {
      await ipcBridge.portal.leaveSharedProject.invoke({ project_id: projectID });
      ipcBridge.conversation.listChanged.emit({
        conversation_id: `shared-project:${projectID}`,
        action: 'deleted',
        source: 'shared-project-left',
      });
      Message.success(t('team.create.projectLeft', { defaultValue: 'You left the shared project' }));
      onClose();
      window.location.hash = '#/';
    } catch {
      Message.error(t('team.create.projectLeaveFailed', { defaultValue: 'Shared project could not be left' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AionModal
      visible={visible}
      onCancel={onClose}
      style={{ width: 500 }}
      header={{
        render: () => (
          <div className='flex items-center justify-between border-b border-border-2 px-24px py-18px'>
            <div className='flex items-center gap-8px text-16px font-600'>
              <Peoples size='18' />
              {t('team.create.members', { defaultValue: 'Members' })}
            </div>
            <Button type='text' icon={<Close size='18' />} onClick={onClose} />
          </div>
        ),
      }}
      footer={null}
      contentStyle={{ padding: 0 }}
    >
      <div className='px-24px py-20px'>
        {role === 'owner' && (
          <div className='mb-18px flex flex-col gap-8px'>
            <div className='flex gap-8px'>
              <Select
                className='flex-1'
                value={selected}
                onChange={setSelected}
                onSearch={setQuery}
                filterOption={false}
                showSearch
                placeholder={t('team.create.searchMembers', { defaultValue: 'Search name or username' })}
              >
                {options.map((user) => (
                  <Select.Option key={user.id} value={user.id}>
                    {user.display_name} (@{user.username})
                  </Select.Option>
                ))}
              </Select>
              <Button type='primary' disabled={!selected} loading={busy} onClick={() => void invite()}>
                {t('team.create.invite', { defaultValue: 'Invite' })}
              </Button>
            </div>
            <Button long disabled={busy} onClick={() => void copyInviteLink()}>
              {t('team.create.copyInviteLink', { defaultValue: 'Copy invite link' })}
            </Button>
          </div>
        )}
        <div className='flex flex-col gap-6px'>
          {members.map((member) => (
            <div key={member.id} className='flex items-center gap-10px rd-8px px-10px py-8px hover:bg-fill-2'>
              <span className='size-28px rd-full bg-fill-3 flex-center text-12px font-600'>
                {(member.display_name || member.username).slice(0, 1).toUpperCase()}
              </span>
              <div className='min-w-0 flex-1'>
                <div className='truncate text-14px'>{member.display_name}</div>
                <div className='text-11px text-t-tertiary'>@{member.username}</div>
              </div>
              <span className='text-11px text-t-tertiary'>
                {member.role === 'owner'
                  ? t('team.create.owner', { defaultValue: 'Owner' })
                  : t('team.create.member', { defaultValue: 'Member' })}
              </span>
              {role === 'owner' && member.role !== 'owner' && (
                <>
                  <Popconfirm
                    title={t('team.create.transferOwnerConfirm', {
                      defaultValue: 'Transfer ownership to this member?',
                    })}
                    onOk={() => transfer(member)}
                  >
                    <Button type='text' disabled={busy} icon={<Transfer size='14' />} />
                  </Popconfirm>
                  <Button
                    type='text'
                    status='danger'
                    disabled={busy}
                    icon={<DeleteOne size='14' />}
                    onClick={() => void remove(member)}
                  />
                </>
              )}
            </div>
          ))}
        </div>
        {role === 'member' && (
          <div className='mt-18px flex justify-end border-t border-border-2 pt-14px'>
            <Popconfirm
              title={t('team.create.leaveProjectConfirm', { defaultValue: 'Leave this shared project?' })}
              onOk={leave}
            >
              <Button status='danger' loading={busy}>
                {t('team.create.leaveProject', { defaultValue: 'Leave project' })}
              </Button>
            </Popconfirm>
          </div>
        )}
      </div>
    </AionModal>
  );
};

export default SharedMembersModal;
