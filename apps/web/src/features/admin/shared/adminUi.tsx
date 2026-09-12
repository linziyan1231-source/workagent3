import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { errorMessage } from "./adminErrors.js";
export const date = (value?: string) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "尚未登录";

export function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`admin-dialog ${wide ? "wide" : ""}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label={title}
    >
      <div className="admin-dialog-heading">
        <h2>{title}</h2>
        <button aria-label="关闭" onClick={onClose}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function ActionForm({
  children,
  onSubmit,
  submit = "保存更改",
  danger = false,
}: {
  children: ReactNode;
  onSubmit: (data: FormData) => Promise<void>;
  submit?: string;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError("");
    setSuccess(false);
    try {
      await onSubmit(data);
      setSuccess(true);
      form
        .querySelectorAll<HTMLInputElement>('input[type="password"]')
        .forEach((input) => (input.value = ""));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="admin-form" onSubmit={(e) => void save(e)}>
      <fieldset disabled={busy}>{children}</fieldset>
      {error && <p role="alert">{error}</p>}
      {success && (
        <p role="status" className="admin-success">
          已保存
        </p>
      )}
      <button
        className={danger ? "admin-danger" : "admin-primary"}
        disabled={busy}
      >
        {busy ? "正在处理…" : submit}
      </button>
    </form>
  );
}
export function Password({ label, name }: { label: string; name: string }) {
  return (
    <label>
      {label}
      <input
        type="password"
        name={name}
        required
        minLength={name === "windows_password" ? undefined : 12}
        autoComplete="new-password"
      />
      <small>至少 12 个字符。</small>
    </label>
  );
}
