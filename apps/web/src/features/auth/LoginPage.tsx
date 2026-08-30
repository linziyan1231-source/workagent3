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
      <form className="login-card" onSubmit={submit}>
        <select
          className="language-select"
          aria-label="Language"
          defaultValue="en"
        >
          <option value="en">English</option>
          <option value="zh-CN">简体中文</option>
        </select>
        <div className="login-brand-mark" aria-hidden="true">
          WA
        </div>
        <h1>WorkAgent</h1>
        <p className="login-welcome">Welcome back. Sign in to your account.</p>
        <label>
          Username
          <span className="login-input">
            <span aria-hidden="true">♙</span>
            <input
              name="username"
              autoComplete="username"
              placeholder="Enter your username"
              required
              autoFocus
            />
          </span>
        </label>
        <label>
          Password
          <span className="login-input">
            <span aria-hidden="true">▢</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Enter your password"
              required
            />
          </span>
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="privacy-note">
          Secure personal workspace · Ready in your browser
        </p>
      </form>
    </main>
  );
}
