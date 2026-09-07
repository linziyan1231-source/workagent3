import { useEffect, useState } from "react";
import { authPort, type AuthUser } from "../features/auth/authPort.js";
import { OAuthCallbackPage } from "../features/mcp/OAuthCallbackPage.js";

import { AdminPortal } from "../features/admin/AdminPortal.js";
import { LoginPage } from "../features/auth/LoginPage.js";

export function App() {
  if (window.location.pathname === "/oauth/mcp/callback")
    return <OAuthCallbackPage />;
  return <PortalShell />;
}

function PortalShell() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [error, setError] = useState("");

  useEffect(() => {
    void authPort
      .currentUser()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) return <main className="centered">Loading…</main>;
  if (user === null)
    return (
      <LoginPage onAuthenticated={(authenticated) => setUser(authenticated)} />
    );

  if (user.admin)
    return (
      <AdminPortal
        username={user.username}
        onLogout={() => authPort.logout().then(() => setUser(null))}
      />
    );
  return (
    <main className="shell">
      <header>
        <div>
          <strong>WorkAgent</strong>
          <span>Portal</span>
        </div>
        <nav>
          <a href="/?frontend=dsh">Open WorkAgent</a>
          <button
            type="button"
            onClick={() =>
              void authPort
                .logout()
                .then(() => setUser(null))
                .catch((reason) => setError(String(reason)))
            }
          >
            Log out
          </button>
        </nav>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {
        <section className="panel">
          <h1>WorkAgent has moved</h1>
          <p>The official DSH client is now the employee workspace.</p>
          <a className="primary" href="/?frontend=dsh">
            Continue to WorkAgent
          </a>
        </section>
      }
    </main>
  );
}
