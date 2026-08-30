import { useEffect, useState } from "react";
import { authPort, type AuthUser } from "../features/auth/authPort.js";
import { LoginPage } from "../features/auth/LoginPage.js";
import { ConversationPage } from "../features/conversation/ConversationPage.js";

export function App() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);

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
      onLogout={async () => {
        await authPort.logout();
        setUser(null);
      }}
    />
  );
}
