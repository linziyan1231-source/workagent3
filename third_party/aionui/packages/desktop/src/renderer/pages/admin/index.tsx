import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Card,
  Empty,
  Form,
  Input,
  InputNumber,
  Message,
  Modal,
  Progress,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
} from '@arco-design/web-react';
import type { TableColumnProps } from '@arco-design/web-react';
import { CloseSmall, Peoples, Plus, Refresh } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import type { PortalSkillMarketEntry } from '@/common/adapter/ipcBridge';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import AuditPanel from './AuditPanel';
import MigrationPanel from './MigrationPanel';
import type {
  AddManagedUserForm,
  CreationJob,
  EmployeeLifecycleAction,
  EmployeeLifecycleForm,
  KimiDatasourcePolicyForm,
  ManagedUser,
  ResetManagedUserPasswordForm,
} from './types';

const formatBytes = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
const formatUSD = (amount: string): string => `$${amount}`;

const DEFAULT_COLUMN_WIDTHS = {
  username: 150,
  windowsAccount: 230,
  status: 120,
  resourceUsage: 330,
  kimiDatasource: 280,
  createdAt: 200,
  lastLoginAt: 200,
  actions: 310,
} as const;

type ColumnKey = keyof typeof DEFAULT_COLUMN_WIDTHS;

const AdminAccountsPage: React.FC = () => {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const [form] = Form.useForm<AddManagedUserForm>();
  const [resetForm] = Form.useForm<ResetManagedUserPasswordForm>();
  const [kimiForm] = Form.useForm<KimiDatasourcePolicyForm>();
  const [lifecycleForm] = Form.useForm<EmployeeLifecycleForm>();
  const [modal, modalContextHolder] = Modal.useModal();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [addVisible, setAddVisible] = useState(false);
  const [resetTarget, setResetTarget] = useState<ManagedUser>();
  const [resetting, setResetting] = useState(false);
  const [kimiTarget, setKimiTarget] = useState<ManagedUser>();
  const [savingKimi, setSavingKimi] = useState(false);
  const [lifecycleTarget, setLifecycleTarget] = useState<ManagedUser>();
  const [lifecycleAction, setLifecycleAction] = useState<EmployeeLifecycleAction>('set-limits');
  const [savingLifecycle, setSavingLifecycle] = useState(false);
  const [kimiSources, setKimiSources] = useState<string[]>([]);
  const [usageLoading, setUsageLoading] = useState<ReadonlySet<string>>(new Set());
  const [creationJobs, setCreationJobs] = useState<CreationJob[]>([]);
  const [marketSkills, setMarketSkills] = useState<PortalSkillMarketEntry[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [columnWidths, setColumnWidths] = useState<Record<ColumnKey, number>>({
    ...DEFAULT_COLUMN_WIDTHS,
  });
  const loadGeneration = useRef(0);

  const loadUsers = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const response = await ipcBridge.portal.listManagedUsers.invoke();
      if (generation !== loadGeneration.current) return;
      const managedUsers = response.users ?? [];
      setUsers(managedUsers);
      setKimiSources(response.kimi_datasource_sources ?? []);
      setUsageLoading(new Set(managedUsers.map(({ username }) => username)));
      void ipcBridge.portal.getManagedUsersUsage
        .invoke()
        .then((usageResponse) => {
          if (generation !== loadGeneration.current) return;
          const usageByUsername = new Map(
            (usageResponse.users ?? []).map((item) => [item.username, item.resource_usage] as const)
          );
          setUsers((current) =>
            current.map((candidate) => {
              const usage = usageByUsername.get(candidate.username);
              return {
                ...candidate,
                resource_usage: usage,
                resource_usage_unavailable: !usage,
              };
            })
          );
        })
        .catch((error) => {
          if (generation !== loadGeneration.current) return;
          console.error('Failed to load managed users usage:', error);
          setUsers((current) =>
            current.map(
              (candidate): ManagedUser => ({
                ...candidate,
                resource_usage: undefined,
                resource_usage_unavailable: true,
              })
            )
          );
        })
        .finally(() => {
          if (generation !== loadGeneration.current) return;
          setUsageLoading(new Set());
        });
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      console.error('Failed to load managed users:', error);
      Message.error(t('settings.adminAccounts.loadFailed'));
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    void loadUsers();
    return () => {
      loadGeneration.current += 1;
    };
  }, [loadUsers]);

  const loadMarket = useCallback(async () => {
    setMarketLoading(true);
    try {
      setMarketSkills((await ipcBridge.portal.listSkillMarket.invoke()).skills);
    } catch (error) {
      console.error('Failed to load skill market:', error);
      Message.error(t('settings.skillsHub.marketFetchFailed'));
    } finally {
      setMarketLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadMarket();
  }, [loadMarket]);

  const deleteMarketSkill = async (skill: PortalSkillMarketEntry) => {
    await ipcBridge.portal.deleteMarketSkill.invoke({ id: skill.id });
    Message.success(t('settings.skillsHub.marketDeleted'));
    await loadMarket();
  };

  const creationStepText = useCallback(
    (step: string): string => {
      switch (step) {
        case 'queued':
          return t('settings.adminAccounts.creationProgress.queued');
        case 'validating':
          return t('settings.adminAccounts.creationProgress.validating');
        case 'checking_accounts':
          return t('settings.adminAccounts.creationProgress.checkingAccounts');
        case 'configuring_windows_account':
          return t('settings.adminAccounts.creationProgress.configuringWindowsAccount');
        case 'applying_security_policy':
          return t('settings.adminAccounts.creationProgress.applyingSecurityPolicy');
        case 'creating_windows_profile':
          return t('settings.adminAccounts.creationProgress.creatingWindowsProfile');
        case 'creating_portal_account':
          return t('settings.adminAccounts.creationProgress.creatingPortalAccount');
        case 'applying_storage_quota':
          return t('settings.adminAccounts.creationProgress.applyingStorageQuota');
        case 'configuring_models':
          return t('settings.adminAccounts.creationProgress.configuringModels');
        case 'installing_runtime':
          return t('settings.adminAccounts.creationProgress.installingRuntime');
        case 'verifying':
          return t('settings.adminAccounts.creationProgress.verifying');
        case 'completed':
          return t('settings.adminAccounts.creationProgress.completed');
        default:
          return t('settings.adminAccounts.creationProgress.failed');
      }
    },
    [t]
  );

  const creationErrorText = useCallback(
    (job: CreationJob): string => {
      switch (job.error_code) {
        case 'WINDOWS_USERNAME_EXISTS':
          return t('settings.adminAccounts.creationErrors.windowsUsernameExists');
        case 'PORTAL_USERNAME_EXISTS':
          return t('settings.adminAccounts.creationErrors.portalUsernameExists');
        case 'WINDOWS_ACCOUNT_MAPPED':
          return t('settings.adminAccounts.creationErrors.windowsAccountMapped');
        case 'ACCOUNT_CONFLICT':
          return t('settings.adminAccounts.creationErrors.accountConflict');
        case 'PROVISION_TIMEOUT':
          return t('settings.adminAccounts.creationErrors.timeout');
        default:
          return job.error_message || t('settings.adminAccounts.creationErrors.failed');
      }
    },
    [t]
  );

  useEffect(() => {
    const runningJobs = creationJobs.filter(({ status }) => status === 'running');
    if (runningJobs.length === 0) return;
    const timer = window.setTimeout(() => {
      void Promise.all(
        runningJobs.map(async (job) => {
          try {
            return (await ipcBridge.portal.getManagedUserJob.invoke({ id: job.id })).job;
          } catch (error) {
            console.error('Failed to load account creation progress:', error);
            return job;
          }
        })
      ).then((updates) => {
        setCreationJobs((current) => current.map((job) => updates.find((update) => update.id === job.id) ?? job));
        if (updates.some(({ status }) => status === 'succeeded')) {
          Message.success(t('settings.adminAccounts.addSuccess'));
          void loadUsers();
        }
        for (const failed of updates.filter(({ status }) => status === 'failed')) {
          Message.error(creationErrorText(failed));
        }
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [creationErrorText, creationJobs, loadUsers, t]);

  const createUser = async () => {
    let values: AddManagedUserForm;
    try {
      values = await form.validate();
    } catch {
      return;
    }
    if (values.portalPassword !== values.confirmPassword) {
      form.setFields({
        confirmPassword: { error: { message: t('settings.adminAccounts.passwordMismatch') } },
      });
      return;
    }
    try {
      setCreating(true);
      const response = await ipcBridge.portal.addManagedUser.invoke({
        username: values.username.trim(),
        portal_password: values.portalPassword,
      });
      setCreationJobs((current) => [...current, response.job]);
      setAddVisible(false);
      form.resetFields();
    } catch (error) {
      console.error('Failed to add managed user:', error);
      const message =
        isBackendHttpError(error) && error.backendMessage === 'Account creation is already in progress'
          ? t('settings.adminAccounts.creationErrors.inProgress')
          : isBackendHttpError(error) && error.backendMessage.trim()
            ? error.backendMessage
            : t('settings.adminAccounts.addFailed');
      Message.error(message);
    } finally {
      setCreating(false);
    }
  };

  const disableUser = (managedUser: ManagedUser) => {
    modal.confirm({
      title: t('settings.adminAccounts.disableTitle'),
      content: t('settings.adminAccounts.disableConfirm', { username: managedUser.username }),
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        try {
          await ipcBridge.portal.disableManagedUser.invoke({ username: managedUser.username });
          Message.success(t('settings.adminAccounts.disableSuccess'));
          await loadUsers();
        } catch (error) {
          console.error('Failed to disable managed user:', error);
          Message.error(t('settings.adminAccounts.disableFailed'));
          throw error;
        }
      },
    });
  };

  const enableUser = (managedUser: ManagedUser) => {
    modal.confirm({
      title: t('settings.adminAccounts.enableTitle'),
      content: t('settings.adminAccounts.enableConfirm', { username: managedUser.username }),
      onOk: async () => {
        try {
          await ipcBridge.portal.enableManagedUser.invoke({ username: managedUser.username });
          Message.success(t('settings.adminAccounts.enableSuccess'));
          await loadUsers();
        } catch (error) {
          console.error('Failed to enable managed user:', error);
          const message =
            isBackendHttpError(error) && error.backendMessage.trim()
              ? error.backendMessage
              : t('settings.adminAccounts.enableFailed');
          Message.error(message);
          throw error;
        }
      },
    });
  };

  const resetPassword = async () => {
    if (!resetTarget) return;
    let values: ResetManagedUserPasswordForm;
    try {
      values = await resetForm.validate();
    } catch {
      return;
    }
    if (values.portalPassword !== values.confirmPassword) {
      resetForm.setFields({
        confirmPassword: { error: { message: t('settings.adminAccounts.passwordMismatch') } },
      });
      return;
    }
    try {
      setResetting(true);
      await ipcBridge.portal.resetManagedUserPassword.invoke({
        username: resetTarget.username,
        portal_password: values.portalPassword,
      });
      Message.success(t('settings.adminAccounts.resetPasswordSuccess'));
      setResetTarget(undefined);
      resetForm.resetFields();
    } catch (error) {
      console.error('Failed to reset managed user password:', error);
      const message =
        isBackendHttpError(error) && error.backendMessage.trim()
          ? error.backendMessage
          : t('settings.adminAccounts.resetPasswordFailed');
      Message.error(message);
    } finally {
      setResetting(false);
    }
  };

  const editKimiDatasource = (managedUser: ManagedUser) => {
    const policy = managedUser.kimi_datasource;
    kimiForm.setFieldsValue({
      enabled: policy?.enabled ?? false,
      allowedSources: policy?.allowed_sources?.length ? policy.allowed_sources : kimiSources,
      dailyLimit: policy?.daily_limit || 100,
      monthlyLimit: policy?.monthly_limit || 1000,
    });
    setKimiTarget(managedUser);
  };

  const saveKimiDatasource = async () => {
    if (!kimiTarget) return;
    let values: KimiDatasourcePolicyForm;
    try {
      values = await kimiForm.validate();
    } catch {
      return;
    }
    if (values.monthlyLimit < values.dailyLimit) {
      kimiForm.setFields({
        monthlyLimit: { error: { message: t('settings.adminAccounts.kimiDatasource.monthlyBelowDaily') } },
      });
      return;
    }
    try {
      setSavingKimi(true);
      await ipcBridge.portal.setManagedUserKimiDatasource.invoke({
        username: kimiTarget.username,
        enabled: values.enabled,
        allowed_sources: values.allowedSources,
        daily_limit: values.dailyLimit,
        monthly_limit: values.monthlyLimit,
      });
      Message.success(t('settings.adminAccounts.kimiDatasource.saveSuccess'));
      setKimiTarget(undefined);
      kimiForm.resetFields();
      await loadUsers();
    } catch (error) {
      console.error('Failed to update Kimi datasource policy:', error);
      const message =
        isBackendHttpError(error) && error.backendMessage.trim()
          ? error.backendMessage
          : t('settings.adminAccounts.kimiDatasource.saveFailed');
      Message.error(message);
    } finally {
      setSavingKimi(false);
    }
  };

  const openLifecycle = (managedUser: ManagedUser) => {
    const action: EmployeeLifecycleAction = managedUser.offboarded ? 'offboard-delete' : 'set-limits';
    setLifecycleTarget(managedUser);
    setLifecycleAction(action);
    lifecycleForm.setFieldsValue({
      action,
      memoryMiB: 1024,
      cpuPercent: 50,
      activeProcesses: 64,
      confirmation: '',
      newWindowsUsername: '',
      windowsPassword: '',
    });
  };

  const saveLifecycle = async () => {
    if (!lifecycleTarget) return;
    let values: EmployeeLifecycleForm;
    try {
      values = await lifecycleForm.validate();
    } catch {
      return;
    }
    if (
      values.action === 'offboard-delete' &&
      values.confirmation !== `DELETE ${lifecycleTarget.username}`
    ) {
      lifecycleForm.setFields({
        confirmation: { error: { message: t('settings.adminAccounts.lifecycle.confirmationMismatch') } },
      });
      return;
    }
    try {
      setSavingLifecycle(true);
      const username = lifecycleTarget.username;
      switch (values.action) {
        case 'set-limits':
          await ipcBridge.portal.setManagedUserLimits.invoke({
            username,
            limits: {
              memory_bytes: Math.round((values.memoryMiB ?? 0) * 1024 ** 2),
              cpu_percent: values.cpuPercent ?? 0,
              active_processes: values.activeProcesses ?? 0,
            },
          });
          break;
        case 'repair':
          await ipcBridge.portal.repairManagedUser.invoke({
            username,
            windows_password: values.windowsPassword ?? '',
          });
          break;
        case 'rename-windows':
          await ipcBridge.portal.renameManagedWindowsAccount.invoke({
            username,
            new_windows_username: values.newWindowsUsername?.trim() ?? '',
            windows_password: values.windowsPassword ?? '',
          });
          break;
        case 'offboard-retain':
          await ipcBridge.portal.offboardManagedUserRetainingData.invoke({ username });
          break;
        case 'offboard-delete':
          await ipcBridge.portal.deleteOffboardedManagedUser.invoke({
            username,
            confirmation: values.confirmation ?? '',
          });
          break;
      }
      Message.success(t('settings.adminAccounts.lifecycle.success'));
      setLifecycleTarget(undefined);
      lifecycleForm.resetFields();
      await loadUsers();
    } catch (error) {
      console.error('Failed to update employee lifecycle:', error);
      const message =
        isBackendHttpError(error) && error.backendMessage.trim()
          ? error.backendMessage
          : t('settings.adminAccounts.lifecycle.failed');
      Message.error(message);
    } finally {
      setSavingLifecycle(false);
    }
  };

  const beginColumnResize = useCallback(
    (event: React.MouseEvent, key: ColumnKey) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = columnWidths[key];
      const move = (moveEvent: MouseEvent) => {
        setColumnWidths((current) => ({
          ...current,
          [key]: Math.max(90, startWidth + moveEvent.clientX - startX),
        }));
      };
      const stop = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', stop);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', stop);
    },
    [columnWidths]
  );

  const columnTitle = useCallback(
    (key: ColumnKey, title: string) => (
      <div className='relative w-full pr-8px'>
        {title}
        <Button
          type='text'
          size='mini'
          data-testid={`resize-${key}`}
          aria-label={t('settings.adminAccounts.resizeColumn', { column: title })}
          className='!absolute !-right-10px !top-1/2 !h-28px !w-12px !min-w-0 !-translate-y-1/2 !cursor-col-resize !p-0'
          onMouseDown={(event) => beginColumnResize(event, key)}
        />
      </div>
    ),
    [beginColumnResize, t]
  );

  const columns = useMemo<TableColumnProps<ManagedUser>[]>(
    () => [
      {
        key: 'username',
        title: columnTitle('username', t('settings.adminAccounts.username')),
        dataIndex: 'username',
        width: columnWidths.username,
      },
      {
        key: 'windowsAccount',
        title: columnTitle('windowsAccount', t('settings.adminAccounts.windowsAccount')),
        dataIndex: 'windows_username',
        width: columnWidths.windowsAccount,
      },
      {
        key: 'status',
        title: columnTitle('status', t('settings.adminAccounts.status')),
        dataIndex: 'enabled',
        width: columnWidths.status,
        render: (_, record) => (
          <Tag color={record.offboarded ? 'orange' : record.enabled ? 'green' : 'gray'}>
            {t(
              record.offboarded
                ? 'settings.adminAccounts.lifecycle.offboarded'
                : record.enabled
                  ? 'settings.adminAccounts.enabled'
                  : 'settings.adminAccounts.disabled'
            )}
          </Tag>
        ),
      },
      {
        key: 'resourceUsage',
        title: columnTitle('resourceUsage', t('settings.adminAccounts.resourceUsage')),
        width: columnWidths.resourceUsage,
        render: (_, record) => {
          if (usageLoading.has(record.username)) {
            return <Spin size={16} />;
          }
          const usage = record.resource_usage;
          if (!usage || record.resource_usage_unavailable) {
            return <Typography.Text type='secondary'>{t('settings.portalUsage.storageUnavailable')}</Typography.Text>;
          }
          const personalStorage = usage.storage?.personal;
          const sharedStorage = usage.storage?.shared;
          return (
            <div className='flex flex-col gap-4px text-13px leading-20px'>
              {personalStorage && sharedStorage ? (
                <>
                  <div>
                    {t('settings.portalUsage.personalStorage')}: {formatBytes(personalStorage.used_bytes)} /{' '}
                    {formatBytes(personalStorage.limit_bytes)}
                  </div>
                  <div>
                    {t('settings.portalUsage.sharedStorage')}: {formatBytes(sharedStorage.used_bytes)} /{' '}
                    {formatBytes(sharedStorage.limit_bytes)}
                  </div>
                </>
              ) : (
                <div>{t('settings.portalUsage.storageUnavailable')}</div>
              )}
              {usage.providers.map((provider) => (
                <div key={provider.kind} className='text-t-2'>
                  {provider.label} {t('settings.portalUsage.dailyWindow')} {formatUSD(provider.daily.used_usd)}/
                  {formatUSD(provider.daily.limit_usd)} · {t('settings.portalUsage.weeklyWindow')}{' '}
                  {formatUSD(provider.weekly.used_usd)}/{formatUSD(provider.weekly.limit_usd)}
                </div>
              ))}
              {record.kimi_datasource?.enabled && (
                <div className='text-t-2'>
                  {t('settings.adminAccounts.kimiDatasource.remaining', {
                    dailyRemaining: Math.max(0, record.kimi_datasource.daily_limit - record.kimi_datasource.daily_used),
                    monthlyRemaining: Math.max(0, record.kimi_datasource.monthly_limit - record.kimi_datasource.monthly_used),
                  })}
                </div>
              )}
            </div>
          );
        },
      },
      {
        key: 'kimiDatasource',
        title: columnTitle('kimiDatasource', t('settings.adminAccounts.kimiDatasource.column')),
        width: columnWidths.kimiDatasource,
        render: (_, record) => {
          const policy = record.kimi_datasource;
          if (!policy?.enabled) {
            return <Tag color='gray'>{t('settings.adminAccounts.kimiDatasource.notGranted')}</Tag>;
          }
          return (
            <div className='flex flex-col gap-4px text-13px leading-20px'>
              <Tag color='arcoblue'>{t('settings.adminAccounts.kimiDatasource.granted')}</Tag>
              <Typography.Text type='secondary'>
                {t('settings.adminAccounts.kimiDatasource.sourcesCount', {
                  count: policy.allowed_sources.length,
                })}
              </Typography.Text>
              <Typography.Text type='secondary'>
                {t('settings.adminAccounts.kimiDatasource.usage', {
                  dailyRemaining: Math.max(0, policy.daily_limit - policy.daily_used),
                  monthlyRemaining: Math.max(0, policy.monthly_limit - policy.monthly_used),
                })}
              </Typography.Text>
            </div>
          );
        },
      },
      {
        key: 'createdAt',
        title: columnTitle('createdAt', t('settings.adminAccounts.createdAt')),
        dataIndex: 'created_at',
        width: columnWidths.createdAt,
        render: (value) => new Date(String(value)).toLocaleString(),
      },
      {
        key: 'lastLoginAt',
        title: columnTitle('lastLoginAt', t('settings.adminAccounts.lastLoginAt')),
        dataIndex: 'last_login_at',
        width: columnWidths.lastLoginAt,
        render: (value) =>
          value ? new Date(String(value)).toLocaleString() : t('settings.adminAccounts.neverLoggedIn'),
      },
      {
        key: 'actions',
        title: columnTitle('actions', t('settings.adminAccounts.actions')),
        width: columnWidths.actions,
        render: (_, record) => (
          <Space size='mini'>
            {record.enabled ? (
              <Button type='text' status='danger' onClick={() => disableUser(record)}>
                {t('settings.adminAccounts.disable')}
              </Button>
            ) : !record.offboarded ? (
              <Button type='text' onClick={() => enableUser(record)}>
                {t('settings.adminAccounts.enable')}
              </Button>
            ) : null}
            {!record.offboarded && (
              <>
                <Button type='text' onClick={() => setResetTarget(record)}>
                  {t('settings.adminAccounts.resetPassword')}
                </Button>
                <Button type='text' onClick={() => editKimiDatasource(record)}>
                  {t('settings.adminAccounts.kimiDatasource.manage')}
                </Button>
              </>
            )}
            <Button type='text' onClick={() => openLifecycle(record)}>
              {t('settings.adminAccounts.lifecycle.more')}
            </Button>
          </Space>
        ),
      },
    ],
    [columnTitle, columnWidths, kimiSources, t, usageLoading]
  );

  return (
    <div className='h-screen overflow-y-auto bg-bg-1 px-24px py-20px md:px-40px md:py-32px'>
      {modalContextHolder}
      <div className='mx-auto max-w-1200px'>
        <div className='mb-24px flex flex-wrap items-center justify-between gap-16px'>
          <div className='flex items-center gap-12px'>
            <div className='h-44px w-44px flex items-center justify-center rounded-12px bg-fill-2 text-22px text-t-1'>
              <Peoples theme='outline' size='22' fill='currentColor' />
            </div>
            <div>
              <Typography.Title heading={4} className='!m-0'>
                {t('settings.adminAccounts.title')}
              </Typography.Title>
              <Typography.Text type='secondary'>{t('settings.adminAccounts.subtitle')}</Typography.Text>
            </div>
          </div>
          <Space>
            <Typography.Text type='secondary'>{user?.username}</Typography.Text>
            <Button onClick={() => void logout()}>{t('settings.adminAccounts.logout')}</Button>
          </Space>
        </div>

        <Card bordered={false} className='rounded-16px'>
          <div className='mb-16px flex items-center justify-between gap-12px'>
            <Typography.Title heading={6} className='!m-0'>
              {t('settings.adminAccounts.accountList')}
            </Typography.Title>
            <Space>
              <Button icon={<Refresh theme='outline' size='14' />} loading={loading} onClick={() => void loadUsers()}>
                {t('settings.adminAccounts.refresh')}
              </Button>
              <Button type='primary' icon={<Plus theme='outline' size='14' />} onClick={() => setAddVisible(true)}>
                {t('settings.adminAccounts.add')}
              </Button>
            </Space>
          </div>
          <Table
            rowKey='username'
            columns={columns}
            data={users}
            loading={loading}
            pagination={false}
            noDataElement={<Empty description={t('settings.adminAccounts.empty')} />}
            scroll={{ x: Object.values(columnWidths).reduce((sum, width) => sum + width, 0) }}
            tableLayoutFixed
          />
        </Card>

        <AuditPanel />

        <MigrationPanel />

        <Card bordered={false} className='rounded-16px mt-20px'>
          <div className='mb-12px flex items-center justify-between gap-12px'>
            <div>
              <Typography.Title heading={6} className='!m-0'>{t('settings.skillsHub.marketTitle')}</Typography.Title>
              <Typography.Text type='secondary'>{t('settings.skillsHub.marketDescription')}</Typography.Text>
            </div>
            <Button icon={<Refresh theme='outline' size='14' />} loading={marketLoading} onClick={() => void loadMarket()}>{t('settings.adminAccounts.refresh')}</Button>
          </div>
          {marketSkills.length === 0 ? <Empty description={t('settings.skillsHub.marketEmpty')} /> : (
            <div className='flex flex-col divide-y divide-border-1'>
              {marketSkills.map((skill) => (
                <div key={skill.id} className='py-12px flex items-center gap-12px'>
                  <div className='flex-1 min-w-0'>
                    <Typography.Text bold>{skill.name}</Typography.Text>
                    <div className='text-12px text-t-secondary truncate'>{skill.description}</div>
                    <div className='text-11px text-t-tertiary'>{skill.publisher.display_name} (@{skill.publisher.username})</div>
                  </div>
                  {skill.can_delete && <Button status='danger' onClick={() => void deleteMarketSkill(skill)}>{t('common.delete')}</Button>}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Modal
        title={t('settings.adminAccounts.add')}
        visible={addVisible}
        onCancel={() => setAddVisible(false)}
        onOk={() => void createUser()}
        confirmLoading={creating}
        okText={t('settings.adminAccounts.create')}
        unmountOnExit
      >
        <div className='max-h-[calc(100vh-220px)] overflow-y-auto pr-4px'>
          <Typography.Paragraph type='secondary'>{t('settings.adminAccounts.addDescription')}</Typography.Paragraph>
          <Form form={form} layout='vertical'>
            <Form.Item
              field='username'
              label={t('settings.adminAccounts.username')}
              rules={[{ required: true }, { match: /^[A-Za-z0-9._-]{1,20}$/ }]}
            >
              <Input autoComplete='off' placeholder={t('settings.adminAccounts.usernamePlaceholder')} />
            </Form.Item>
            <Form.Item
              field='portalPassword'
              label={t('settings.adminAccounts.portalPassword')}
              rules={[{ required: true }, { minLength: 12, message: t('settings.adminAccounts.passwordTooShort') }]}
            >
              <Input.Password autoComplete='new-password' />
            </Form.Item>
            <Form.Item
              field='confirmPassword'
              label={t('settings.adminAccounts.confirmPassword')}
              rules={[{ required: true }]}
            >
              <Input.Password autoComplete='new-password' />
            </Form.Item>
          </Form>
        </div>
      </Modal>

      <Modal
        title={t('settings.adminAccounts.kimiDatasource.title', { username: kimiTarget?.username })}
        visible={Boolean(kimiTarget)}
        onCancel={() => {
          if (!savingKimi) {
            setKimiTarget(undefined);
            kimiForm.resetFields();
          }
        }}
        onOk={() => void saveKimiDatasource()}
        confirmLoading={savingKimi}
        okText={t('settings.adminAccounts.kimiDatasource.save')}
        unmountOnExit
      >
        <Typography.Paragraph type='secondary'>
          {t('settings.adminAccounts.kimiDatasource.description')}
        </Typography.Paragraph>
        <Form form={kimiForm} layout='vertical'>
          <Form.Item
            field='enabled'
            label={t('settings.adminAccounts.kimiDatasource.enabled')}
            triggerPropName='checked'
          >
            <Switch />
          </Form.Item>
          <Form.Item
            field='allowedSources'
            label={t('settings.adminAccounts.kimiDatasource.allowedSources')}
            rules={[{ required: true, type: 'array', minLength: 1 }]}
          >
            <Select mode='multiple' allowClear showSearch>
              {kimiSources.map((source) => (
                <Select.Option key={source} value={source}>
                  {source}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item
            field='dailyLimit'
            label={t('settings.adminAccounts.kimiDatasource.dailyLimit')}
            rules={[{ required: true, type: 'number', min: 1, max: 10000 }]}
          >
            <InputNumber min={1} max={10000} precision={0} />
          </Form.Item>
          <Form.Item
            field='monthlyLimit'
            label={t('settings.adminAccounts.kimiDatasource.monthlyLimit')}
            rules={[{ required: true, type: 'number', min: 1, max: 100000 }]}
          >
            <InputNumber min={1} max={100000} precision={0} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('settings.adminAccounts.lifecycle.title', { username: lifecycleTarget?.username })}
        visible={Boolean(lifecycleTarget)}
        onCancel={() => {
          if (!savingLifecycle) {
            setLifecycleTarget(undefined);
            lifecycleForm.resetFields();
          }
        }}
        onOk={() => void saveLifecycle()}
        confirmLoading={savingLifecycle}
        okButtonProps={lifecycleAction === 'offboard-delete' ? { status: 'danger' } : undefined}
        okText={t('settings.adminAccounts.lifecycle.apply')}
        unmountOnExit
      >
        <Typography.Paragraph type='secondary'>
          {t(`settings.adminAccounts.lifecycle.descriptions.${lifecycleAction}`, {
            username: lifecycleTarget?.username,
          })}
        </Typography.Paragraph>
        <Form form={lifecycleForm} layout='vertical'>
          <Form.Item field='action' label={t('settings.adminAccounts.lifecycle.action')} rules={[{ required: true }]}>
            <Select
              onChange={(value) => setLifecycleAction(value as EmployeeLifecycleAction)}
              disabled={savingLifecycle}
            >
              {!lifecycleTarget?.offboarded && (
                <>
                  <Select.Option value='set-limits'>{t('settings.adminAccounts.lifecycle.setLimits')}</Select.Option>
                  <Select.Option value='rename-windows'>
                    {t('settings.adminAccounts.lifecycle.renameWindows')}
                  </Select.Option>
                  <Select.Option value='offboard-retain'>
                    {t('settings.adminAccounts.lifecycle.offboardRetain')}
                  </Select.Option>
                </>
              )}
              <Select.Option value='repair'>{t('settings.adminAccounts.lifecycle.repair')}</Select.Option>
              {lifecycleTarget?.offboarded && (
                <Select.Option value='offboard-delete'>
                  {t('settings.adminAccounts.lifecycle.offboardDelete')}
                </Select.Option>
              )}
            </Select>
          </Form.Item>

          {lifecycleAction === 'set-limits' && (
            <div className='grid grid-cols-1 gap-12px md:grid-cols-3'>
              <Form.Item
                field='memoryMiB'
                label={t('settings.adminAccounts.lifecycle.memoryMiB')}
                rules={[{ required: true, type: 'number', min: 256 }]}
              >
                <InputNumber min={256} precision={0} className='w-full' />
              </Form.Item>
              <Form.Item
                field='cpuPercent'
                label={t('settings.adminAccounts.lifecycle.cpuPercent')}
                rules={[{ required: true, type: 'number', min: 1, max: 100 }]}
              >
                <InputNumber min={1} max={100} precision={0} className='w-full' />
              </Form.Item>
              <Form.Item
                field='activeProcesses'
                label={t('settings.adminAccounts.lifecycle.activeProcesses')}
                rules={[{ required: true, type: 'number', min: 3 }]}
              >
                <InputNumber min={3} precision={0} className='w-full' />
              </Form.Item>
            </div>
          )}

          {(lifecycleAction === 'repair' || lifecycleAction === 'rename-windows') && (
            <Form.Item
              field='windowsPassword'
              label={t('settings.adminAccounts.lifecycle.windowsPassword')}
              rules={[{ required: true }, { minLength: 12, message: t('settings.adminAccounts.passwordTooShort') }]}
            >
              <Input.Password autoComplete='new-password' />
            </Form.Item>
          )}

          {lifecycleAction === 'rename-windows' && (
            <Form.Item
              field='newWindowsUsername'
              label={t('settings.adminAccounts.lifecycle.newWindowsUsername')}
              rules={[{ required: true }, { match: /^[A-Za-z0-9._-]{1,20}$/ }]}
            >
              <Input autoComplete='off' placeholder={t('settings.adminAccounts.usernamePlaceholder')} />
            </Form.Item>
          )}

          {lifecycleAction === 'offboard-delete' && (
            <Form.Item
              field='confirmation'
              label={t('settings.adminAccounts.lifecycle.confirmation', {
                value: `DELETE ${lifecycleTarget?.username ?? ''}`,
              })}
              rules={[{ required: true }]}
            >
              <Input autoComplete='off' />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {creationJobs.length > 0 && (
        <div className='fixed bottom-24px right-24px z-1000 w-360px flex flex-col gap-12px'>
          {creationJobs.map((job) => (
            <Card key={job.id} bordered className='rounded-12px shadow-lg'>
              <div className='mb-8px flex items-center justify-between gap-8px'>
                <Typography.Text bold>
                  {t('settings.adminAccounts.creationProgress.title', { username: job.username })}
                </Typography.Text>
                <Button
                  type='text'
                  size='mini'
                  aria-label={t('common.close')}
                  icon={<CloseSmall theme='outline' size='14' />}
                  onClick={() => setCreationJobs((current) => current.filter(({ id }) => id !== job.id))}
                />
              </div>
              <Progress percent={job.percent} status={job.status === 'failed' ? 'error' : undefined} />
              <Typography.Text type={job.status === 'failed' ? 'error' : 'secondary'}>
                {job.status === 'failed' ? creationErrorText(job) : creationStepText(job.step)}
              </Typography.Text>
            </Card>
          ))}
        </div>
      )}

      <Modal
        title={t('settings.adminAccounts.resetPasswordTitle')}
        visible={Boolean(resetTarget)}
        onCancel={() => {
          if (!resetting) {
            setResetTarget(undefined);
            resetForm.resetFields();
          }
        }}
        onOk={() => void resetPassword()}
        confirmLoading={resetting}
        okText={t('settings.adminAccounts.resetPassword')}
        unmountOnExit
      >
        <Typography.Paragraph type='secondary'>
          {t('settings.adminAccounts.resetPasswordDescription', {
            username: resetTarget?.username,
          })}
        </Typography.Paragraph>
        <Form form={resetForm} layout='vertical'>
          <Form.Item
            field='portalPassword'
            label={t('settings.adminAccounts.newPortalPassword')}
            rules={[{ required: true }, { minLength: 12, message: t('settings.adminAccounts.passwordTooShort') }]}
          >
            <Input.Password autoComplete='new-password' />
          </Form.Item>
          <Form.Item
            field='confirmPassword'
            label={t('settings.adminAccounts.confirmPassword')}
            rules={[{ required: true }]}
          >
            <Input.Password autoComplete='new-password' />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default AdminAccountsPage;
