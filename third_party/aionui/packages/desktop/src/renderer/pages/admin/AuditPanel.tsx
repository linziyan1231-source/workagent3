import React, { useCallback, useMemo, useState } from 'react';
import { Button, Card, Empty, Input, InputNumber, Message, Space, Table, Tag, Typography } from '@arco-design/web-react';
import type { TableColumnProps } from '@arco-design/web-react';
import { Refresh } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import type { PortalAuditEvent, PortalAuditQuery } from '@/common/adapter/ipcBridge';
import type { AuditFilterForm } from './types';

const INITIAL_FILTERS: AuditFilterForm = {
  actor: '',
  action: '',
  target: '',
  from: '',
  to: '',
  limit: 100,
};

const RESULT_TAG_COLORS: Record<PortalAuditEvent['result'], string> = {
  success: 'green',
  failure: 'red',
  denied: 'orange',
};

const metadataSummary = (metadata?: Record<string, string>): string =>
  metadata ? Object.entries(metadata).map(([key, value]) => `${key}=${value}`).join(', ') : '';

const datetimeInputClass =
  'h-32px w-full box-border rounded-4px border border-solid border-border-2 bg-bg-2 px-8px text-13px text-t-1';

const AuditPanel: React.FC = () => {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<AuditFilterForm>({ ...INITIAL_FILTERS });
  const [events, setEvents] = useState<PortalAuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const buildQuery = useCallback((): PortalAuditQuery => {
    const query: PortalAuditQuery = {};
    const actor = filters.actor.trim();
    const action = filters.action.trim();
    const target = filters.target.trim();
    if (actor) query.actor = actor;
    if (action) query.action = action;
    if (target) query.target = target;
    if (filters.from) query.from = new Date(filters.from).toISOString();
    if (filters.to) query.to = new Date(filters.to).toISOString();
    if (filters.limit) query.limit = filters.limit;
    return query;
  }, [filters]);

  const backendMessage = (error: unknown, fallback: string): string =>
    isBackendHttpError(error) && error.backendMessage.trim() ? error.backendMessage : fallback;

  const runQuery = async () => {
    setLoading(true);
    try {
      const response = await ipcBridge.portal.listAuditEvents.invoke(buildQuery());
      setEvents(response.events ?? []);
    } catch (error) {
      console.error('Failed to load audit events:', error);
      Message.error(backendMessage(error, t('settings.adminAudit.loadFailed')));
    } finally {
      setLoading(false);
    }
  };

  const runExport = async () => {
    setExporting(true);
    try {
      const response = await ipcBridge.portal.exportAuditEvents.invoke(buildQuery());
      Message.success(t('settings.adminAudit.exported', { filename: response.filename }));
    } catch (error) {
      console.error('Failed to export audit events:', error);
      Message.error(backendMessage(error, t('settings.adminAudit.exportFailed')));
    } finally {
      setExporting(false);
    }
  };

  const columns = useMemo<TableColumnProps<PortalAuditEvent>[]>(
    () => [
      {
        key: 'occurredAt',
        title: t('settings.adminAudit.occurredAt'),
        dataIndex: 'occurred_at',
        width: 190,
        render: (value) => new Date(String(value)).toLocaleString(),
      },
      { key: 'actor', title: t('settings.adminAudit.filters.actor'), dataIndex: 'actor', width: 140 },
      { key: 'action', title: t('settings.adminAudit.filters.action'), dataIndex: 'action', width: 200 },
      { key: 'target', title: t('settings.adminAudit.filters.target'), dataIndex: 'target', width: 160 },
      {
        key: 'result',
        title: t('settings.adminAudit.result'),
        dataIndex: 'result',
        width: 100,
        render: (value) => {
          const result = String(value) as PortalAuditEvent['result'];
          const labelKey =
            result === 'success'
              ? 'settings.adminAudit.resultSuccess'
              : result === 'denied'
                ? 'settings.adminAudit.resultDenied'
                : 'settings.adminAudit.resultFailure';
          return <Tag color={RESULT_TAG_COLORS[result] ?? 'gray'}>{t(labelKey)}</Tag>;
        },
      },
      { key: 'correlationId', title: t('settings.adminAudit.correlationId'), dataIndex: 'correlation_id', width: 220 },
      {
        key: 'metadata',
        title: t('settings.adminAudit.metadata'),
        dataIndex: 'metadata',
        render: (value) => (
          <Typography.Text ellipsis={{ showTooltip: true }} type='secondary'>
            {metadataSummary(value as Record<string, string> | undefined)}
          </Typography.Text>
        ),
      },
    ],
    [t]
  );

  return (
    <Card bordered={false} className='rounded-16px mt-20px'>
      <div className='mb-16px flex items-center justify-between gap-12px'>
        <div>
          <Typography.Title heading={6} className='!m-0'>
            {t('settings.adminAudit.title')}
          </Typography.Title>
          <Typography.Text type='secondary'>{t('settings.adminAudit.subtitle')}</Typography.Text>
        </div>
        <Space>
          <Button icon={<Refresh theme='outline' size='14' />} loading={loading} onClick={() => void runQuery()}>
            {t('settings.adminAudit.query')}
          </Button>
          <Button loading={exporting} onClick={() => void runExport()}>
            {t('settings.adminAudit.export')}
          </Button>
        </Space>
      </div>
      <div className='mb-16px grid grid-cols-1 gap-12px md:grid-cols-3'>
        <label className='flex flex-col gap-4px text-13px text-t-2'>
          {t('settings.adminAudit.filters.actor')}
          <Input
            allowClear
            value={filters.actor}
            onChange={(value) => setFilters((current) => ({ ...current, actor: value }))}
          />
        </label>
        <label className='flex flex-col gap-4px text-13px text-t-2'>
          {t('settings.adminAudit.filters.action')}
          <Input
            allowClear
            value={filters.action}
            onChange={(value) => setFilters((current) => ({ ...current, action: value }))}
          />
        </label>
        <label className='flex flex-col gap-4px text-13px text-t-2'>
          {t('settings.adminAudit.filters.target')}
          <Input
            allowClear
            value={filters.target}
            onChange={(value) => setFilters((current) => ({ ...current, target: value }))}
          />
        </label>
        <label className='flex flex-col gap-4px text-13px text-t-2'>
          {t('settings.adminAudit.filters.from')}
          <input
            type='datetime-local'
            className={datetimeInputClass}
            value={filters.from}
            onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))}
          />
        </label>
        <label className='flex flex-col gap-4px text-13px text-t-2'>
          {t('settings.adminAudit.filters.to')}
          <input
            type='datetime-local'
            className={datetimeInputClass}
            value={filters.to}
            onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))}
          />
        </label>
        <label className='flex flex-col gap-4px text-13px text-t-2'>
          {t('settings.adminAudit.filters.limit')}
          <InputNumber
            min={1}
            max={1000}
            precision={0}
            value={filters.limit}
            onChange={(value) =>
              setFilters((current) => ({ ...current, limit: typeof value === 'number' ? value : INITIAL_FILTERS.limit }))
            }
            className='w-full'
          />
        </label>
      </div>
      <Table
        rowKey='id'
        columns={columns}
        data={events}
        loading={loading}
        pagination={false}
        noDataElement={<Empty description={t('settings.adminAudit.empty')} />}
        scroll={{ x: 1200 }}
        tableLayoutFixed
      />
    </Card>
  );
};

export default AuditPanel;
