export const shouldShowUserCollaboration = (
  collaborationEnabled: boolean | undefined,
  electronDesktop: boolean
): boolean => !electronDesktop && collaborationEnabled === true;
