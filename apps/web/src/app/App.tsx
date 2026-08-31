import { useEffect, useState } from "react";
import Layout from "@renderer/components/layout/Layout";
import Router from "@renderer/components/layout/Router";
import Sider from "@renderer/components/layout/Sider";
import PortalNotificationHost from "@renderer/components/layout/PortalNotificationHost";
import AppLoader from "@renderer/components/layout/AppLoader";
import { ConversationHistoryProvider } from "@renderer/hooks/context/ConversationHistoryContext";
import { authPort, type AuthUser } from "../features/auth/authPort.js";
import { OAuthCallbackPage } from "../features/mcp/OAuthCallbackPage.js";
import { WorkAgentAuthProvider } from "../shared/aion-adapter/authContext.js";
import { hydrateRendererAppearance } from "../shared/aion-adapter/appearance.js";

export function App() {
  if (window.location.pathname === "/oauth/mcp/callback") {
    return <OAuthCallbackPage />;
  }
  return <AuthenticatedRenderer />;
}

/**
 * WorkAgent3 owns authentication and transport only. The visible application
 * tree is the managed WorkAgent2 Web 78/AionUi Renderer tree, kept intact so its
 * layout, routes, settings pages and interaction states stay upstream-owned.
 */
function AuthenticatedRenderer() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);

  useEffect(() => {
    void authPort
      .currentUser()
      .then(async (current) => {
        await hydrateRendererAppearance().catch((error) =>
          console.error("hydrate Renderer appearance failed", error),
        );
        setUser(current);
      })
      .catch(() => setUser(null));
  }, []);

  const logout = async () => {
    await authPort.logout();
    setUser(null);
  };

  if (user === undefined) return <AppLoader />;

  return (
    <WorkAgentAuthProvider
      user={user === null || user === undefined ? undefined : user}
      login={async ({ username, password }) => {
        try {
          const authenticated = await authPort.login(username, password);
          await hydrateRendererAppearance().catch((error) =>
            console.error("hydrate Renderer appearance failed", error),
          );
          setUser(authenticated);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            code: "invalidCredentials",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }}
      changePassword={authPort.changePassword}
      logout={logout}
      refresh={async () => setUser(await authPort.currentUser())}
    >
      <PortalNotificationHost />
      <Router
        layout={
          <ConversationHistoryProvider>
            <Layout sider={<Sider />} />
          </ConversationHistoryProvider>
        }
      />
    </WorkAgentAuthProvider>
  );
}
