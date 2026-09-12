import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ProfessionalDatabasePanel } from "./ProfessionalDatabasePanel.js";
import { accountApi, type Employee } from "./accountApi.js";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const employee: Employee = {
  username: "alice",
  windows_username: "alice",
  windows_sid: "alice-sid",
  enabled: true,
  offboarded: false,
  created_at: "2026-09-12",
  kimi_datasource: {
    enabled: true,
    allowed_sources: ["wind"],
    daily_limit: 10,
    monthly_limit: 100,
    daily_used: 3,
    monthly_used: 20,
  },
};
const update = vi.fn(async () => {});
async function renderPanel(user = employee, sources = ["wind", "tianyancha"]) {
  await act(async () =>
    root.render(
      <ProfessionalDatabasePanel
        employee={user}
        sources={sources}
        onUpdate={update}
      />,
    ),
  );
}
async function submit() {
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

test("shows remaining, total and used calls for both calendar periods", async () => {
  await renderPanel();
  expect(
    container.querySelector('[aria-label="今日调用次数"]')?.textContent,
  ).toContain("剩余调用次数 7 / 总可调用次数 10");
  expect(
    container.querySelector('[aria-label="本月调用次数"]')?.textContent,
  ).toContain("已用 20 次");
  expect(container.textContent).toContain("Asia/Shanghai");
  expect(container.textContent).toContain("已发送但失败的请求也计次");
});

test("saves employee-specific source permissions and zero limits without resetting usage", async () => {
  const save = vi
    .spyOn(accountApi, "setDatasource")
    .mockResolvedValue(undefined);
  await renderPanel();
  container.querySelector<HTMLInputElement>('[name="daily"]')!.value = "0";
  container.querySelector<HTMLInputElement>('[name="monthly"]')!.value = "0";
  container.querySelector<HTMLInputElement>('[value="wind"]')!.checked = false;
  container.querySelector<HTMLInputElement>('[value="tianyancha"]')!.checked =
    true;
  await submit();
  expect(save).toHaveBeenCalledWith("alice", {
    enabled: true,
    allowed_sources: ["tianyancha"],
    daily_limit: 0,
    monthly_limit: 0,
  });
  expect(container.querySelector('[role="status"]')?.textContent).toContain(
    "已保存",
  );
});

test("does not automatically enable an unconfigured account", async () => {
  const save = vi
    .spyOn(accountApi, "setDatasource")
    .mockResolvedValue(undefined);
  await renderPanel({ ...employee, kimi_datasource: undefined });
  expect(
    container.querySelector<HTMLInputElement>('[name="enabled"]')!.checked,
  ).toBe(false);
  expect(container.textContent).toContain("未启用，当前不可调用");
  await submit();
  expect(save).toHaveBeenCalledWith("alice", {
    enabled: false,
    allowed_sources: [],
    daily_limit: 0,
    monthly_limit: 0,
  });
});

test("rejects a monthly limit below the daily limit before saving", async () => {
  const save = vi
    .spyOn(accountApi, "setDatasource")
    .mockResolvedValue(undefined);
  await renderPanel();
  container.querySelector<HTMLInputElement>('[name="monthly"]')!.value = "5";
  await submit();
  expect(save).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "每月总可调用次数不能小于每日总可调用次数。",
  );
});

test("clamps remaining calls after an administrator lowers the limit below prior usage", async () => {
  await renderPanel({
    ...employee,
    kimi_datasource: { ...employee.kimi_datasource!, daily_limit: 1 },
  });
  expect(
    container.querySelector('[aria-label="今日调用次数"]')?.textContent,
  ).toContain("剩余调用次数 0 / 总可调用次数 1");
});

test("validates the service limits and requires a source before enabling", async () => {
  const save = vi
    .spyOn(accountApi, "setDatasource")
    .mockResolvedValue(undefined);
  await renderPanel();
  container.querySelector<HTMLInputElement>('[name="daily"]')!.value = "10001";
  container.querySelector<HTMLInputElement>('[name="monthly"]')!.value =
    "100000";
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "每日总可调用次数最多 10000 次",
  );
  container.querySelector<HTMLInputElement>('[name="daily"]')!.value = "10";
  container.querySelector<HTMLInputElement>('[value="wind"]')!.checked = false;
  await submit();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "启用专业数据库时，请至少选择一个数据源。",
  );
  expect(save).not.toHaveBeenCalled();
});

test("refreshes usage for the selected employee and reports read failure without claiming success", async () => {
  const users = vi.spyOn(accountApi, "users").mockResolvedValue({
    users: [
      {
        ...employee,
        kimi_datasource: { ...employee.kimi_datasource!, daily_used: 5 },
      },
    ],
    kimi_datasource_sources: ["wind", "tianyancha"],
  });
  await renderPanel();
  const refresh = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "刷新调用次数",
  )!;
  await act(async () => refresh.click());
  expect(
    container.querySelector('[aria-label="今日调用次数"]')?.textContent,
  ).toContain("剩余调用次数 5 / 总可调用次数 10");
  users.mockRejectedValueOnce(new Error("failed"));
  await act(async () => refresh.click());
  expect(container.querySelector('[role="alert"]')).toBeTruthy();
  expect(container.querySelector('[role="status"]')).toBeNull();
});

test("explains that an unconfigured deployment has no service to manage", async () => {
  await renderPanel(employee, []);
  expect(container.textContent).toBe("当前部署尚未配置专业数据库服务。");
  expect(container.querySelector("form")).toBeNull();
});
