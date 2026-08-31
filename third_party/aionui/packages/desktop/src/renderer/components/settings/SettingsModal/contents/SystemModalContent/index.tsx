/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type {
  IGpuStatus,
  IStartOnBootStatus,
  PortalSharedConversation,
  PortalSharedProject,
} from '@/common/adapter/ipcBridge';
import { configService } from '@/common/config/configService';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import FeedbackButton from '@/renderer/components/base/FeedbackButton';
import LanguageSwitcher from '@/renderer/components/settings/LanguageSwitcher';
import AionSelect from '@/renderer/components/base/AionSelect';
import { getClientBusinessSetting, setClientBusinessSetting } from '@/renderer/services/clientBusinessSettings';
import { notifyManualRestartRequired } from '@/renderer/utils/appRestart';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { useOptionalAuth } from '@/renderer/hooks/context/AuthContext';
import { Alert, Button, Collapse, Form, Input, InputNumber, Message, Modal, Switch } from '@arco-design/web-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const SERVICE_RESTART_RELOAD_DEFAULT_MS = 2_000;
const SERVICE_RESTART_RELOAD_MIN_MS = 1_000;
const SERVICE_RESTART_RELOAD_MAX_MS = 30_000;

const normalizeServiceRestartReloadDelay = (value: number): number => {
  const delay = Number.isFinite(value) ? value : SERVICE_RESTART_RELOAD_DEFAULT_MS;
  return Math.min(SERVICE_RESTART_RELOAD_MAX_MS, Math.max(SERVICE_RESTART_RELOAD_MIN_MS, delay));
};
import useSWR from 'swr';
import { useSettingsViewMode } from '../../settingsViewContext';
import BrowserNotificationGrant from './BrowserNotificationGrant';
import DevSettings from './DevSettings';
import DirInputItem from './DirInputItem';
import PreferenceRow from './PreferenceRow';
import VoiceInputSection from './VoiceInputSection';

/**
 * System settings content component
 *
 * Provides system-level configuration options including language, directory config,
 * and developer tools (dev mode only).
 */
const SystemModalContent: React.FC = () => {
  const { t } = useTranslation();
  const isDesktop = isElectronDesktop();
  const auth = useOptionalAuth();
  const user = auth?.user;
  const [form] = Form.useForm();
  const [modal, modalContextHolder] = Modal.useModal();
  const [error, setError] = useState<string | null>(null);
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const initializingRef = useRef(true);

  const [startOnBoot, setStartOnBoot] = useState<IStartOnBootStatus>({
    supported: false,
    enabled: false,
    isPackaged: false,
    platform: 'web',
  });
  const [closeToTray, setCloseToTray] = useState(false);
  const [gpuStatus, setGpuStatus] = useState<IGpuStatus | null>(null);
  const [notificationEnabled, setNotificationEnabled] = useState(true);
  const [cronNotificationEnabled, setCronNotificationEnabled] = useState(false);
  const [weixinCompletionDeliveryEnabled, setWeixinCompletionDeliveryEnabled] = useState(false);
  const [weixinIdleTimeoutMinutes, setWeixinIdleTimeoutMinutes] = useState<number | undefined>(120);
  const [weixinIdlePolicy, setWeixinIdlePolicy] = useState<'auto' | 'ask' | 'disabled'>('ask');
  const [promptTimeout, setPromptTimeout] = useState<number>(300);
  const [agentIdleTimeout, setAgentIdleTimeout] = useState<number>(5);
  const [saveUploadToWorkspace, setSaveUploadToWorkspace] = useState(false);
  const [autoPreviewOfficeFiles, setAutoPreviewOfficeFiles] = useState(true);
  const [forkMode, setForkMode] = useState<'fork_only' | 'fork_and_edit'>('fork_and_edit');
  const [displayName, setDisplayName] = useState(user?.display_name ?? user?.username ?? '');
  const [collaborationEnabled, setCollaborationEnabled] = useState(Boolean(user?.collaboration_enabled));
  const [savingProfile, setSavingProfile] = useState(false);
  const [hiddenSharedProjects, setHiddenSharedProjects] = useState<PortalSharedProject[]>([]);
  const [hiddenSharedConversations, setHiddenSharedConversations] = useState<PortalSharedConversation[]>([]);
  const [restoringSharedProject, setRestoringSharedProject] = useState<string>();
  const [restoringSharedConversation, setRestoringSharedConversation] = useState<string>();
  const [restartingService, setRestartingService] = useState(false);
  const { data: managedSystemStatus } = useSWR(!isDesktop ? 'workagent.system.status' : null, () =>
    ipcBridge.portal.getSystemStatus.invoke()
  );

  const refreshHiddenSharedProjects = useCallback(async () => {
    try {
      const [projects, conversations] = await Promise.all([
        ipcBridge.portal.listAllSharedProjects.invoke(),
        ipcBridge.portal.listAllSharedConversations.invoke(),
      ]);
      setHiddenSharedProjects(projects.projects.filter((project) => project.hidden));
      setHiddenSharedConversations(conversations.conversations.filter((conversation) => conversation.hidden));
    } catch {
      setHiddenSharedProjects([]);
      setHiddenSharedConversations([]);
    }
  }, []);

  useEffect(() => {
    if (user?.collaboration_enabled) void refreshHiddenSharedProjects();
  }, [refreshHiddenSharedProjects, user?.collaboration_enabled]);

  const restoreSharedProject = useCallback(
    async (project: PortalSharedProject) => {
      setRestoringSharedProject(project.id);
      try {
        await ipcBridge.portal.setSharedProjectHidden.invoke({ project_id: project.id, hidden: false });
        ipcBridge.conversation.listChanged.emit({
          conversation_id: `shared-project:${project.id}`,
          action: 'updated',
          source: 'shared-project-restored',
        });
        await refreshHiddenSharedProjects();
        Message.success(t('settings.collaboration.projectRestored', { defaultValue: 'Shared project restored' }));
      } catch {
        Message.error(
          t('settings.collaboration.projectRestoreFailed', { defaultValue: 'Shared project could not be restored' })
        );
      } finally {
        setRestoringSharedProject(undefined);
      }
    },
    [refreshHiddenSharedProjects, t]
  );

  const restoreSharedConversation = useCallback(
    async (conversation: PortalSharedConversation) => {
      setRestoringSharedConversation(conversation.id);
      try {
        await ipcBridge.portal.setSharedConversationHidden.invoke({
          conversation_id: conversation.id,
          hidden: false,
        });
        ipcBridge.conversation.listChanged.emit({
          conversation_id: `shared:${conversation.id}`,
          action: 'updated',
          source: 'shared-conversation-restored',
        });
        await refreshHiddenSharedProjects();
        Message.success(
          t('settings.collaboration.conversationRestored', { defaultValue: 'Shared conversation restored' })
        );
      } catch {
        Message.error(
          t('settings.collaboration.conversationRestoreFailed', {
            defaultValue: 'Shared conversation could not be restored',
          })
        );
      } finally {
        setRestoringSharedConversation(undefined);
      }
    },
    [refreshHiddenSharedProjects, t]
  );

  useEffect(() => {
    setDisplayName(user?.display_name ?? user?.username ?? '');
    setCollaborationEnabled(Boolean(user?.collaboration_enabled));
  }, [user]);

  const savePortalProfile = useCallback(async () => {
    const normalized = displayName.trim();
    if (!normalized) {
      Message.error(t('settings.profile.displayNameRequired'));
      return;
    }
    setSavingProfile(true);
    try {
      const result = await ipcBridge.portal.updateProfile.invoke({
        display_name: normalized,
        collaboration_enabled: collaborationEnabled,
      });
      setDisplayName(result.profile.display_name);
      setCollaborationEnabled(result.profile.collaboration_enabled);
      await auth?.refresh();
      Message.success(t('settings.profile.saved'));
    } catch {
      Message.error(t('settings.profile.saveFailed'));
    } finally {
      setSavingProfile(false);
    }
  }, [auth, collaborationEnabled, displayName, t]);

  const restartService = useCallback(() => {
    modal.confirm({
      title: t('settings.serviceRestart.confirmTitle'),
      content: t('settings.serviceRestart.confirmDescription'),
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        setRestartingService(true);
        try {
          const result = await ipcBridge.portal.restartService.invoke();
          Message.success(t('settings.serviceRestart.accepted'));
          window.setTimeout(
            () => window.location.reload(),
            normalizeServiceRestartReloadDelay(result.reconnect_after_ms)
          );
        } catch {
          setRestartingService(false);
          Message.error(t('settings.serviceRestart.failed'));
        }
      },
    });
  }, [modal, t]);

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    ipcBridge.application.getStartOnBootStatus
      .invoke()
      .then((result) => {
        if (result.success && result.data) {
          setStartOnBoot(result.data);
        }
      })
      .catch(() => {});

    ipcBridge.application.getGpuStatus
      .invoke()
      .then((result) => {
        if (result.success && result.data) {
          setGpuStatus(result.data);
        }
      })
      .catch(() => {});
  }, [isDesktop]);

  useEffect(() => {
    setCloseToTray(configService.get('system.closeToTray') ?? false);
    if (isDesktop) {
      ipcBridge.systemSettings.getCloseToTray
        .invoke()
        .then((enabled) => {
          setCloseToTray(enabled);
          configService.setLocal('system.closeToTray', enabled);
        })
        .catch(() => {});
    }
    setNotificationEnabled(configService.get('system.notificationEnabled') ?? true);
    setCronNotificationEnabled(configService.get('system.cronNotificationEnabled') ?? false);
    setWeixinCompletionDeliveryEnabled(configService.get('system.weixinCompletionDeliveryEnabled') ?? false);
    const storedWeixinIdleTimeout = configService.get('system.weixinIdleTimeoutMinutes') ?? 120;
    setWeixinIdleTimeoutMinutes(storedWeixinIdleTimeout);
    setWeixinIdlePolicy(
      configService.get('system.weixinIdlePolicy') ?? (storedWeixinIdleTimeout === 0 ? 'disabled' : 'ask')
    );
    setSaveUploadToWorkspace(configService.get('upload.saveToWorkspace') ?? false);
    setAutoPreviewOfficeFiles(configService.get('system.autoPreviewOfficeFiles') ?? true);
    setForkMode(configService.get('conversation.forkMode') ?? 'fork_and_edit');
  }, [isDesktop]);

  useEffect(() => {
    let cancelled = false;

    const loadAcpTimeouts = async () => {
      try {
        const [storedPromptTimeout, storedAgentIdleTimeout] = await Promise.all([
          getClientBusinessSetting('acp.promptTimeout'),
          getClientBusinessSetting('acp.agentIdleTimeout'),
        ]);
        if (cancelled) {
          return;
        }

        if (typeof storedPromptTimeout === 'number' && storedPromptTimeout > 0) {
          setPromptTimeout(storedPromptTimeout);
        }
        if (typeof storedAgentIdleTimeout === 'number' && storedAgentIdleTimeout > 0) {
          setAgentIdleTimeout(storedAgentIdleTimeout);
        }
      } catch {
        // Keep the in-memory defaults when backend settings are unavailable.
      }
    };

    void loadAcpTimeouts();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleCloseToTrayChange = useCallback(
    (checked: boolean) => {
      const previous = closeToTray;
      setCloseToTray(checked);
      configService.setLocal('system.closeToTray', checked);

      if (!isDesktop) {
        configService.set('system.closeToTray', checked).catch(() => {
          setCloseToTray(previous);
          configService.setLocal('system.closeToTray', previous);
        });
        return;
      }

      ipcBridge.systemSettings.setCloseToTray.invoke({ enabled: checked }).catch(() => {
        setCloseToTray(previous);
        configService.setLocal('system.closeToTray', previous);
      });
    },
    [closeToTray, isDesktop]
  );

  const handleHardwareAccelerationChange = useCallback(
    (checked: boolean) => {
      const previous = gpuStatus;
      const optimistic: IGpuStatus = {
        userOverride: checked ? 'force-on' : 'force-off',
        autoDisabled: false,
        crashCount: 0,
        lastCrashAt: gpuStatus?.lastCrashAt ?? null,
      };
      setGpuStatus(optimistic);

      const apply = () => {
        ipcBridge.application.setGpuOverride
          .invoke({ override: checked ? 'force-on' : 'force-off' })
          .then((result) => {
            if (result.success && result.data) {
              setGpuStatus(result.data);
              ipcBridge.application.restart
                .invoke()
                .then((restartResult) => notifyManualRestartRequired(restartResult, t))
                .catch(() => {});
            } else {
              setGpuStatus(previous);
              Message.error(t('settings.hardwareAccelerationUpdateFailed'));
            }
          })
          .catch(() => {
            setGpuStatus(previous);
            Message.error(t('settings.hardwareAccelerationUpdateFailed'));
          });
      };

      modal.confirm({
        title: t('settings.updateConfirm'),
        content: t('settings.hardwareAccelerationRestartConfirm'),
        onOk: apply,
        onCancel: () => setGpuStatus(previous),
      });
    },
    [gpuStatus, modal, t]
  );

  const handleStartOnBootChange = useCallback(
    (checked: boolean) => {
      const previousStatus = startOnBoot;
      setStartOnBoot((prev) => ({ ...prev, enabled: checked }));

      ipcBridge.application.setStartOnBoot
        .invoke({ enabled: checked })
        .then((result) => {
          if (result.success && result.data) {
            setStartOnBoot(result.data);
            return;
          }

          setStartOnBoot(previousStatus);
          Message.error(result.msg || t('settings.startOnBootUpdateFailed'));
        })
        .catch(() => {
          setStartOnBoot(previousStatus);
          Message.error(t('settings.startOnBootUpdateFailed'));
        });
    },
    [startOnBoot, t]
  );

  const handleNotificationEnabledChange = useCallback((checked: boolean) => {
    setNotificationEnabled(checked);
    configService.set('system.notificationEnabled', checked).catch(() => {
      setNotificationEnabled(!checked);
      configService.setLocal('system.notificationEnabled', !checked);
    });
  }, []);

  const handleCronNotificationEnabledChange = useCallback((checked: boolean) => {
    setCronNotificationEnabled(checked);
    configService.set('system.cronNotificationEnabled', checked).catch(() => {
      setCronNotificationEnabled(!checked);
      configService.setLocal('system.cronNotificationEnabled', !checked);
    });
  }, []);

  const handleWeixinCompletionDeliveryChange = useCallback(
    (checked: boolean) => {
      setWeixinCompletionDeliveryEnabled(checked);
      configService.set('system.weixinCompletionDeliveryEnabled', checked).catch(() => {
        setWeixinCompletionDeliveryEnabled(!checked);
        configService.setLocal('system.weixinCompletionDeliveryEnabled', !checked);
        Message.error(t('settings.weixinCompletionDeliveryUpdateFailed'));
      });
    },
    [t]
  );

  const handlePromptTimeoutChange = useCallback((val: number | undefined) => {
    setPromptTimeout(val as number);
  }, []);

  const handlePromptTimeoutBlur = useCallback(() => {
    const clamped = Math.max(30, Math.min(3600, promptTimeout || 300));
    setPromptTimeout(clamped);
    void setClientBusinessSetting('acp.promptTimeout', clamped).catch(() => {});
  }, [promptTimeout]);

  const handleAgentIdleTimeoutChange = useCallback((val: number | undefined) => {
    setAgentIdleTimeout(val as number);
  }, []);

  const handleAgentIdleTimeoutBlur = useCallback(() => {
    const clamped = Math.max(1, Math.min(60, agentIdleTimeout || 5));
    setAgentIdleTimeout(clamped);
    void setClientBusinessSetting('acp.agentIdleTimeout', clamped).catch(() => {});
  }, [agentIdleTimeout]);

  const handleSaveUploadToWorkspaceChange = useCallback((checked: boolean) => {
    setSaveUploadToWorkspace(checked);
    configService.set('upload.saveToWorkspace', checked).catch(() => {
      setSaveUploadToWorkspace(!checked);
      configService.setLocal('upload.saveToWorkspace', !checked);
    });
  }, []);

  const handleAutoPreviewOfficeFilesChange = useCallback((checked: boolean) => {
    setAutoPreviewOfficeFiles(checked);
    configService.set('system.autoPreviewOfficeFiles', checked).catch(() => {
      setAutoPreviewOfficeFiles(!checked);
      configService.setLocal('system.autoPreviewOfficeFiles', !checked);
    });
  }, []);

  const saveWeixinIdleTimeout = useCallback(
    (minutes: number) => {
      const previous = weixinIdleTimeoutMinutes ?? 120;
      const next = Math.max(1, Math.min(10080, Math.round(minutes)));
      setWeixinIdleTimeoutMinutes(next);
      configService.set('system.weixinIdleTimeoutMinutes', next).catch(() => {
        setWeixinIdleTimeoutMinutes(previous);
        configService.setLocal('system.weixinIdleTimeoutMinutes', previous);
      });
    },
    [weixinIdleTimeoutMinutes]
  );

  const handleWeixinIdlePolicyChange = useCallback(
    (next: 'auto' | 'ask' | 'disabled') => {
      const previous = weixinIdlePolicy;
      setWeixinIdlePolicy(next);
      configService.set('system.weixinIdlePolicy', next).catch(() => {
        setWeixinIdlePolicy(previous);
        configService.setLocal('system.weixinIdlePolicy', previous);
      });
    },
    [weixinIdlePolicy]
  );

  // Get system directory info
  const { data: systemInfo } = useSWR('system.dir.info', () => ipcBridge.application.systemInfo.invoke());

  // Initialize form data
  useEffect(() => {
    if (systemInfo) {
      initializingRef.current = true;
      form.setFieldsValue({ workDir: systemInfo.workDir, logDir: systemInfo.logDir });
      requestAnimationFrame(() => {
        initializingRef.current = false;
      });
    }
  }, [systemInfo, form]);

  const preferenceItems = [
    ...(!isDesktop && user?.collaboration_capable && !user.admin
      ? [
          {
            key: 'portalProfile',
            label: t('settings.profile.title'),
            description: t('settings.profile.description'),
            component: (
              <div className='flex flex-wrap items-center justify-end gap-8px'>
                <Input
                  aria-label={t('settings.profile.displayName')}
                  value={displayName}
                  maxLength={64}
                  onChange={setDisplayName}
                  style={{ width: 180 }}
                  placeholder={t('settings.profile.displayName')}
                />
                <Switch
                  checked={collaborationEnabled}
                  onChange={setCollaborationEnabled}
                  checkedText={t('settings.profile.collaborationOn')}
                  uncheckedText={t('settings.profile.collaborationOff')}
                />
                <Button type='primary' loading={savingProfile} onClick={() => void savePortalProfile()}>
                  {t('common.save')}
                </Button>
              </div>
            ),
          },
        ]
      : []),
    { key: 'language', label: t('settings.language'), component: <LanguageSwitcher /> },
    {
      key: 'startOnBoot',
      label: t('settings.startOnBoot'),
      description: startOnBoot.supported ? t('settings.startOnBootDesc') : t('settings.startOnBootUnsupported'),
      component: (
        <Switch checked={startOnBoot.enabled} onChange={handleStartOnBootChange} disabled={!startOnBoot.supported} />
      ),
    },
    {
      key: 'closeToTray',
      label: t('settings.closeToTray'),
      component: <Switch checked={closeToTray} onChange={handleCloseToTrayChange} />,
    },
    {
      key: 'weixinCompletionDelivery',
      label: t('settings.weixinCompletionDelivery'),
      description: t('settings.weixinCompletionDeliveryDesc'),
      component: <Switch checked={weixinCompletionDeliveryEnabled} onChange={handleWeixinCompletionDeliveryChange} />,
    },
    ...(isDesktop && gpuStatus
      ? [
          {
            key: 'hardwareAcceleration',
            label: t('settings.hardwareAcceleration'),
            description: gpuStatus.autoDisabled
              ? t('settings.hardwareAccelerationAutoDisabled')
              : t('settings.hardwareAccelerationDesc'),
            component: (
              <Switch
                checked={gpuStatus.userOverride !== 'force-off' && !gpuStatus.autoDisabled}
                onChange={handleHardwareAccelerationChange}
              />
            ),
          },
        ]
      : []),
    {
      key: 'promptTimeout',
      label: t('settings.promptTimeout'),
      component: (
        <InputNumber
          value={promptTimeout}
          onChange={handlePromptTimeoutChange}
          onBlur={handlePromptTimeoutBlur}
          max={3600}
          step={30}
          style={{ width: 120 }}
          suffix='s'
        />
      ),
    },
    {
      key: 'agentIdleTimeout',
      label: t('settings.agentIdleTimeout'),
      description: t('settings.agentIdleTimeoutDesc'),
      component: (
        <InputNumber
          value={agentIdleTimeout}
          onChange={handleAgentIdleTimeoutChange}
          onBlur={handleAgentIdleTimeoutBlur}
          max={60}
          step={5}
          style={{ width: 120 }}
          suffix='min'
        />
      ),
    },
    {
      key: 'weixinIdleTimeout',
      label: t('settings.weixinIdleTimeout'),
      description: t('settings.weixinIdleTimeoutDesc'),
      component: (
        <div className='flex items-center gap-8px'>
          <AionSelect value={weixinIdlePolicy} onChange={handleWeixinIdlePolicyChange} style={{ width: 120 }}>
            <AionSelect.Option value='auto'>{t('settings.weixinIdlePolicyAuto')}</AionSelect.Option>
            <AionSelect.Option value='ask'>{t('settings.weixinIdlePolicyAsk')}</AionSelect.Option>
            <AionSelect.Option value='disabled'>{t('settings.weixinIdlePolicyDisabled')}</AionSelect.Option>
          </AionSelect>
          <InputNumber
            value={weixinIdleTimeoutMinutes}
            disabled={weixinIdlePolicy === 'disabled'}
            min={1}
            max={10080}
            step={30}
            style={{ width: 120 }}
            suffix='min'
            onChange={setWeixinIdleTimeoutMinutes}
            onBlur={() => saveWeixinIdleTimeout(weixinIdleTimeoutMinutes || 120)}
          />
        </div>
      ),
    },
    {
      key: 'saveUploadToWorkspace',
      label: t('settings.saveUploadToWorkspace'),
      component: <Switch checked={saveUploadToWorkspace} onChange={handleSaveUploadToWorkspaceChange} />,
    },
    {
      key: 'autoPreviewOfficeFiles',
      label: t('settings.autoPreviewOfficeFiles'),
      description: t('settings.autoPreviewOfficeFilesDesc'),
      component: <Switch checked={autoPreviewOfficeFiles} onChange={handleAutoPreviewOfficeFilesChange} />,
    },
    {
      key: 'conversationForkMode',
      label: t('settings.conversationForkMode'),
      description: t('settings.conversationForkModeDesc'),
      component: (
        <AionSelect
          value={forkMode ?? 'fork_and_edit'}
          style={{ width: 160 }}
          onChange={(value) => {
            const previous = forkMode;
            const next = value as 'fork_only' | 'fork_and_edit';
            setForkMode(next);
            void configService.set('conversation.forkMode', next).catch(() => {
              setForkMode(previous);
              configService.setLocal('conversation.forkMode', previous);
              Message.error(t('settings.conversationForkModeUpdateFailed'));
            });
          }}
        >
          <AionSelect.Option value='fork_only'>{t('settings.conversationForkModeOnly')}</AionSelect.Option>
          <AionSelect.Option value='fork_and_edit'>{t('settings.conversationForkModeEdit')}</AionSelect.Option>
        </AionSelect>
      ),
    },
  ];

  const saveDirConfigValidate = (_values: { workDir: string; logDir: string }): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      modal.confirm({
        title: t('settings.updateConfirm'),
        content: t('settings.restartConfirm'),
        onOk: resolve,
        onCancel: reject,
      });
    });
  };

  const savingRef = useRef(false);

  const handleValuesChange = useCallback(
    async (_changedValue: unknown, allValues: Record<string, string>) => {
      if (initializingRef.current || savingRef.current || !systemInfo) return;
      const { workDir, logDir } = allValues;
      const needsRestart = workDir !== systemInfo.workDir || logDir !== systemInfo.logDir;
      if (!needsRestart) return;

      savingRef.current = true;
      setError(null);
      try {
        await saveDirConfigValidate({ workDir, logDir });
        // Pass systemInfo.cacheDir as-is: cacheDir is no longer user-editable
        // (removed from UI), but the backend IPC interface still expects it.
        // Passing the current value ensures existing custom paths are preserved.
        await ipcBridge.application.updateSystemInfo.invoke({ cacheDir: systemInfo.cacheDir, workDir, logDir });
        const restartResult = await ipcBridge.application.restart.invoke();
        notifyManualRestartRequired(restartResult, t);
      } catch (caughtError: unknown) {
        form.setFieldsValue({ workDir: systemInfo.workDir, logDir: systemInfo.logDir });
        if (caughtError) {
          setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
        }
      } finally {
        savingRef.current = false;
      }
    },
    [systemInfo, form, saveDirConfigValidate, t]
  );

  return (
    <div className='flex flex-col h-full w-full'>
      {modalContextHolder}

      <AionScrollArea className='flex-1 min-h-0 pb-16px' disableOverflow={isPageMode}>
        <div className='space-y-16px'>
          <div className='px-[12px] md:px-[32px] py-16px bg-2 rd-16px space-y-12px'>
            <div className='w-full flex flex-col divide-y divide-border-2'>
              {preferenceItems.map((item) => (
                <PreferenceRow key={item.key} label={item.label} description={item.description}>
                  {item.component}
                </PreferenceRow>
              ))}
            </div>
            {/* Notification settings with collapsible sub-options */}
            <Collapse
              bordered={false}
              activeKey={notificationEnabled ? ['notification'] : []}
              onChange={(_, keys) => {
                const shouldExpand = (keys as string[]).includes('notification');
                if (shouldExpand && !notificationEnabled) {
                  handleNotificationEnabledChange(true);
                } else if (!shouldExpand && notificationEnabled) {
                  handleNotificationEnabledChange(false);
                }
              }}
              className='[&_.arco-collapse-item]:!border-none [&_.arco-collapse-item-header]:!px-0 [&_.arco-collapse-item-header-title]:!flex-1 [&_.arco-collapse-item-content-box]:!px-0 [&_.arco-collapse-item-content-box]:!pb-0'
            >
              <Collapse.Item
                name='notification'
                showExpandIcon={false}
                header={
                  <div className='flex flex-1 items-center justify-between w-full'>
                    <span className='text-14px text-2 ml-12px'>{t('settings.notification')}</span>
                    <Switch
                      checked={notificationEnabled}
                      onClick={(e) => e.stopPropagation()}
                      onChange={handleNotificationEnabledChange}
                    />
                  </div>
                }
              >
                {isDesktop ? (
                  <div className='pl-12px'>
                    <PreferenceRow label={t('settings.cronNotificationEnabled')}>
                      <Switch
                        checked={cronNotificationEnabled}
                        disabled={!notificationEnabled}
                        onChange={handleCronNotificationEnabledChange}
                      />
                    </PreferenceRow>
                  </div>
                ) : (
                  <BrowserNotificationGrant />
                )}
              </Collapse.Item>
            </Collapse>
            <Form form={form} layout='vertical' className='!mt-32px space-y-16px' onValuesChange={handleValuesChange}>
              <DirInputItem label={t('settings.workDir')} field='workDir' />
              <DirInputItem label={t('settings.logDir')} field='logDir' />
              {error && (
                <Alert
                  className='mt-16px'
                  type='error'
                  content={
                    <span>
                      {typeof error === 'string' ? error : JSON.stringify(error)}
                      <FeedbackButton module='system-settings' className='ml-6px' />
                    </span>
                  }
                />
              )}
            </Form>
          </div>

          {user?.collaboration_enabled && (
            <div className='px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
              <div className='mb-12px flex items-center justify-between'>
                <div>
                  <div className='text-14px font-500 text-t-primary'>
                    {t('settings.collaboration.hiddenProjects', { defaultValue: 'Hidden shared projects' })}
                  </div>
                  <div className='mt-2px text-12px text-t-tertiary'>
                    {t('settings.collaboration.hiddenProjectsDescription', {
                      defaultValue: 'Restore projects that you previously hid from the conversation sidebar.',
                    })}
                  </div>
                </div>
                <Button size='small' onClick={() => void refreshHiddenSharedProjects()}>
                  {t('common.refresh', { defaultValue: 'Refresh' })}
                </Button>
              </div>
              {hiddenSharedProjects.length === 0 ? (
                <div className='rounded-8px bg-fill-1 px-12px py-10px text-12px text-t-tertiary'>
                  {t('settings.collaboration.noHiddenProjects', { defaultValue: 'No hidden shared projects' })}
                </div>
              ) : (
                <div className='flex flex-col gap-8px'>
                  {hiddenSharedProjects.map((project) => (
                    <div key={project.id} className='flex items-center gap-12px rounded-8px bg-fill-1 px-12px py-10px'>
                      <div className='min-w-0 flex-1'>
                        <div className='truncate text-13px text-t-primary'>{project.name}</div>
                        <div className='truncate text-12px text-t-tertiary'>{project.owner_name}</div>
                      </div>
                      <Button
                        size='small'
                        loading={restoringSharedProject === project.id}
                        onClick={() => void restoreSharedProject(project)}
                      >
                        {t('common.restore', { defaultValue: 'Restore' })}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <div className='mb-8px mt-16px text-14px font-500 text-t-primary'>
                {t('settings.collaboration.hiddenConversations', { defaultValue: 'Hidden shared conversations' })}
              </div>
              {hiddenSharedConversations.length === 0 ? (
                <div className='rounded-8px bg-fill-1 px-12px py-10px text-12px text-t-tertiary'>
                  {t('settings.collaboration.noHiddenConversations', {
                    defaultValue: 'No hidden shared conversations',
                  })}
                </div>
              ) : (
                <div className='flex flex-col gap-8px'>
                  {hiddenSharedConversations.map((conversation) => (
                    <div
                      key={conversation.id}
                      className='flex items-center gap-12px rounded-8px bg-fill-1 px-12px py-10px'
                    >
                      <div className='min-w-0 flex-1'>
                        <div className='truncate text-13px text-t-primary'>{conversation.name}</div>
                        <div className='truncate text-12px text-t-tertiary'>{conversation.project_name}</div>
                      </div>
                      <Button
                        size='small'
                        loading={restoringSharedConversation === conversation.id}
                        onClick={() => void restoreSharedConversation(conversation)}
                      >
                        {t('common.restore', { defaultValue: 'Restore' })}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Voice input (speech-to-text) settings */}
          <VoiceInputSection />

          {/* Developer settings: DevTools + CDP (only visible in dev mode) */}
          <DevSettings />

          {!isDesktop && (
            <div className='px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
              <div className='mb-12px flex flex-wrap gap-8px'>
                {(managedSystemStatus?.components ?? []).map((component) => (
                  <span
                    key={component.id}
                    className='px-8px py-4px rd-6px text-12px bg-fill-2 text-t-secondary'
                  >
                    {component.id} · {component.status}
                  </span>
                ))}
              </div>
              <PreferenceRow
                label={t('settings.serviceRestart.title')}
                description={t('settings.serviceRestart.description')}
              >
                <Button status='danger' loading={restartingService} onClick={restartService}>
                  {t('settings.serviceRestart.action')}
                </Button>
              </PreferenceRow>
            </div>
          )}
        </div>
      </AionScrollArea>
    </div>
  );
};

export default SystemModalContent;
