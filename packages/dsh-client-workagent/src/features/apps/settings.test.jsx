// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PublishedAppsSection } from "./settings.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const apps = [
  {
    id: "app-token",
    name: "活动页",
    access: "token",
    enabled: true,
    shareUrl: "http://192.0.2.1:24301/t/share-token-x/",
    url: "http://192.0.2.1:8080/apps/app-token",
    expiresAt: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
  },
  {
    id: "app-password",
    name: "报表页",
    access: "password",
    enabled: false,
    accessCode: "12345678",
    shareUrl: "http://192.0.2.1:24303/",
    url: "http://192.0.2.1:8080/apps/app-password",
    expiresAt: new Date(Date.now() - 3600 * 1000).toISOString(),
  },
];

const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

function fixture() {
  const fetch = vi.fn(async (url, init = {}) => {
    url = String(url);
    if (url === "/api/portal/apps" && !init.method) return json({ items: apps });
    if (url.startsWith("/api/portal/apps/")) return json({ deleted: true });
    throw new Error(`Unexpected request ${url} ${init.method || ""}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("lists published pages with state, scope and expiry", async () => {
  fixture();
  render(<PublishedAppsSection />);
  const card = (await screen.findByText("活动页", { exact: true })).closest(
    "article",
  );
  expect(card.textContent).toContain("运行中");
  expect(card.textContent).toContain("持有链接的人");
  expect(card.textContent).toContain("有效期至");
  expect(
    within(card).getByRole("button", { name: "停用", exact: true }),
  ).toBeTruthy();
  const stopped = screen.getByText("报表页", { exact: true }).closest("article");
  expect(stopped.textContent).toContain("已停用");
  expect(
    within(stopped).getByRole("button", { name: "启用", exact: true }),
  ).toBeTruthy();
  expect(
    within(stopped).getByRole("button", { name: "复制访问密码", exact: true }),
  ).toBeTruthy();
});

it("disables, enables and deletes pages through portal actions", async () => {
  const fetch = fixture();
  render(<PublishedAppsSection />);
  const card = (await screen.findByText("活动页", { exact: true })).closest(
    "article",
  );
  fireEvent.click(within(card).getByRole("button", { name: "停用", exact: true }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/apps/app-token/unpublish",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  const stopped = screen.getByText("报表页", { exact: true }).closest("article");
  fireEvent.click(within(stopped).getByRole("button", { name: "启用", exact: true }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/apps/app-password/enable",
      expect.objectContaining({ method: "POST" }),
    ),
  );
  fireEvent.click(within(stopped).getByRole("button", { name: "删除", exact: true }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "删除", exact: true }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/apps/app-password/delete",
      expect.objectContaining({ method: "POST" }),
    ),
  );
});
