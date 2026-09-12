import { useEffect, useState } from "react";
import {
  storageApi,
  gibibytesToBytes,
  type StorageUsage,
} from "./storageApi.js";
import { ActionForm } from "../shared/adminUi.js";
import { errorMessage } from "../shared/adminErrors.js";
export function StorageEditor({ username }: { username: string }) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void storageApi
      .usage(username, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setUsage(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      });
    return () => controller.abort();
  }, [username]);
  return (
    <section>
      <h3>磁盘硬配额</h3>
      <p>
        分别限制个人数据和该员工拥有的共享空间。保存后立即生效，不重启员工服务。
      </p>
      {error && <p role="alert">{error}</p>}
      {usage && (
        <ActionForm
          onSubmit={async (form) => {
            const value = await storageApi.update(username, {
              personalBytes: gibibytesToBytes(form.get("personal")),
              sharedBytes: gibibytesToBytes(form.get("shared")),
            });
            setUsage(value);
          }}
        >
          {(["personal", "shared"] as const).map((kind) => (
            <label key={kind}>
              {kind === "personal" ? "个人空间" : "拥有的共享空间"}上限（GiB）
              <input
                type="number"
                name={kind}
                required
                min="0.001"
                max="102400"
                step="0.001"
                defaultValue={
                  usage[kind].enabled
                    ? usage[kind].limitBytes / 1024 ** 3
                    : undefined
                }
              />
              <span>
                {usage[kind].enabled
                  ? `已用 ${(usage[kind].usedBytes / 1024 ** 3).toFixed(2)} GiB · ${usage[kind].hard ? "硬配额" : "软配额"}`
                  : "尚未配置"}
              </span>
            </label>
          ))}
        </ActionForm>
      )}
    </section>
  );
}
