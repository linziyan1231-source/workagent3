import { type FormEvent, useState } from "react";
import { ApiError } from "../../shared/api/http.js";
import { BrandLogo } from "../../shared/ui/aionui/BrandLogo.js";

type Props = {
  onLogin: (username: string, password: string) => Promise<void>;
};

export function LoginPage({ onLogin }: Props) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);

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
      <div className="login-page__card">
        <label className="login-page__lang-select-wrapper">
          <select
            className="login-page__lang-select"
            aria-label="Language"
            defaultValue="en-US"
          >
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
          </select>
        </label>
        <div className="login-page__header">
          <div className="login-page__logo">
            <BrandLogo size={64} />
          </div>
          <h1 className="login-page__title">WorkAgent</h1>
          <p className="login-page__subtitle">
            Sign in to your personal AI workspace
          </p>
        </div>
        <form className="login-page__form" onSubmit={submit}>
          <div className="login-page__form-item">
            <label className="login-page__label" htmlFor="username">
              Username
            </label>
            <div className="login-page__input-wrapper">
              <svg
                className="login-page__input-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              <input
                id="username"
                name="username"
                className="login-page__input"
                autoComplete="username"
                placeholder="Enter your username"
                required
                autoFocus
              />
            </div>
          </div>
          <div className="login-page__form-item">
            <label className="login-page__label" htmlFor="password">
              Password
            </label>
            <div className="login-page__input-wrapper">
              <svg
                className="login-page__input-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <input
                id="password"
                name="password"
                type={passwordVisible ? "text" : "password"}
                className="login-page__input"
                autoComplete="current-password"
                placeholder="Enter your password"
                required
              />
              <button
                type="button"
                className="login-page__toggle-password"
                onClick={() => setPasswordVisible((value) => !value)}
                aria-label={passwordVisible ? "Hide password" : "Show password"}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            </div>
          </div>
          <div className="login-page__options">
            <div className="login-page__checkbox">
              <input type="checkbox" id="remember-me" />
              <label htmlFor="remember-me">Keep me signed in</label>
            </div>
            <button className="login-page__text-link" type="button" disabled>
              Change password
            </button>
          </div>
          <div
            role="alert"
            className={`login-page__message ${error ? "login-page__message--visible login-page__message--error" : ""}`}
            hidden={!error}
          >
            {error}
          </div>
          <button type="submit" className="login-page__submit" disabled={busy}>
            {busy && (
              <span className="login-page__spinner" aria-hidden="true" />
            )}
            <span>{busy ? "Signing in…" : "Sign in"}</span>
          </button>
        </form>
        <div className="login-page__footer">
          <div className="login-page__footer-content">
            <span>Private by Windows SID</span>
            <span>•</span>
            <span>Secure browser session</span>
          </div>
        </div>
      </div>
    </main>
  );
}
