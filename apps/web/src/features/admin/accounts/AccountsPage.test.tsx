import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { accountApi, type Job } from "./accountApi.js";
import { AccountsPage } from "./AccountsPage.js";
import type { AccountDirectory } from "./useAccountDirectory.js";

// These are feature boundaries: account creation can be tested without mounting
// usage polling, storage editors, or any other administrator page.
vi.mock("../usage/DollarUsage.js", () => ({
  DollarUsage: () => null,
  DollarBudgets: () => null,
}));
vi.mock("./EmployeePanel.js", () => ({ EmployeePanel: () => null }));

let root: Root;
let container: HTMLDivElement;
const showModal = HTMLDialogElement.prototype.showModal;
const close = HTMLDialogElement.prototype.close;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  HTMLDialogElement.prototype.showModal = showModal;
  HTMLDialogElement.prototype.close = close;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("account provisioning continues while its page is inactive and refreshes the directory on completion", async () => {
  const job: Job = {
    id: "create-1",
    username: "alice",
    status: "running",
    percent: 20,
    step: "创建工作空间",
  };
  const create = vi.spyOn(accountApi, "create").mockResolvedValue({ job });
  const poll = vi
    .spyOn(accountApi, "job")
    .mockResolvedValue({ job: { ...job, status: "succeeded", percent: 100 } });
  const directory: AccountDirectory = {
    users: [],
    sources: [],
    loading: false,
    error: "",
    reload: vi.fn().mockResolvedValue(undefined),
  };
  await act(async () =>
    root.render(<AccountsPage active directory={directory} />),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(".admin-heading button")!
      .click(),
  );
  container.querySelector<HTMLInputElement>('[name="username"]')!.value =
    "alice";
  container.querySelector<HTMLInputElement>('[name="password"]')!.value =
    "example password";
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(create).toHaveBeenCalledWith("alice", "example password");
  expect(container.querySelector(".admin-job")?.textContent).toContain(
    "创建工作空间",
  );
  await act(async () =>
    root.render(<AccountsPage active={false} directory={directory} />),
  );
  expect(container.textContent).toBe("");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(poll).toHaveBeenCalledWith("create-1");
  expect(directory.reload).toHaveBeenCalledOnce();
  await act(async () =>
    root.render(<AccountsPage active directory={directory} />),
  );
  expect(container.querySelector(".admin-job")?.textContent).toContain(
    "账户已就绪",
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(poll).toHaveBeenCalledOnce();
});
