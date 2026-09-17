import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PublishingSettingsPanel } from "./PublishingSettings.js";

let root: Root;
let container: HTMLDivElement;

const loaded = {
  firstPort: 21134,
  lastPort: 21174,
  maxEmployeePorts: 3,
  totalPorts: 41,
  usedPorts: 2,
  employeeUsage: [{ sid: "S-1", username: "alice", ports: 1 }],
};

const loadedApps = {
  apps: [
    {
      id: "app-1",
      name: "站点",
      kind: "static",
      access: "token",
      url: "http://192.0.2.1:8080/apps/app-1",
      shareUrl: "http://192.0.2.1:21134/t/tok123/",
      enabled: true,
      createdAt: "2026-09-01T08:00:00Z",
      username: "alice",
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch() {
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/settings")) return Promise.resolve(json(loaded));
    if (path.endsWith("/unpublish")) return Promise.resolve(json({}));
    return Promise.resolve(json(loadedApps));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("renders the current range, quota and per-employee usage", async () => {
  stubFetch();
  await act(async () => root.render(<PublishingSettingsPanel />));
  const first = container.querySelector(
    'input[aria-label="起始端口"]',
  ) as HTMLInputElement;
  const quota = container.querySelector(
    'input[aria-label="每员工最大端口数"]',
  ) as HTMLInputElement;
  expect(first.value).toBe("21134");
  expect(quota.value).toBe("3");
  expect(container.textContent).toContain("已占用 2 / 41 个端口");
  expect(container.textContent).toContain("alice：1 / 3 个端口");
});

test("saving sends the edited values and shows the remap notice", async () => {
  const fetchMock = stubFetch();
  await act(async () => root.render(<PublishingSettingsPanel />));
  const first = container.querySelector(
    'input[aria-label="起始端口"]',
  ) as HTMLInputElement;
  await act(async () => {
    // React controlled input: use the native setter so onChange fires.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(first, "21140");
    first.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "保存设置",
  )!;
  await act(async () => save.click());
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT");
  expect(put).toBeDefined();
  expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({
    firstPort: 21140,
    lastPort: 21174,
    maxEmployeePorts: 3,
  });
});

test("lists published pages and unpublishes after confirmation", async () => {
  const fetchMock = stubFetch();
  const confirmMock = vi.fn().mockReturnValue(true);
  vi.stubGlobal("confirm", confirmMock);
  await act(async () => root.render(<PublishingSettingsPanel />));
  expect(container.textContent).toContain("发布者：alice");
  const link = container.querySelector(
    'a[href="http://192.0.2.1:21134/t/tok123/"]',
  );
  expect(link).not.toBeNull();
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "下架",
  )!;
  await act(async () => button.click());
  expect(confirmMock).toHaveBeenCalled();
  const post = fetchMock.mock.calls.find(
    ([path, init]) =>
      String(path).endsWith("/api/portal/admin/published-apps/app-1/unpublish") &&
      (init as RequestInit | undefined)?.method === "POST",
  );
  expect(post).toBeDefined();
  expect(container.textContent).toContain("已下架「站点」。");
});

test("skips unpublish when the confirmation is cancelled", async () => {
  const fetchMock = stubFetch();
  vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
  await act(async () => root.render(<PublishingSettingsPanel />));
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "下架",
  )!;
  await act(async () => button.click());
  const post = fetchMock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST",
  );
  expect(post).toBeUndefined();
});
