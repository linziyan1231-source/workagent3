// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarketplaceSection } from "./page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const endpoint = "/api/portal/marketplace";
const database = {
  id: "professional-database",
  seriesId: "professional-database",
  kind: "mcp",
  name: "专业数据库",
  version: "1.0.0",
  publisher: "管理员",
  description: "查询专业数据",
};
const ordinary = {
  id: "ordinary-mcp",
  seriesId: "ordinary-mcp",
  kind: "mcp",
  name: "普通 MCP",
  version: "1.0.0",
  publisher: "管理员",
  description: "普通工具",
};
const quota = {
  configured: true,
  upstream_ready: true,
  enabled: true,
  allowed_sources: ["wind", "tianyancha"],
  daily_limit: 100,
  monthly_limit: 1000,
  daily_used: 4,
  monthly_used: 14,
  daily_remaining: 96,
  monthly_remaining: 986,
  timezone: "Asia/Shanghai",
  counting_rule:
    "接口说明和数据查询发送到上游后各计 1 次，已发送但失败的请求也计次。",
};
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const detail = (professionalDatabase = quota) => ({
  entry: database,
  bundle: { mcp: [] },
  professionalDatabase,
});

function fixture(intercept = () => undefined) {
  const fetch = vi.fn(async (url, init = {}) => {
    const value = intercept(String(url), init);
    if (value !== undefined) return value;
    if (url === endpoint) return json({ entries: [database, ordinary] });
    if (url === `${endpoint}?id=${database.id}`) return json(detail());
    if (url === `${endpoint}?id=${ordinary.id}`)
      return json({ entry: ordinary, bundle: { mcp: [] } });
    if (url === `${endpoint}/install`) return json({});
    if (url === "/api/portal/shared-projects") return json({ projects: [] });
    if (url === "/api/runtime/v1/workspaces") return json([]);
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function open(name = database.name) {
  const row = (await screen.findByText(name, { exact: true })).closest(
    "article",
  );
  fireEvent.click(
    within(row).getByRole("button", { name: "详情", exact: true }),
  );
  return screen.getByRole("dialog", { name: `${name} · 详情` });
}

it("shows account daily and monthly remaining, total and used calls in MCP details and installs without a token prompt", async () => {
  const fetch = fixture();
  render(<MarketplaceSection />);
  const dialog = await open();
  const today = await within(dialog).findByRole("region", {
    name: "今日调用次数",
  });
  expect(today.textContent).toContain(
    "剩余调用次数 / 总可调用次数96 / 100已用 4 次",
  );
  expect(
    within(dialog).getByRole("region", { name: "本月调用次数" }).textContent,
  ).toContain("986 / 1000已用 14 次");
  expect(dialog.textContent).toContain("Wind 金融数据、天眼查");
  expect(dialog.textContent).toContain(quota.counting_rule);
  expect(dialog.textContent).toContain("Asia/Shanghai");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "关闭", exact: true }),
  );
  const row = screen
    .getByText(database.name, { exact: true })
    .closest("article");
  fireEvent.click(
    within(row).getByRole("button", { name: "获取", exact: true }),
  );
  await screen.findByText("已获取。可在助手设置中选择这项能力。");
  expect(fetch).toHaveBeenCalledWith(
    `${endpoint}/install`,
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ id: database.id }),
    }),
  );
  expect(document.querySelector('input[type="password"]')).toBeNull();
});

it("renders zero as a real limit and explains the exhausted daily allowance", async () => {
  fixture((url) =>
    url === `${endpoint}?id=${database.id}`
      ? json(
          detail({
            ...quota,
            daily_limit: 0,
            daily_remaining: 0,
            daily_used: 0,
          }),
        )
      : undefined,
  );
  render(<MarketplaceSection />);
  const dialog = await open();
  const today = await within(dialog).findByRole("region", {
    name: "今日调用次数",
  });
  expect(today.textContent).toContain("0 / 0已用 0 次");
  expect(dialog.textContent).toContain("当前可用次数为 0，暂时无法调用");
  expect(dialog.textContent).not.toContain("无限");
});

it("shows a disabled account as unavailable even if it has a positive allowance", async () => {
  fixture((url) =>
    url === `${endpoint}?id=${database.id}`
      ? json(detail({ ...quota, enabled: false }))
      : undefined,
  );
  render(<MarketplaceSection />);
  const dialog = await open();
  await within(dialog).findByText(
    "未开通，当前不可调用。请联系管理员开通专业数据库。",
  );
  expect(dialog.textContent).not.toContain("已开通 ·");
});

it("shows an unconfigured grant without invented quota values", async () => {
  fixture((url) =>
    url === `${endpoint}?id=${database.id}`
      ? json(detail({ ...quota, configured: false }))
      : undefined,
  );
  render(<MarketplaceSection />);
  const dialog = await open();
  await within(dialog).findByText("尚未配置调用额度，请联系管理员。");
  expect(
    within(dialog).queryByRole("region", { name: "今日调用次数" }),
  ).toBeNull();
});

it("marks an entry that installs disabled by default", async () => {
  fixture((url) =>
    url === `${endpoint}?id=${database.id}`
      ? json({
          ...detail(),
          entry: { ...database, defaultEnabled: false },
        })
      : undefined,
  );
  render(<MarketplaceSection />);
  const dialog = await open();
  await within(dialog).findByText(/默认关闭/);
});

it("shows pending Kimi authorization while retaining configured employee quotas", async () => {
  fixture((url) =>
    url === `${endpoint}?id=${database.id}`
      ? json(detail({ ...quota, upstream_ready: false }))
      : undefined,
  );
  render(<MarketplaceSection />);
  const dialog = await open();
  await within(dialog).findByText("服务待授权", { exact: true });
  expect(dialog.textContent).toContain("管理员尚需完成 Kimi 服务授权");
  expect(dialog.textContent).toContain("授权完成前无法查询，不扣调用次数");
  expect(
    within(dialog).getByRole("region", { name: "今日调用次数" }).textContent,
  ).toContain("96 / 100");
  expect(
    within(dialog).getByRole("region", { name: "本月调用次数" }).textContent,
  ).toContain("986 / 1000");
});

it("refreshes from the server and replaces old counts with a clear error if refresh fails", async () => {
  let reads = 0;
  const fetch = fixture((url) => {
    if (url !== `${endpoint}?id=${database.id}`) return;
    reads += 1;
    if (reads === 1) return json(detail());
    if (reads === 2)
      return json(detail({ ...quota, daily_used: 5, daily_remaining: 95 }));
    return json({ error: "professional_database_unavailable" }, 503);
  });
  render(<MarketplaceSection />);
  const dialog = await open();
  await within(dialog).findByText("已用 4 次");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "刷新详情与调用次数" }),
  );
  await within(dialog).findByText("已用 5 次");
  expect(
    within(dialog).getByRole("region", { name: "今日调用次数" }).textContent,
  ).toContain("95 / 100");
  expect(fetch).toHaveBeenLastCalledWith(
    `${endpoint}?id=${database.id}`,
    expect.objectContaining({ cache: "no-store" }),
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "刷新详情与调用次数" }),
  );
  expect((await within(dialog).findByRole("alert")).textContent).toContain(
    "详情加载失败：专业数据库服务暂不可用",
  );
  expect(
    within(dialog).queryByRole("region", { name: "今日调用次数" }),
  ).toBeNull();
});

it("retries a failed initial detail load", async () => {
  let reads = 0;
  fixture((url) =>
    url === `${endpoint}?id=${database.id}`
      ? ++reads === 1
        ? json({ error: "professional_database_unavailable" }, 503)
        : json(detail())
      : undefined,
  );
  render(<MarketplaceSection />);
  const dialog = await open();
  await within(dialog).findByRole("alert");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "刷新详情与调用次数" }),
  );
  await within(dialog).findByRole("region", { name: "今日调用次数" });
  expect(within(dialog).queryByRole("alert")).toBeNull();
});

it("does not expose database quotas on ordinary MCP rows after switching details", async () => {
  fixture();
  render(<MarketplaceSection />);
  const databaseDialog = await open();
  await within(databaseDialog).findByRole("region", { name: "今日调用次数" });
  fireEvent.click(
    within(databaseDialog).getByRole("button", { name: "关闭", exact: true }),
  );
  const ordinaryDialog = await open(ordinary.name);
  await within(ordinaryDialog).findByText(ordinary.description);
  expect(within(ordinaryDialog).queryByText("我的调用次数")).toBeNull();
  expect(ordinaryDialog.textContent).not.toContain("96");
});

it("aborts closed detail requests and ignores late quota results after opening another row", async () => {
  let resolve;
  let signal;
  fixture((url, init) => {
    if (url === `${endpoint}?id=${database.id}`) {
      signal = init.signal;
      return new Promise((done) => {
        resolve = done;
      });
    }
  });
  render(<MarketplaceSection />);
  const first = await open();
  await waitFor(() => expect(signal).toBeTruthy());
  fireEvent.click(
    within(first).getByRole("button", { name: "关闭", exact: true }),
  );
  expect(signal.aborted).toBe(true);
  const next = await open(ordinary.name);
  await within(next).findByText(ordinary.description);
  await act(async () => resolve(json(detail())));
  expect(next.textContent).not.toContain("我的调用次数");
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});
