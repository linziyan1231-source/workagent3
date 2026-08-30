import { useEffect, useState } from "react";
import { authPort, type AuthUser } from "../features/auth/authPort.js";
import { LoginPage } from "../features/auth/LoginPage.js";
import { ConversationPage } from "../features/conversation/ConversationPage.js";
import { WorkspacePanel } from "../features/workspace/WorkspacePanel.js";
import { workspacePort } from "../features/workspace/workspacePort.js";
import { presetPort } from "../features/presets/presetPort.js";
import { mcpPort } from "../features/mcp/mcpPort.js";
import { skillPort } from "../features/skills/skillPort.js";
import { automationPort } from "../features/automation/automationPort.js";
import { OAuthCallbackPage } from "../features/mcp/OAuthCallbackPage.js";

const workspaceAssets = {
  list: workspacePort.assets,
  attach: workspacePort.attach,
  downloadUrl: workspacePort.downloadUrl,
};

const capabilities = {
  skills: skillPort.list,
  mcpServers: mcpPort.list,
};

export function App() {
  if (window.location.pathname === "/oauth/mcp/callback") {
    return <OAuthCallbackPage />;
  }
  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [workspaceId, setWorkspaceId] = useState<string>();

  useEffect(() => {
    void authPort
      .currentUser()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) {
    return <div className="app-loading">Opening your workspace…</div>;
  }
  if (user === null) {
    return (
      <LoginPage
        onLogin={async (username, password) => {
          setUser(await authPort.login(username, password));
        }}
      />
    );
  }
  return (
    <ConversationPage
      user={user}
      workspaceId={workspaceId}
      onWorkspaceSelect={setWorkspaceId}
      assetPort={workspaceAssets}
      presetPort={presetPort}
      capabilityPort={capabilities}
      automationPort={automationPort}
      workspacePanel={
        <WorkspacePanel selectedId={workspaceId} onSelect={setWorkspaceId} />
      }
      onLogout={async () => {
        await authPort.logout();
        setUser(null);
      }}
    />
  );
}
