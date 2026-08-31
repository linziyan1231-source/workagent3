/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Divider, Typography } from '@arco-design/web-react';
import { Right } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import classNames from 'classnames';
import { useSettingsViewMode } from '../settingsViewContext';
import brandLogo from '@/renderer/assets/logos/brand/app.png';
import FeedbackReportModal from './FeedbackReportModal';
import { ipcBridge } from '@/common';

type LinkItem = {
  title: string;
  onClick: () => void;
};

const AboutModalContent: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [versionLabel, setVersionLabel] = useState(t('settings.productVersion'));

  React.useEffect(() => {
    void ipcBridge.portal.getSystemStatus
      .invoke()
      .then((status) => {
        const version = status.build.version.trim();
        if (version) setVersionLabel(version.startsWith('v') ? version : `v${version}`);
      })
      .catch(() => undefined);
  }, []);

  const linkItems: LinkItem[] = [
    {
      title: t('settings.helpDocumentation'),
      onClick: () => void navigate('/help'),
    },
    {
      title: t('settings.healthCheck'),
      onClick: () => void ipcBridge.portal.downloadDiagnostics.invoke(),
    },
    {
      title: t('settings.bugReport'),
      onClick: () => setShowFeedbackModal(true),
    },
  ];

  return (
    <div className='flex flex-col h-full w-full'>
      <div
        className={classNames(
          'flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-24px',
          isPageMode && 'px-0 overflow-visible'
        )}
      >
        <div className='flex flex-col max-w-500px mx-auto'>
          <div className='flex flex-col items-center pb-24px'>
            <img src={brandLogo} alt={t('settings.productName')} className='size-88px object-contain mb-16px' />
            <Typography.Title heading={3} className='text-24px font-bold text-t-primary mb-8px'>
              {t('settings.productName')}
            </Typography.Title>
            <Typography.Text className='text-14px text-t-secondary mb-12px text-center'>
              {t('settings.appDescription')}
            </Typography.Text>
            <span className='px-10px py-4px rd-6px text-13px bg-fill-2 text-t-primary font-500'>
              {versionLabel}
            </span>
          </div>

          <Divider className='my-16px' />

          <div className='flex flex-col gap-4px pt-8px'>
            {linkItems.map((item) => (
              <Button
                key={item.title}
                type='text'
                long
                className='!h-auto !flex !items-center !justify-between !px-16px !py-12px !rd-8px !text-t-primary'
                onClick={item.onClick}
              >
                <span className='text-14px'>{item.title}</span>
                <Right theme='outline' size='16' className='text-t-secondary' />
              </Button>
            ))}
          </div>
        </div>
      </div>
      <FeedbackReportModal visible={showFeedbackModal} onCancel={() => setShowFeedbackModal(false)} />
    </div>
  );
};

export default AboutModalContent;
