import { FormEvent, useEffect, useState } from "react";
import { authPort, type AuthUser } from "../features/auth/authPort.js";
import { OAuthCallbackPage } from "../features/mcp/OAuthCallbackPage.js";
import { requestJson } from "../shared/api/http.js";

type PortalUser = {
  username: string;
  windows_username: string;
  enabled: boolean;
  offboarded: boolean;
};

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
      <Login onAuthenticated={(authenticated) => setUser(authenticated)} />
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
      {user.admin ? (
        <AdminUsers />
      ) : (
        <section className="panel">
          <h1>WorkAgent has moved</h1>
          <p>The official DSH client is now the employee workspace.</p>
          <a className="primary" href="/?frontend=dsh">
            Continue to WorkAgent
          </a>
        </section>
      )}
    </main>
  );
}

function Login({
  onAuthenticated,
}: {
  onAuthenticated: (user: AuthUser) => void;
}) {
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    try {
      const user = await authPort.login(
        String(values.get("username") ?? ""),
        String(values.get("password") ?? ""),
      );
      if (!user.admin) {
        window.location.replace("/?frontend=dsh");
        return;
      }
      onAuthenticated(user);
    } catch {
      setError("Invalid username or password");
    }
  };
  return (
    <main className="centered">
      <form className="panel login" onSubmit={(event) => void submit(event)}>
        <h1>WorkAgent</h1>
        <label>
          Username
          <input name="username" autoComplete="username" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <button className="primary" type="submit">
          Sign in
        </button>
      </form>
    </main>
  );
}

function AdminUsers() {
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    void requestJson<PortalUser[] | { users: PortalUser[] }>(
      "/api/portal/admin/users",
    )
      .then((value) => setUsers(Array.isArray(value) ? value : value.users))
      .catch((reason) => setError(String(reason)));
  }, []);
  return (
    <section className="panel">
      <h1>Account management</h1>
      {error ? <p role="alert">{error}</p> : null}
      <table>
        <thead>
          <tr>
            <th>Username</th>
            <th>Windows account</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {users.map((entry) => (
            <tr key={entry.username}>
              <td>{entry.username}</td>
              <td>{entry.windows_username}</td>
              <td>
                {entry.offboarded
                  ? "Offboarded"
                  : entry.enabled
                    ? "Enabled"
                    : "Disabled"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
