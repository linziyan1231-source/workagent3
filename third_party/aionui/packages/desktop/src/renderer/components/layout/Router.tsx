import React, { Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Message } from '@arco-design/web-react';
import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import AppLoader from '@renderer/components/layout/AppLoader';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import { TEAM_MODE_ENABLED } from '@/common/config/constants';
import { useTranslation } from 'react-i18next';
const Conversation = React.lazy(() => import('@renderer/pages/conversation'));
const Guid = React.lazy(() => import('@renderer/pages/guid'));
const AgentSettings = React.lazy(() => import('@renderer/pages/settings/AgentSettings'));
const AgentRepairPage = React.lazy(() => import('@renderer/pages/settings/AgentSettings/AgentRepairPage'));
const AssistantSettings = React.lazy(() => import('@renderer/pages/settings/AssistantSettings'));
const CapabilitiesSettings = React.lazy(() => import('@renderer/pages/settings/CapabilitiesSettings'));
const AppearanceSettings = React.lazy(() => import('@renderer/pages/settings/AppearanceSettings'));
const ModeSettings = React.lazy(() => import('@renderer/pages/settings/ModeSettings'));
const SystemSettings = React.lazy(() => import('@renderer/pages/settings/SystemSettings'));
const WebuiSettings = React.lazy(() => import('@renderer/pages/settings/WebuiSettings'));
const PetSettings = React.lazy(() => import('@renderer/pages/settings/PetSettings'));
const ExtensionSettingsPage = React.lazy(() => import('@renderer/pages/settings/ExtensionSettingsPage'));
const PricingPage = React.lazy(() => import('@renderer/pages/PricingPage'));
const HelpPage = React.lazy(() => import('@renderer/pages/HelpPage'));
const LoginPage = React.lazy(() => import('@renderer/pages/login'));
const ChangePasswordPage = React.lazy(() => import('@renderer/pages/login/ChangePasswordPage'));
const ComponentsShowcase = React.lazy(() => import('@renderer/pages/TestShowcase'));
const ScheduledTasksPage = React.lazy(() => import('@renderer/pages/cron/ScheduledTasksPage'));
const TaskDetailPage = React.lazy(() => import('@renderer/pages/cron/ScheduledTasksPage/TaskDetailPage'));
const TeamIndex = React.lazy(() => import('@renderer/pages/team'));
const AdminAccountsPage = React.lazy(() => import('@renderer/pages/admin'));

const withRouteFallback = (Component: React.LazyExoticComponent<React.ComponentType>) => (
  <Suspense fallback={<AppLoader />}>
    <Component />
  </Suspense>
);

const ProtectedLayout: React.FC<{ layout: React.ReactElement }> = ({ layout }) => {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === 'checking') {
    return <AppLoader />;
  }

  if (status !== 'authenticated') {
    return <Navigate to='/login' replace state={{ returnTo: `${location.pathname}${location.search}` }} />;
  }

  if (user?.admin) {
    return <Navigate to='/admin/accounts' replace />;
  }

  return React.cloneElement(layout);
};

const SharedInviteLinkRoute: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  React.useEffect(() => {
    if (!token) return;
    void ipcBridge.portal.acceptSharedInviteLink.invoke({ token }).then(
      () => {
        ipcBridge.conversation.listChanged.emit({
          conversation_id: `shared-invite:${token}`,
          action: 'created',
          source: 'shared-invite-link',
        });
        Message.success(t('team.create.inviteLinkAccepted', { defaultValue: 'Joined shared project' }));
        void navigate('/guid', { replace: true });
      },
      (error: unknown) => {
        const code = isBackendHttpError(error) ? error.code : '';
        const key =
          code === 'shared_invite_expired'
            ? 'team.create.inviteLinkExpired'
            : code === 'shared_invite_link_revoked'
              ? 'team.create.inviteLinkRevoked'
              : code === 'shared_invite_link_exhausted'
                ? 'team.create.inviteLinkExhausted'
                : code === 'shared_invite_link_not_found'
                  ? 'team.create.inviteLinkInvalid'
                  : 'team.create.inviteLinkAcceptFailed';
        Message.error(
          t(key, {
            defaultValue: 'This invite link is invalid, expired, or already used by you',
          })
        );
        void navigate('/guid', { replace: true });
      }
    );
  }, [navigate, t, token]);
  return <AppLoader />;
};

const AuthenticatedHomeRedirect: React.FC<{ fallback: string }> = ({ fallback }) => {
  const location = useLocation();
  const returnTo = (location.state as { returnTo?: unknown } | null)?.returnTo;
  return <Navigate to={typeof returnTo === 'string' && returnTo.startsWith('/') ? returnTo : fallback} replace />;
};

const AdminRoute: React.FC = () => {
  const { status, user } = useAuth();

  if (status === 'checking') return <AppLoader />;
  if (status !== 'authenticated') return <Navigate to='/login' replace />;
  if (!user?.admin) return <Navigate to='/guid' replace />;
  return withRouteFallback(AdminAccountsPage);
};

const PanelRoute: React.FC<{ layout: React.ReactElement }> = ({ layout }) => {
  const { status, user } = useAuth();
  const homePath = user?.admin ? '/admin/accounts' : '/guid';

  return (
    <HashRouter>
      <Routes>
        <Route
          path='/login'
          element={
            status === 'authenticated' ? (
              <AuthenticatedHomeRedirect fallback={homePath} />
            ) : (
              withRouteFallback(LoginPage)
            )
          }
        />
        <Route
          path='/change-password'
          element={
            status === 'authenticated' ? <Navigate to={homePath} replace /> : withRouteFallback(ChangePasswordPage)
          }
        />
        <Route path='/admin/accounts' element={<AdminRoute />} />
        <Route element={<ProtectedLayout layout={layout} />}>
          <Route index element={<Navigate to='/guid' replace />} />
          <Route path='/guid' element={withRouteFallback(Guid)} />
          <Route path='/shared-invite/:token' element={<SharedInviteLinkRoute />} />
          <Route path='/conversation/:id' element={withRouteFallback(Conversation)} />
          <Route
            path='/team/:id'
            element={TEAM_MODE_ENABLED ? withRouteFallback(TeamIndex) : <Navigate to='/guid' replace />}
          />
          <Route path='/settings/model' element={withRouteFallback(ModeSettings)} />
          <Route path='/assistants' element={withRouteFallback(AssistantSettings)} />
          {/* Assistants moved out of Settings to a top-level entry; keep a redirect
              so old deep links / back-nav still land on the new page. */}
          <Route path='/settings/assistants' element={<Navigate to='/assistants' replace />} />
          <Route path='/settings/agent' element={withRouteFallback(AgentSettings)} />
          <Route path='/settings/agent/:id/repair' element={withRouteFallback(AgentRepairPage)} />
          <Route path='/settings/capabilities' element={withRouteFallback(CapabilitiesSettings)} />
          <Route
            path='/settings/capabilities/skills/import-history'
            element={withRouteFallback(CapabilitiesSettings)}
          />
          {/* Legacy routes — redirect to the merged /settings/capabilities page */}
          <Route path='/settings/skills-hub' element={<Navigate to='/settings/capabilities?tab=skills' replace />} />
          <Route path='/settings/tools' element={<Navigate to='/settings/capabilities?tab=tools' replace />} />
          <Route path='/settings/appearance' element={withRouteFallback(AppearanceSettings)} />
          <Route path='/settings/display' element={<Navigate to='/settings/appearance' replace />} />
          <Route path='/settings/webui' element={withRouteFallback(WebuiSettings)} />
          <Route path='/settings/pet' element={withRouteFallback(PetSettings)} />
          <Route path='/settings/system' element={withRouteFallback(SystemSettings)} />
          <Route path='/settings/about' element={withRouteFallback(SystemSettings)} />
          <Route path='/settings/ext/:tabId' element={withRouteFallback(ExtensionSettingsPage)} />
          <Route path='/settings' element={<Navigate to='/settings/model' replace />} />
          <Route path='/pricing' element={withRouteFallback(PricingPage)} />
          <Route path='/help' element={withRouteFallback(HelpPage)} />
          <Route path='/test/components' element={withRouteFallback(ComponentsShowcase)} />
          <Route path='/scheduled' element={withRouteFallback(ScheduledTasksPage)} />
          <Route path='/scheduled/:job_id' element={withRouteFallback(TaskDetailPage)} />
        </Route>
        <Route path='*' element={<Navigate to={status === 'authenticated' ? homePath : '/login'} replace />} />
      </Routes>
    </HashRouter>
  );
};

export default PanelRoute;
