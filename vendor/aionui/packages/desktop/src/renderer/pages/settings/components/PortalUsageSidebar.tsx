/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Spin } from '@arco-design/web-react';
import { Refresh } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { PortalUsageSummary, PortalUsageWindow } from '@/common/adapter/ipcBridge';
import type { PortalUsageCountWindow } from '@/common/adapter/ipcBridge';

type Status = 'loading' | 'success' | 'error' | 'empty';

function remainingPercent(window: PortalUsageWindow): number {
  const limit = Number(window.limit_usd);
  const remaining = Number(window.remaining_usd);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return 0;
  return Math.min(100, Math.max(0, Math.round((remaining / limit) * 100)));
}

function remainingCount(window: PortalUsageCountWindow): number {
  if (!Number.isFinite(window.limit) || window.limit <= 0 || !Number.isFinite(window.used)) return 0;
  const limit = Math.floor(window.limit);
  const used = Math.max(0, Math.floor(window.used));
  return Math.min(limit, Math.max(0, limit - used));
}

function formatGiB(bytes: number, locale: string): string {
  const gibibytes = Number.isFinite(bytes) && bytes > 0 ? bytes / 1024 ** 3 : 0;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(gibibytes);
}

const PortalUsageSidebar: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<Status>('loading');
  const [usage, setUsage] = useState<PortalUsageSummary | null>(null);
  const requestInFlight = useRef(false);
  const initialLoadStarted = useRef(false);

  const load = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setStatus('loading');
    try {
      const result = await ipcBridge.portal.getMyUsage.invoke();
      const providers = result.providers.filter((provider) => provider.kind === 'chatgpt' || provider.kind === 'kimi');
      const storage = result.storage?.personal && result.storage?.shared ? result.storage : undefined;
      setUsage({ as_of: result.as_of, providers, storage });
      setStatus(providers.length > 0 ? 'success' : 'empty');
    } catch {
      setUsage(null);
      setStatus('error');
    } finally {
      requestInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void load();
  }, [load]);

  const formatReset = (value: string) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return t('settings.portalUsage.unknownTime');
    return new Intl.DateTimeFormat(i18n.language, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  };

  return (
    <section className='mt-12px mx-8px pt-12px border-t border-border-1' aria-label={t('settings.portalUsage.title')}>
      <div className='flex items-center justify-between px-2px mb-8px'>
        <span className='text-12px font-600 text-t-secondary'>{t('settings.portalUsage.title')}</span>
        <Button
          type='text'
          size='mini'
          shape='circle'
          icon={<Refresh theme='outline' size='13' />}
          loading={status === 'loading'}
          disabled={status === 'loading'}
          aria-label={t('common.refresh')}
          onClick={() => void load()}
        />
      </div>

      {status === 'loading' && (
        <div className='h-44px flex items-center justify-center text-t-tertiary' role='status'>
          <Spin size={14} />
        </div>
      )}

      {(status === 'error' || status === 'empty') && (
        <button
          type='button'
          className='w-full border-0 bg-transparent text-left px-2px py-8px text-11px text-t-tertiary cursor-pointer'
          onClick={() => void load()}
        >
          {status === 'error' ? t('settings.portalUsage.loadFailed') : t('settings.portalUsage.empty')}
        </button>
      )}

      {status === 'success' && usage && (
        <div className='flex flex-col gap-10px'>
          {usage.providers.map((provider) => (
            <div key={provider.kind} className='px-2px'>
              <div className='text-12px font-600 text-t-primary mb-5px'>
                {provider.kind === 'chatgpt'
                  ? t('settings.portalUsage.providers.chatgpt')
                  : t('settings.portalUsage.providers.kimi')}
              </div>
              {[
                { label: t('settings.portalUsage.dailyWindow'), window: provider.daily },
                { label: t('settings.portalUsage.weeklyWindow'), window: provider.weekly },
              ].map((item) => (
                <div key={item.label} className='flex items-start justify-between gap-6px text-11px lh-17px'>
                  <span className='text-t-secondary whitespace-nowrap'>
                    {item.label} {t('settings.portalUsage.remaining')} {remainingPercent(item.window)}%
                  </span>
                  <span className='text-t-tertiary text-right'>
                    {formatReset(item.window.reset_at)} {t('common.refresh')}
                  </span>
                </div>
              ))}
              {provider.kind === 'chatgpt' && provider.pro && (
                <div className='flex items-start justify-between gap-6px text-11px lh-17px'>
                  <span className='text-t-secondary whitespace-nowrap'>
                    {t('settings.portalUsage.proWindow')} {t('settings.portalUsage.remaining')}{' '}
                    {remainingCount(provider.pro)} {t('settings.portalUsage.timesUnit')}
                  </span>
                  <span className='text-t-tertiary text-right'>
                    {formatReset(provider.pro.reset_at)} {t('common.refresh')}
                  </span>
                </div>
              )}
            </div>
          ))}
          <div className='mx-2px pt-8px border-t border-border-1 flex flex-col gap-4px text-11px lh-17px'>
            {usage.storage ? (
              <>
                {[
                  { label: t('settings.portalUsage.personalStorage'), value: usage.storage.personal },
                  { label: t('settings.portalUsage.sharedStorage'), value: usage.storage.shared },
                ].map((item) => (
                  <div key={item.label} className='flex items-start justify-between gap-6px'>
                    <span className='text-t-secondary whitespace-nowrap'>{item.label}</span>
                    <span className='text-t-tertiary text-right'>
                      {t('settings.portalUsage.remaining')} {formatGiB(item.value.remaining_bytes, i18n.language)} GiB /{' '}
                      {formatGiB(item.value.limit_bytes, i18n.language)} GiB
                    </span>
                  </div>
                ))}
                {usage.storage.shared.remaining_bytes <= usage.storage.shared.limit_bytes * 0.1 && (
                  <div className='text-warning-6'>{t('settings.portalUsage.sharedStorageNearLimit')}</div>
                )}
              </>
            ) : (
              <span className='text-t-tertiary'>{t('settings.portalUsage.storageUnavailable')}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
};

export default PortalUsageSidebar;
