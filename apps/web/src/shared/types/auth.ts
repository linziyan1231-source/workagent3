export type AuthUser = {
  id: number;
  username: string;
  display_name: string;
  disabled: boolean;
  admin: boolean;
  collaboration_enabled: boolean;
  collaboration_capable: boolean;
};
