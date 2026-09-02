import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Input, Message, Select, Space, Table, Tag, Typography } from '@arco-design/web-react';
import type { TableColumnProps } from '@arco-design/web-react';
import { Refresh } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import type { PortalMigrationItem, PortalMigrationQuery } from '@/common/adapter/ipcBridge';
import type { MigrationFilterForm } from './types';

const STATUS_TAG_COLORS: Record<PortalMigrationItem['status'], string> = {
  needs_auth: 'orange',
  needs_review: 'red',
};

const JOB_POLL_INTERVAL_MS = 1000;
const JOB_POLL_TIMEOUT_MS = 120_000;

const MigrationPanel: React.FC = () => {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<MigrationFilterForm>({ sid: '', status: '' });
  const [items, setItems] = useState<PortalMigrationItem[]>([]);
  const [unreachableSids, setUnreachableSids] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingJobs, setPendingJobs] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string>('');

  const backendMessage = (error: unknown, fallback: string): string =>
    isBackendHttpError(error) && error.backendMessage.trim() ? error.backendMessage : fallback;

  const runQuery = async () => {
    setLoading(true);
    try {
      const query: PortalMigrationQuery = {};
      const sid = filters.sid.trim();
      if (sid) query.sid = sid;
      if (filters.status) query.status = filters.status;
      const response = await ipcBridge.portal.listMigrations.invoke(query);
      setItems(response.items ?? []);
      setUnreachableSids(response.unreachable_sids ?? []);
    } catch (error) {
      console.error('Failed to load migration items:', error);
      Message.error(backendMessage(error, t('settings.adminMigration.loadFailed')));
    } finally {
      setLoading(false);
    }
  };

  const pollJob = useCallback(
    (jobID: string, itemID: string) => {
      const started = Date.now();
      const tick = async () => {
        try {
          const response = await ipcBridge.portal.getMigrationJob.invoke({ id: jobID });
          const job = response.job;
          if (!job || job.status === 'running') {
            if (Date.now() - started < JOB_POLL_TIMEOUT_MS) {
              setTimeout(() => void tick(), JOB_POLL_INTERVAL_MS);
            }
            return;
          }
          setPendingJobs((current) => {
            const next = { ...current };
            delete next[itemID];
            return next;
          });
          if (job.status === 'succeeded') {
            Message.success(t('settings.adminMigration.retrySucceeded'));
            void runQuery();
          } else {
            Message.error(job.error_code || t('settings.adminMigration.retryFailed'));
          }
        } catch (error) {
          console.error('Failed to poll migration job:', error);
          setPendingJobs((current) => {
            const next = { ...current };
            delete next[itemID];
            return next;
          });
          Message.error(backendMessage(error, t('settings.adminMigration.retryFailed')));
        }
      };
      void tick();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t]
  );

  const runRetry = async (item: PortalMigrationItem) => {
    setActing(item.id);
    try {
      const response = await ipcBridge.portal.retryMigration.invoke({ id: item.id });
      if (response.job?.id) {
        setPendingJobs((current) => ({ ...current, [item.id]: response.job.id }));
        pollJob(response.job.id, item.id);
        Message.success(t('settings.adminMigration.retryStarted'));
      }
    } catch (error) {
      console.error('Failed to start migration retry:', error);
      Message.error(backendMessage(error, t('settings.adminMigration.actionFailed')));
    } finally {
      setActing('');
    }
  };

  const runResolve = async (item: PortalMigrationItem) => {
    setActing(item.id);
    try {
      await ipcBridge.portal.resolveMigration.invoke({ id: item.id });
      Message.success(t('settings.adminMigration.resolveSucceeded'));
      void runQuery();
    } catch (error) {
      console.error('Failed to resolve migration item:', error);
      Message.error(backendMessage(error, t('settings.adminMigration.actionFailed')));
    } finally {
      setActing('');
    }
  };

  const runReauthorize = async (item: PortalMigrationItem) => {
    setActing(item.id);
    try {
      await ipcBridge.portal.reauthorizeMigration.invoke({ id: item.id });
      Message.success(t('settings.adminMigration.reauthorizeSucceeded'));
    } catch (error) {
      console.error('Failed to request migration re-authorization:', error);
      Message.error(backendMessage(error, t('settings.adminMigration.actionFailed')));
    } finally {
      setActing('');
    }
  };

  useEffect(() => {
    void runQuery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns = useMemo<TableColumnProps<PortalMigrationItem>[]>(
    () => [
      { key: 'username', title: t('settings.adminMigration.username'), dataIndex: 'username', width: 120 },
      {
        key: 'sid',
        title: t('settings.adminMigration.filters.sid'),
        dataIndex: 'sid',
        width: 200,
        render: (value) => (
          <Typography.Text ellipsis={{ showTooltip: true }} type='secondary'>
            {String(value)}
          </Typography.Text>
        ),
      },
      { key: 'kind', title: t('settings.adminMigration.kind'), dataIndex: 'kind', width: 130 },
      {
        key: 'sourceId',
        title: t('settings.adminMigration.sourceId'),
        dataIndex: 'source_id',
        width: 220,
        render: (value) => (
          <Typography.Text ellipsis={{ showTooltip: true }}>{String(value)}</Typography.Text>
        ),
      },
      {
        key: 'status',
        title: t('settings.adminMigration.status'),
        dataIndex: 'status',
        width: 120,
        render: (value) => {
          const status = String(value) as PortalMigrationItem['status'];
          const labelKey =
            status === 'needs_auth' ? 'settings.adminMigration.statusNeedsAuth' : 'settings.adminMigration.statusNeedsReview';
          return <Tag color={STATUS_TAG_COLORS[status] ?? 'gray'}>{t(labelKey)}</Tag>;
        },
      },
      {
        key: 'reason',
        title: t('settings.adminMigration.reason'),
        dataIndex: 'reason',
        render: (value) => (
          <Typography.Text ellipsis={{ showTooltip: true }} type='secondary'>
            {String(value ?? '')}
          </Typography.Text>
        ),
      },
      {
        key: 'actions',
        title: t('settings.adminMigration.actions'),
        width: 260,
        render: (_, item) => (
          <Space>
            <Button
              size='small'
              loading={acting === item.id || pendingJobs[item.id] !== undefined}
              onClick={() => void runRetry(item)}
            >
              {t('settings.adminMigration.retry')}
            </Button>
            <Button size='small' loading={acting === item.id} onClick={() => void runResolve(item)}>
              {t('settings.adminMigration.resolve')}
            </Button>
            {item.status === 'needs_auth' && (
              <Button size='small' loading={acting === item.id} onClick={() => void runReauthorize(item)}>
                {t('settings.adminMigration.reauthorize')}
              </Button>
            )}
          </Space>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, acting, pendingJobs]
  );

  return (
    <Card bordered={false} className='rounded-16px mt-20px'>
      <div className='mb-16px flex items-center justify-between gap-12px'>
        <div>
          <Typography.Title heading={6} className='!m-0'>
            {t('settings.adminMigration.title')}
          </Typography.Title>
          <Typography.Text type='secondary'>{t('settings.adminMigration.subtitle')}</Typography.Text>
        </div>
        <Button icon={<Refresh theme='outline' size='14' />} loading={loading} onClick={() => void runQuery()}>
          {t('settings.adminMigration.query')}
        </Button>
      </div>
      <div className='mb-16px grid grid-cols-1 gap-12px md:grid-cols-3'>
        <label className='flex flex-col gap-4px text-13px text-t-2'>
          {t('settings.adminMigration.filters.sid')}
          <Input
            allowClear
            value={filters.sid}
            onChange={(value) => setFilters((current) => ({ ...current, sid: value }))}
          />
        </label>
        <label className='flex flex-col gap-4px text-13px text-t-2'>
          {t('settings.adminMigration.filters.status')}
          <Select
            value={filters.status}
            onChange={(value) => setFilters((current) => ({ ...current, status: value as MigrationFilterForm['status'] }))}
          >
            <Select.Option value=''>{t('settings.adminMigration.statusAll')}</Select.Option>
            <Select.Option value='needs_auth'>{t('settings.adminMigration.statusNeedsAuth')}</Select.Option>
            <Select.Option value='needs_review'>{t('settings.adminMigration.statusNeedsReview')}</Select.Option>
          </Select>
        </label>
      </div>
      {unreachableSids.length > 0 && (
        <div className='mb-12px'>
          <Typography.Text type='warning'>
            {t('settings.adminMigration.unreachableRuntimes', { count: unreachableSids.length })}
          </Typography.Text>
        </div>
      )}
      <Table
        rowKey='id'
        columns={columns}
        data={items}
        loading={loading}
        pagination={false}
        noDataElement={<Empty description={t('settings.adminMigration.empty')} />}
        scroll={{ x: 1200 }}
        tableLayoutFixed
      />
    </Card>
  );
};

export default MigrationPanel;
