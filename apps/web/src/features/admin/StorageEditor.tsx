import { useEffect, useState } from "react";
import { requestJson } from "../../shared/api/http.js";
import { ActionForm } from "./adminUi.js";
import { errorMessage } from "./adminApi.js";
type Usage = Record<"personal" | "shared", { usedBytes: number; limitBytes: number; enabled: boolean; hard: boolean }>;
export function StorageEditor({ username }: { username: string }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void requestJson<Usage>(`/api/portal/admin/storage?username=${encodeURIComponent(username)}`, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setUsage(value); })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [username]);
  return <section><h3>磁盘硬配额</h3><p>分别限制个人数据和该员工拥有的共享空间。保存后立即生效，不重启员工服务。</p>
    {error && <p role="alert">{error}</p>}
    {usage && <ActionForm onSubmit={async (form) => {
      const value = await requestJson<Usage>("/api/portal/admin/storage", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, limits: { personalBytes: Math.round(Number(form.get("personal")) * 1024 ** 3), sharedBytes: Math.round(Number(form.get("shared")) * 1024 ** 3) } }) });
      setUsage(value);
    }}>{(["personal", "shared"] as const).map((kind) => <label key={kind}>{kind === "personal" ? "个人空间" : "拥有的共享空间"}上限（GiB）
      <input type="number" name={kind} required min="0.001" max="102400" step="0.001" defaultValue={usage[kind].enabled ? usage[kind].limitBytes / 1024 ** 3 : undefined} />
      <span>{usage[kind].enabled ? `已用 ${(usage[kind].usedBytes / 1024 ** 3).toFixed(2)} GiB · ${usage[kind].hard ? "硬配额" : "软配额"}` : "尚未配置"}</span>
    </label>)}</ActionForm>}
  </section>;
}
