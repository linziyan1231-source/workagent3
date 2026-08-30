/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AcpConfigSetStatus, AcpDerivedOption } from '@/renderer/hooks/agent/useAcpConfigOptions';
import { Menu, Tooltip } from '@arco-design/web-react';
import React from 'react';

type ThoughtLevelLabelFormatter = (value: string, label: string) => string;

export const getCurrentThoughtLevelLabel = (
  thoughtLevel: AcpDerivedOption | null | undefined,
  formatLabel?: ThoughtLevelLabelFormatter
): string => {
  if (!thoughtLevel) return '';
  const currentOption = thoughtLevel.options.find((item) => item.value === thoughtLevel.currentValue);
  if (currentOption) return formatLabel?.(currentOption.value, currentOption.label) ?? currentOption.label;
  return thoughtLevel.currentValue || '';
};

export const composeRuntimeSelectorLabel = ({
  modelLabel,
  thoughtLevel,
  formatThoughtLevelLabel,
}: {
  modelLabel: string;
  thoughtLevel?: AcpDerivedOption | null;
  formatThoughtLevelLabel?: ThoughtLevelLabelFormatter;
}): string => {
  const thoughtLevelLabel = getCurrentThoughtLevelLabel(thoughtLevel, formatThoughtLevelLabel);
  if (!thoughtLevelLabel) return modelLabel;
  return `${modelLabel} · ${thoughtLevelLabel}`;
};

export const isConfigSetting = (setStatus?: AcpConfigSetStatus): boolean => setStatus?.state === 'setting';

export const RuntimeSelectorMenuDivider: React.FC = () => (
  <div role='separator' data-testid='runtime-selector-menu-divider' className='h-1px my-4px bg-[var(--color-fill-3)]' />
);

export const RuntimeSelectorCheckedItem: React.FC<{
  selected: boolean;
  description?: React.ReactNode;
  children: React.ReactNode;
}> = ({ selected, description, children }) => {
  const content = (
    <div className='flex items-center gap-8px w-full min-w-0'>
      <span aria-hidden='true' className='w-16px shrink-0 text-primary'>
        {selected ? '\u2713' : ''}
      </span>
      <span className='min-w-0 truncate'>{children}</span>
    </div>
  );

  return description ? (
    <Tooltip content={description} position='right'>
      {content}
    </Tooltip>
  ) : (
    content
  );
};

export const renderThoughtLevelMenuGroup = ({
  thoughtLevel,
  setStatus,
  title,
  onSelect,
  formatLabel,
}: {
  thoughtLevel: AcpDerivedOption | null | undefined;
  setStatus?: AcpConfigSetStatus;
  title: string;
  onSelect: (value: string) => void;
  formatLabel?: ThoughtLevelLabelFormatter;
}): React.ReactNode => {
  if (!thoughtLevel) return null;
  const setting = isConfigSetting(setStatus);
  return (
    <Menu.ItemGroup title={title}>
      {thoughtLevel.options.map((item) => (
        <Menu.Item
          key={item.value}
          className={item.value === thoughtLevel.currentValue ? 'bg-2!' : ''}
          onClick={() => {
            if (!setting) onSelect(item.value);
          }}
        >
          <RuntimeSelectorCheckedItem
            selected={item.value === thoughtLevel.currentValue}
            description={item.description}
          >
            {formatLabel?.(item.value, item.label) ?? item.label}
          </RuntimeSelectorCheckedItem>
        </Menu.Item>
      ))}
    </Menu.ItemGroup>
  );
};
