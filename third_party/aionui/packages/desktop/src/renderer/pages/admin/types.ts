import type { PortalManagedUser, PortalProvisionJob } from '@/common/adapter/ipcBridge';

export type ManagedUser = PortalManagedUser;
export type CreationJob = PortalProvisionJob;

export interface AddManagedUserForm {
  username: string;
  portalPassword: string;
  confirmPassword: string;
}

export interface ResetManagedUserPasswordForm {
  portalPassword: string;
  confirmPassword: string;
}

export interface KimiDatasourcePolicyForm {
  enabled: boolean;
  allowedSources: string[];
  dailyLimit: number;
  monthlyLimit: number;
}

export type EmployeeLifecycleAction =
  | 'set-limits'
  | 'repair'
  | 'rename-windows'
  | 'offboard-retain'
  | 'offboard-delete';

export interface EmployeeLifecycleForm {
  action: EmployeeLifecycleAction;
  windowsPassword?: string;
  newWindowsUsername?: string;
  memoryMiB?: number;
  cpuPercent?: number;
  activeProcesses?: number;
  confirmation?: string;
}

export interface AuditFilterForm {
  actor: string;
  action: string;
  target: string;
  from: string;
  to: string;
  limit: number;
}

export interface MigrationFilterForm {
  sid: string;
  status: '' | 'needs_auth' | 'needs_review';
}
