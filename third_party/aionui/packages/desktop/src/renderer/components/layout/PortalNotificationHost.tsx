/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Modal, Typography } from '@arco-design/web-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { PortalNotification, PortalNotificationFeed } from '@/common/adapter/ipcBridge';

const PortalNotificationHost: React.FC = () => {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<PortalNotification[]>([]);
  const seen = useRef(new Set<string>());
  const queuedIDs = useRef(new Set<string>());

  const handleFeed = useCallback((feed: PortalNotificationFeed) => {
    const live = new Set((feed.notifications ?? []).map((notification) => notification.id));
    const fresh = (feed.notifications ?? []).filter(
      (notification) =>
        typeof notification.id === 'string' &&
        notification.id.length > 0 &&
        typeof notification.message === 'string' &&
        notification.message.trim().length > 0 &&
        !seen.current.has(notification.id) &&
        !queuedIDs.current.has(notification.id)
    );
    if (fresh.length > 0) {
      fresh.forEach((notification) => queuedIDs.current.add(notification.id));
    }
    // Drop queued items another session already acknowledged, then append fresh ones.
    setQueue((current) => [...current.filter((notification) => live.has(notification.id)), ...fresh]);
  }, []);

  useEffect(() => {
    if ((window as { electronAPI?: unknown }).electronAPI) return;
    return ipcBridge.portal.notificationsStream.on(handleFeed);
  }, [handleFeed]);

  const current = queue[0];
  // Closing always persists the acknowledgement so a refresh never re-shows
  // the notification. When the call fails the id is un-seen and the next feed
  // event re-queues it.
  const acknowledge = (notification: PortalNotification) => {
    seen.current.add(notification.id);
    queuedIDs.current.delete(notification.id);
    setQueue((notifications) => notifications.slice(1));
    void ipcBridge.portal.acknowledgeNotification.invoke({ id: notification.id }).catch(() => {
      seen.current.delete(notification.id);
    });
  };
  const view = (notification: PortalNotification) => {
    if (notification.deep_link) {
      window.location.hash = `#${notification.deep_link}`;
    }
    acknowledge(notification);
  };

  return (
    <Modal
      visible={Boolean(current)}
      title={current?.title || t('settings.notification')}
      closable={false}
      maskClosable={false}
      footer={
        <>
          {current?.deep_link ? (
            <Button onClick={() => view(current)}>{t('common.view', { defaultValue: 'View' })}</Button>
          ) : null}
          <Button type='primary' onClick={() => current && acknowledge(current)}>
            {t('common.confirm')}
          </Button>
        </>
      }
      unmountOnExit
    >
      <Typography.Paragraph className='mb-0 whitespace-pre-wrap break-words text-t-primary'>
        {current?.message}
      </Typography.Paragraph>
    </Modal>
  );
};

export default PortalNotificationHost;
