import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Message, Popover, Spin } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ipcBridge } from '@/common';
import type { PortalSharedInvite } from '@/common/adapter/ipcBridge';
import { emitter } from '@/renderer/utils/emitter';

const BellIcon: React.FC<{ size: number }> = ({ size }) => (
  <svg
    width={size}
    height={size}
    viewBox='0 0 48 48'
    fill='none'
    stroke='currentColor'
    strokeWidth='4'
    strokeLinecap='round'
    strokeLinejoin='round'
    aria-hidden='true'
  >
    <path d='M10 34h28l-4-6V19c0-6-4-11-10-11s-10 5-10 11v9l-4 6Z' />
    <path d='M20 39c1 2 2 3 4 3s3-1 4-3' />
  </svg>
);

type Props = { enabled: boolean; iconSize: number; mobile?: boolean };

const EnabledSharedInviteNotifications: React.FC<Omit<Props, 'enabled'>> = ({ iconSize, mobile }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [invites, setInvites] = useState<PortalSharedInvite[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const refreshSequence = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const result = await ipcBridge.portal.listSharedInvites.invoke();
      if (sequence === refreshSequence.current) setInvites(result.invites);
    } catch {
      // Preserve the last confirmed badge during a transient network failure.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval((): void => {
      void refresh();
    }, 30_000);
    const handleFocus = (): void => {
      void refresh();
    };
    window.addEventListener('focus', handleFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
    };
  }, [refresh]);

  // Deep-link entry: a shared_invite notification links to
  // `/guid?open=shared-invites`; open the popover once and consume the param.
  useEffect(() => {
    if (searchParams.get('open') !== 'shared-invites') return;
    setOpen(true);
    void refresh();
    const next = new URLSearchParams(searchParams);
    next.delete('open');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, refresh]);

  const accept = async (invite: PortalSharedInvite) => {
    setLoading(true);
    try {
      await ipcBridge.portal.acceptSharedInvite.invoke({ invite_id: invite.id });
      Message.success(t('team.create.inviteAccepted'));
      await refresh();
      emitter.emit('chat.history.refresh');
      setOpen(false);
      try {
        const conversations = await ipcBridge.database.getUserConversations.invoke({ limit: 200 });
        const target = conversations.items.find(
          (item) =>
            (item.extra as { shared?: { project_id?: string } } | undefined)?.shared?.project_id === invite.project_id
        );
        if (target) void navigate(`/conversation/${target.id}`);
      } catch (error) {
        console.warn('Invitation accepted, but its conversation could not be opened:', error);
      }
    } catch (error) {
      console.error('Failed to accept shared invitation:', error);
      Message.error(t('team.create.inviteAcceptFailed'));
      await refresh();
    } finally {
      setLoading(false);
    }
  };

  const decline = async (invite: PortalSharedInvite) => {
    setLoading(true);
    try {
      await ipcBridge.portal.declineSharedInvite.invoke({ invite_id: invite.id });
      await refresh();
    } catch (error) {
      console.error('Failed to decline shared invitation:', error);
      Message.error(t('team.create.inviteDeclineFailed'));
    } finally {
      setLoading(false);
    }
  };

  const content = (
    <div className='w-320px max-w-[calc(100vw-32px)] max-h-[calc(100vh-80px)] overflow-y-auto p-4px'>
      <div className='font-600 text-14px mb-10px'>
        {t('team.create.notifications', { defaultValue: 'Notifications' })}
      </div>
      <Spin loading={loading} className='w-full'>
        {invites.length === 0 ? (
          <div className='py-18px text-center text-13px text-t-secondary'>
            {t('team.create.noNotifications', { defaultValue: 'No new notifications' })}
          </div>
        ) : (
          <div className='flex flex-col gap-10px'>
            {invites.map((invite) => (
              <div key={invite.id} className='rounded-8px border border-solid border-2 p-10px'>
                <div className='font-500 text-14px'>{invite.project_name}</div>
                <div className='text-12px text-t-secondary mt-4px'>
                  {t('team.create.inviteNotification', {
                    defaultValue: '{{name}} invited you to join this shared project',
                    name: invite.inviter_name,
                  })}
                </div>
                <div className='flex justify-end gap-8px mt-10px'>
                  <Button size='mini' disabled={loading} onClick={() => void decline(invite)}>
                    {t('team.create.decline', { defaultValue: 'Decline' })}
                  </Button>
                  <Button type='primary' size='mini' disabled={loading} onClick={() => void accept(invite)}>
                    {t('team.create.accept', { defaultValue: 'Accept' })}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Spin>
    </div>
  );

  const tooltip = t('team.create.notifications', { defaultValue: 'Notifications' });
  return (
    <Popover trigger='click' position='br' content={content} popupVisible={open} onVisibleChange={setOpen}>
      <Button
        type='text'
        className={`app-titlebar__button${mobile ? ' app-titlebar__button--mobile' : ''} relative`}
        aria-label={tooltip}
        title={tooltip}
        onClick={() => {
          if (!open) void refresh();
        }}
      >
        <BellIcon size={iconSize} />
        {invites.length > 0 && (
          <span className='absolute top-1px right-1px min-w-14px h-14px px-3px rounded-full bg-danger text-white text-9px leading-14px text-center'>
            {invites.length > 9 ? '9+' : invites.length}
          </span>
        )}
      </Button>
    </Popover>
  );
};

const SharedInviteNotifications: React.FC<Props> = ({ enabled, ...props }) => {
  if (!enabled) return null;
  return <EnabledSharedInviteNotifications {...props} />;
};

export default SharedInviteNotifications;
