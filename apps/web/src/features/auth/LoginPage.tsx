import { type FormEvent, useState } from "react";
import { ApiError } from "../../shared/api/http.js";

type Props = {
  onLogin: (username: string, password: string) => Promise<void>;
};

export function LoginPage({ onLogin }: Props) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await onLogin(String(form.get("username")), String(form.get("password")));
    } catch (reason) {
      setError(
        reason instanceof ApiError && reason.code === "invalid_credentials"
          ? "The username or password is incorrect."
          : "WorkAgent could not sign you in. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-story" aria-label="WorkAgent introduction">
        <div className="brand-mark">WA</div>
        <p className="eyebrow">Your work, in motion</p>
        <h1>A focused place for people and agents to get things done.</h1>
        <p className="login-copy">
          Continue projects, review decisions, and move work forward from one
          secure workspace.
        </p>
        <div className="orbit" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </section>
      <section className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <p className="eyebrow">Welcome back</p>
          <h2>Sign in to WorkAgent</h2>
          <label>
            Username
            <input name="username" autoComplete="username" required autoFocus />
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
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" disabled={busy}>
            {busy ? "Signing in…" : "Continue"}
          </button>
          <p className="privacy-note">
            Your password is sent only to this WorkAgent server and is never
            stored in the browser.
          </p>
        </form>
      </section>
    </main>
  );
}
