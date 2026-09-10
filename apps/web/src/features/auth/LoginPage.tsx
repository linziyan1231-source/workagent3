import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  authPort,
  type AuthUser,
  type ChangePasswordErrorCode,
} from "./authPort.js";
import { ApiError } from "../../shared/api/http.js";
import zhCN from "./locales/zh-CN.json";
import "./LoginPage.css";
import { usePasswordVisibility } from "./usePasswordVisibility.js";

const usernameKey = "workagent.login.username";

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
  const t = zhCN;
  const [username, setUsername] = useState(
    () => localStorage.getItem(usernameKey) ?? "",
  );
  const [remember, setRemember] = useState(
    () => !!localStorage.getItem(usernameKey),
  );
  const [password, setPassword] = useState("");
  const [savedUsername, setSavedUsername] = useState<string | null>(null);
  const edited = useRef(false);
  const savedEdit = useRef<{ start: number; end: number } | null>(null);
  const { inputRef, canReveal, visible, toggle } = usePasswordVisibility(
    password,
    setPassword,
  );
  const [changing, setChanging] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    text: string;
    success?: boolean;
  } | null>(null);

  const savedPassword =
    !changing &&
    savedUsername !== null &&
    username.trim().toLowerCase() === savedUsername.toLowerCase();

  useEffect(() => {
    if (!savedPassword) return;
    const input = inputRef.current!;
    // Preserve the native edit (including Safari/mobile input), then discard
    // placeholder characters around it. Deletion clears the whole credential.
    const beginEdit = (event: InputEvent) => {
      savedEdit.current = {
        start: input.selectionStart ?? 0,
        end: input.selectionEnd ?? input.value.length,
      };
      if (event.inputType.startsWith("delete")) {
        event.preventDefault();
        input.value = "";
        edited.current = true;
        setSavedUsername(null);
        setPassword("");
      }
    };
    const finishEdit = () => {
      let value = input.value;
      if (savedEdit.current) {
        const { start, end } = savedEdit.current;
        value = value.slice(start, value.length - (8 - end));
      }
      savedEdit.current = null;
      input.value = value;
      edited.current = true;
      setSavedUsername(null);
      setPassword(value);
    };
    input.addEventListener("beforeinput", beginEdit, true);
    input.addEventListener("input", finishEdit, true);
    return () => {
      input.removeEventListener("beforeinput", beginEdit, true);
      input.removeEventListener("input", finishEdit, true);
      savedEdit.current = null;
    };
  }, [savedPassword, inputRef]);

  useEffect(() => {
    let cancelled = false;
    void authPort
      .rememberedLogin()
      .then((saved) => {
        if (cancelled || edited.current || !saved.username) return;
        setUsername(saved.username);
        setSavedUsername(saved.username);
        setPassword("");
        setRemember(true);
      })
      .catch(() => {
        /* Manual login remains available when the probe fails. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enterPassword = () => {
    edited.current = true;
    setSavedUsername(null);
    setPassword("");
    inputRef.current?.focus();
  };

  const changeRemember = async (checked: boolean) => {
    edited.current = true;
    if (checked) {
      setRemember(true);
      return;
    }
    setBusy(true);
    setMessage(null);
    setRemember(false);
    try {
      await authPort.forgetLogin();
      setRemember(false);
      localStorage.removeItem(usernameKey);
      if (savedPassword) enterPassword();
    } catch {
      setRemember(true);
      setMessage({ text: "清除已保存的密码失败，请重试" });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    document.title = changing ? t.changePassword.pageTitle : t.pageTitle;
    document.documentElement.lang = "zh-CN";
    return () => {
      document.title = "WorkAgent";
    };
  }, [t, changing]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setMessage(null);
    edited.current = true;
    if (!username.trim() || (!password && !savedPassword)) {
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
        setSavedUsername(null);
        setPassword("");
        setNewPassword("");
        setConfirmation("");
        setMessage({ text: t.changePassword.success, success: true });
        return;
      }
      const user = savedPassword
        ? await authPort.loginRemembered(username.trim())
        : await authPort.login(username.trim(), password, remember);
      if (remember) localStorage.setItem(usernameKey, username.trim());
      else localStorage.removeItem(usernameKey);
      if (!user.admin) {
        window.location.replace("/?frontend=dsh");
        return;
      }
      onAuthenticated(user);
    } catch (error) {
      if (savedPassword && error instanceof ApiError && error.status === 401) {
        enterPassword();
        setMessage({ text: "已保存的密码已失效，请重新输入密码" });
        return;
      }
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
    edited.current = true;
    setChanging(!changing);
    setMessage(null);
    setPassword("");
    setNewPassword("");
    setConfirmation("");
  };

  return (
    <main className="login-page">
      <div
        className={`login-page__card${changing ? " login-page__card--change-password" : ""}`}
      >
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
            onChange={(value) => {
              edited.current = true;
              setUsername(value);
              setSavedUsername(null);
              setPassword("");
            }}
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
                ref={inputRef}
                id="password"
                name="password"
                type={!savedPassword && visible ? "text" : "password"}
                className="login-page__input"
                placeholder={
                  changing
                    ? t.changePassword.currentPasswordPlaceholder
                    : t.passwordPlaceholder
                }
                autoComplete={savedPassword ? "off" : "current-password"}
                value={savedPassword ? "••••••••" : password}
                onChange={(event) => {
                  edited.current = true;
                  setSavedUsername(null);
                  setPassword(event.target.value);
                }}
                required
              />
              {!savedPassword && (!password || canReveal) && (
                <button
                  type="button"
                  className="login-page__toggle-password"
                  aria-label={
                    !savedPassword && visible ? t.hidePassword : t.showPassword
                  }
                  aria-pressed={!savedPassword && visible}
                  disabled={savedPassword || !canReveal}
                  title={
                    !savedPassword && canReveal
                      ? visible
                        ? t.hidePassword
                        : t.showPassword
                      : "自动填充的密码不可查看，清空后手动输入可查看"
                  }
                  onClick={() => {
                    if (!savedPassword) toggle();
                  }}
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
                    {!savedPassword && visible && <path d="m1 1 22 22" />}
                  </svg>
                </button>
              )}
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
                  disabled={busy}
                  onChange={(event) =>
                    void changeRemember(event.target.checked)
                  }
                />
                <label
                  htmlFor="remember-me"
                  title="在此浏览器保存 30 天，自动填充后不可查看；取消勾选可清除"
                >
                  记住密码
                </label>
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
            <span className="login-page__footer-divider" aria-hidden="true" />
            <span>无需下载</span>
            <span className="login-page__footer-divider" aria-hidden="true" />
            <span>开箱即用</span>
          </div>
        </div>
      </div>
    </main>
  );
}
