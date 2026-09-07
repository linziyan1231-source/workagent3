import { useEffect, useState, type FormEvent } from "react";
import {
  authPort,
  type AuthUser,
  type ChangePasswordErrorCode,
} from "./authPort.js";
import { ApiError } from "../../shared/api/http.js";
import zhCN from "./locales/zh-CN.json";
import "./LoginPage.css";

const locales = import.meta.glob<typeof zhCN>("./locales/*.json", {
  eager: true,
  import: "default",
});
const languages = [
  ["zh-CN", "简体中文"],
  ["zh-TW", "繁體中文"],
  ["ja-JP", "日本語"],
  ["ko-KR", "한국어"],
  ["tr-TR", "Türkçe"],
  ["uk-UA", "Українська"],
  ["pt-BR", "Português (BR)"],
  ["de-DE", "Deutsch"],
  ["es-ES", "Español"],
  ["fa-IR", "فارسی"],
  ["en-US", "English"],
];
const usernameKey = "workagent.login.username";
const languageKey = "workagent.login.language";

function Field({
  name,
  label,
  placeholder,
  password = false,
  value,
  onChange,
  autoComplete,
}: {
  name: string;
  label: string;
  placeholder: string;
  password?: boolean;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
}) {
  return (
    <div className="login-page__form-item">
      <label className="login-page__label" htmlFor={name}>
        {label}
      </label>
      <div className="login-page__input-wrapper">
        <svg
          className="login-page__input-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          {name === "username" ? (
            <>
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </>
          ) : (
            <>
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </>
          )}
        </svg>
        <input
          id={name}
          name={name}
          className="login-page__input"
          type={password ? "password" : "text"}
          placeholder={placeholder}
          autoComplete={autoComplete}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
        />
      </div>
    </div>
  );
}

export function LoginPage({
  onAuthenticated,
}: {
  onAuthenticated: (user: AuthUser) => void;
}) {
  const [language, setLanguage] = useState(
    () => localStorage.getItem(languageKey) ?? "zh-CN",
  );
  const t = locales[`./locales/${language}.json`] ?? zhCN;
  const [username, setUsername] = useState(
    () => localStorage.getItem(usernameKey) ?? "",
  );
  const [remember, setRemember] = useState(
    () => !!localStorage.getItem(usernameKey),
  );
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [changing, setChanging] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    success?: boolean;
  } | null>(null);

  useEffect(() => {
    document.title = changing ? t.changePassword.pageTitle : t.pageTitle;
    document.documentElement.lang = language;
    return () => {
      document.title = "WorkAgent";
    };
  }, [language, t, changing]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setMessage(null);
    if (!username.trim() || !password) {
      setMessage({ text: t.errors.empty });
      return;
    }
    setBusy(true);
    try {
      if (changing) {
        if (newPassword !== confirmation) {
          setMessage({ text: t.changePassword.errors.mismatch });
          return;
        }
        const result = await authPort.changePassword({
          username: username.trim(),
          currentPassword: password,
          newPassword,
          confirmPassword: confirmation,
        });
        if (!result.success) {
          const keys: Record<
            ChangePasswordErrorCode,
            keyof typeof t.changePassword.errors
          > = {
            requiredFields: "required",
            passwordMismatch: "mismatch",
            invalidCurrentPassword: "invalidCurrentPassword",
            passwordPolicy: "passwordPolicy",
            passwordReused: "passwordReused",
            tooManyAttempts: "tooManyAttempts",
            serverError: "serverError",
            networkError: "networkError",
            securityError: "securityError",
            unknown: "unknown",
          };
          setMessage({
            text: t.changePassword.errors[keys[result.code ?? "unknown"]],
          });
          return;
        }
        setChanging(false);
        setPassword("");
        setNewPassword("");
        setConfirmation("");
        setMessage({ text: t.changePassword.success, success: true });
        return;
      }
      const user = await authPort.login(username.trim(), password);
      if (remember) localStorage.setItem(usernameKey, username.trim());
      else localStorage.removeItem(usernameKey);
      if (!user.admin) {
        window.location.replace("/?frontend=dsh");
        return;
      }
      onAuthenticated(user);
    } catch (error) {
      const text =
        error instanceof ApiError
          ? error.status === 429
            ? t.errors.tooManyAttempts
            : error.status >= 500
              ? t.errors.serverError
              : t.errors.invalidCredentials
          : t.errors.networkError;
      setMessage({ text });
    } finally {
      setBusy(false);
    }
  };

  const switchMode = () => {
    setChanging(!changing);
    setMessage(null);
    setPassword("");
    setNewPassword("");
    setConfirmation("");
    setVisible(false);
  };

  return (
    <main className="login-page">
      <div
        className={`login-page__card${changing ? " login-page__card--change-password" : ""}`}
      >
        <label
          className="login-page__lang-select-wrapper"
          htmlFor="lang-select"
        >
          <select
            id="lang-select"
            className="login-page__lang-select"
            aria-label={t.languageToggle}
            value={language}
            onChange={(event) => {
              setLanguage(event.target.value);
              localStorage.setItem(languageKey, event.target.value);
            }}
          >
            {languages.map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="login-page__header">
          <h1 className="login-page__title">WorkAgent</h1>
          <p className="login-page__subtitle">
            {changing ? t.changePassword.subtitle : t.subtitle}
          </p>
        </div>
        <form
          className="login-page__form"
          onSubmit={(event) => void submit(event)}
        >
          <Field
            name="username"
            label={t.username}
            placeholder={t.usernamePlaceholder}
            value={username}
            onChange={setUsername}
            autoComplete="username"
          />
          <div className="login-page__form-item">
            <label className="login-page__label" htmlFor="password">
              {changing ? t.changePassword.currentPassword : t.password}
            </label>
            <div className="login-page__input-wrapper">
              <svg
                className="login-page__input-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <input
                id="password"
                name="password"
                type={visible ? "text" : "password"}
                className="login-page__input"
                placeholder={
                  changing
                    ? t.changePassword.currentPasswordPlaceholder
                    : t.passwordPlaceholder
                }
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <button
                type="button"
                className="login-page__toggle-password"
                aria-label={visible ? t.hidePassword : t.showPassword}
                aria-pressed={visible}
                onClick={() => setVisible(!visible)}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                  {visible && <path d="m1 1 22 22" />}
                </svg>
              </button>
            </div>
          </div>
          {changing ? (
            <>
              <Field
                name="new-password"
                label={t.changePassword.newPassword}
                placeholder={t.changePassword.newPasswordPlaceholder}
                password
                value={newPassword}
                onChange={setNewPassword}
                autoComplete="new-password"
              />
              <Field
                name="confirm-password"
                label={t.changePassword.confirmPassword}
                placeholder={t.changePassword.confirmPasswordPlaceholder}
                password
                value={confirmation}
                onChange={setConfirmation}
                autoComplete="new-password"
              />
              <p className="login-page__password-requirement">
                {t.changePassword.requirement}
              </p>
            </>
          ) : (
            <div className="login-page__options">
              <div className="login-page__checkbox">
                <input
                  id="remember-me"
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => {
                    setRemember(event.target.checked);
                    if (!event.target.checked)
                      localStorage.removeItem(usernameKey);
                  }}
                />
                <label htmlFor="remember-me">{t.rememberMe}</label>
              </div>
              <button
                type="button"
                className="login-page__change-password-link"
                onClick={switchMode}
                disabled={busy}
              >
                {t.changePassword.link}
              </button>
            </div>
          )}
          <button type="submit" className="login-page__submit" disabled={busy}>
            {busy && (
              <svg
                className="login-page__spinner"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="3"
                  fill="none"
                  strokeDasharray="50"
                  strokeDashoffset="25"
                  strokeLinecap="round"
                />
              </svg>
            )}
            <span>
              {busy
                ? t.submitting
                : changing
                  ? t.changePassword.submit
                  : t.submit}
            </span>
          </button>
          {message && (
            <div
              role="alert"
              aria-live="polite"
              className={`login-page__message login-page__message--visible login-page__message--${message.success ? "success" : "error"}`}
            >
              {message.text}
            </div>
          )}
          {changing && (
            <div className="login-page__back-link-row">
              <button
                type="button"
                className="login-page__back-link"
                onClick={switchMode}
                disabled={busy}
              >
                {t.changePassword.backToLogin}
              </button>
            </div>
          )}
        </form>
        <div className="login-page__footer">
          <div className="login-page__footer-content">
            <span>{t.footerPrimary}</span>
            <span className="login-page__footer-divider">•</span>
            <span>{t.footerSecondary}</span>
          </div>
        </div>
      </div>
    </main>
  );
}
