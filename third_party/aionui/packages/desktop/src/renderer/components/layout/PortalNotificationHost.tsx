/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Modal, Typography } from '@arco-design/web-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { PortalNotification } from '@/common/adapter/ipcBridge';

const SEEN_STORAGE_KEY = 'CLIENTNAME-portal-notification-seen-v1';
const POLL_INTERVAL_MS = 60_000;
const MAX_SEEN_NOTIFICATIONS = 200;

function readSeenNotifications(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(SEEN_STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === 'string').slice(-MAX_SEEN_NOTIFICATIONS)
      : [];
  } catch {
    return [];
  }
}

function writeSeenNotifications(ids: string[]): void {
  try {
    window.localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(ids.slice(-MAX_SEEN_NOTIFICATIONS)));
  } catch {
    // Storage may be unavailable in private or constrained browser contexts.
  }
}

const PortalNotificationHost: React.FC = () => {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<PortalNotification[]>([]);
  const requestInFlight = useRef(false);
  const seen = useRef(new Set(readSeenNotifications()));
  const queuedIDs = useRef(new Set<string>());

  const poll = useCallback(async () => {
    if (requestInFlight.current || document.visibilityState === 'hidden') return;
    requestInFlight.current = true;
    try {
      const feed = await ipcBridge.portal.getNotifications.invoke();
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
        setQueue((current) => [...current, ...fresh]);
      }
    } catch {
      // A source outage must not interrupt normal app use; focus/interval polling retries it.
    } finally {
      requestInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if ((window as { electronAPI?: unknown }).electronAPI) return;
    void poll();
    const timer = window.setInterval((): void => {
      void poll();
    }, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    const onActive = (): void => {
      void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onActive);
    window.addEventListener('online', onActive);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onActive);
      window.removeEventListener('online', onActive);
    };
  }, [poll]);

  const current = queue[0];
  const close = () => {
    if (!current) return;
    seen.current.add(current.id);
    queuedIDs.current.delete(current.id);
    writeSeenNotifications(Array.from(seen.current));
    setQueue((notifications) => notifications.slice(1));
  };

  return (
    <Modal
      visible={Boolean(current)}
      title={current?.title || t('settings.notification')}
      closable={false}
      maskClosable={false}
      footer={
        <Button type='primary' onClick={close}>
          {t('common.confirm')}
        </Button>
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
