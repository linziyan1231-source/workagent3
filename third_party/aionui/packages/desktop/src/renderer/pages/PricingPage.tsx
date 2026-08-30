/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Table, Tag, Typography } from '@arco-design/web-react';
import type { TableColumnProps } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

type ModelPricing = {
  alias: string;
  target?: string;
  input: string;
  output: string;
  cacheRead: string;
};

const CHATGPT_PRICING: ModelPricing[] = [
  { alias: 'codex-auto-review', input: '1.75', output: '14', cacheRead: '0.175' },
  { alias: 'gpt-5.3-codex-spark', input: '1.75', output: '14', cacheRead: '0.175' },
  { alias: 'gpt-5.4', input: '2.5', output: '15', cacheRead: '0.25' },
  { alias: 'gpt-5.4-mini', input: '0.75', output: '4.5', cacheRead: '0.075' },
  { alias: 'gpt-5.5', input: '5', output: '30', cacheRead: '0.5' },
  { alias: 'gpt-5.6-luna', input: '1', output: '6', cacheRead: '0.1' },
  { alias: 'gpt-5.6-sol', input: '5', output: '30', cacheRead: '0.5' },
  { alias: 'gpt-5.6-terra', input: '2.5', output: '15', cacheRead: '0.25' },
];

const KIMI_PRICING: ModelPricing[] = [
  {
    alias: 'kimi-for-coding',
    target: 'kimi-k2.7-code',
    input: '0.95',
    output: '4',
    cacheRead: '0.19',
  },
  { alias: 'kimi-k2.5', input: '0.6', output: '3', cacheRead: '0.1' },
  { alias: 'kimi-k2.6', input: '0.95', output: '4', cacheRead: '0.16' },
  { alias: 'kimi-k2.7', target: 'kimi-k2.7-code', input: '0.95', output: '4', cacheRead: '0.19' },
  { alias: 'kimi-k2.7-code', input: '0.95', output: '4', cacheRead: '0.19' },
  { alias: 'kimi-k2.7-code-highspeed', input: '1.9', output: '8', cacheRead: '0.38' },
  { alias: 'kimi-k3', input: '3', output: '15', cacheRead: '0.3' },
];

const PricingPage: React.FC = () => {
  const { t } = useTranslation();
  const columns: TableColumnProps<ModelPricing>[] = [
    {
      title: t('settings.pricing.columns.alias'),
      dataIndex: 'alias',
      width: 220,
      render: (alias: string) => <span className='font-600 text-t-primary'>{alias}</span>,
    },
    {
      title: t('settings.pricing.columns.target'),
      dataIndex: 'target',
      width: 180,
      render: (target: string | undefined) => <span className='text-t-secondary'>{target ?? '—'}</span>,
    },
    {
      title: t('settings.pricing.columns.input'),
      dataIndex: 'input',
      width: 150,
      render: (amount: string) => t('settings.pricing.usdPerMillion', { amount }),
    },
    {
      title: t('settings.pricing.columns.output'),
      dataIndex: 'output',
      width: 150,
      render: (amount: string) => t('settings.pricing.usdPerMillion', { amount }),
    },
    {
      title: t('settings.pricing.columns.cacheRead'),
      dataIndex: 'cacheRead',
      width: 170,
      render: (amount: string) => t('settings.pricing.usdPerMillion', { amount }),
    },
  ];

  const groups = [
    {
      key: 'chatgpt',
      label: t('settings.pricing.providers.chatgpt'),
      rows: CHATGPT_PRICING,
    },
    {
      key: 'kimi',
      label: t('settings.pricing.providers.kimi'),
      rows: KIMI_PRICING,
    },
  ];

  return (
    <main className='w-full min-h-full box-border overflow-y-auto px-16px py-20px md:px-40px md:py-32px'>
      <div className='mx-auto w-full max-w-1100px'>
        <header className='mb-24px'>
          <Typography.Title heading={3} className='m-0 text-t-primary'>
            {t('settings.pricing.title')}
          </Typography.Title>
          <Typography.Paragraph className='mt-8px mb-0 text-t-secondary'>
            {t('settings.pricing.description')}
          </Typography.Paragraph>
          <div className='mt-12px border border-border-1 bg-fill-1 rd-10px px-12px py-10px text-12px text-t-secondary leading-relaxed'>
            <div>{t('settings.pricing.unitNote')}</div>
            <div>{t('settings.pricing.billingNote')}</div>
          </div>
        </header>

        <div className='flex flex-col gap-20px'>
          {groups.map((group) => (
            <section key={group.key} className='border border-b-base bg-base rd-12px p-16px'>
              <div className='flex items-center gap-8px mb-14px'>
                <Typography.Title heading={5} className='m-0 text-t-primary'>
                  {group.label}
                </Typography.Title>
                <Tag bordered>{t('settings.pricing.aliasCount', { count: group.rows.length })}</Tag>
              </div>
              <Table<ModelPricing>
                columns={columns}
                data={group.rows}
                rowKey='alias'
                pagination={false}
                borderCell
                size='small'
                scroll={{ x: 870 }}
              />
            </section>
          ))}
        </div>
      </div>
    </main>
  );
};

export default PricingPage;
