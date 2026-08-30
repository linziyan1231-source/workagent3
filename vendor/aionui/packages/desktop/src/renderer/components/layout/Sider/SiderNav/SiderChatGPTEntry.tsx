/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@arco-design/web-react';
import { MessageOne } from '@icon-park/react';
import classNames from 'classnames';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

interface SiderChatGPTEntryProps {
  isMobile: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  onClick: () => void;
}

const SiderChatGPTEntry: React.FC<SiderChatGPTEntryProps> = ({ isMobile, collapsed, siderTooltipProps, onClick }) => {
  const { t } = useTranslation();
  const label = t('settings.chatgptWeb');

  if (collapsed) {
    return (
      <Tooltip {...siderTooltipProps} content={label} position='right'>
        <a
          href='/chatgpt/'
          className='w-full h-34px flex items-center justify-center cursor-pointer no-underline transition-colors rd-8px text-t-primary hover:bg-fill-3 active:bg-fill-4'
          onClick={onClick}
        >
          <MessageOne
            theme='outline'
            size='20'
            fill='currentColor'
            className='block leading-none shrink-0'
            style={{ lineHeight: 0 }}
          />
        </a>
      </Tooltip>
    );
  }

  return (
    <Tooltip {...siderTooltipProps} content={label} position='right'>
      <a
        href='/chatgpt/'
        className={classNames(
          'box-border group h-34px w-full flex items-center justify-start gap-8px pl-10px pr-8px rd-0.5rem cursor-pointer no-underline shrink-0 transition-all text-t-primary hover:bg-fill-3 active:bg-fill-4',
          isMobile && 'sider-action-btn-mobile'
        )}
        onClick={onClick}
      >
        <span className='size-22px flex items-center justify-center shrink-0 text-t-primary'>
          <MessageOne
            theme='outline'
            size='16'
            fill='currentColor'
            className='block leading-none'
            style={{ lineHeight: 0 }}
          />
        </span>
        <span className='collapsed-hidden text-t-primary text-14px font-[500] leading-24px'>{label}</span>
      </a>
    </Tooltip>
  );
};

export default SiderChatGPTEntry;
