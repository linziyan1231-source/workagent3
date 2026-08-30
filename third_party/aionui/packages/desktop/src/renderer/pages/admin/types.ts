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
