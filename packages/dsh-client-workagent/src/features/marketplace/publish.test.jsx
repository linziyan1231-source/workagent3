// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarketplaceSection } from "./page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const endpoint = "/api/portal/marketplace";
const runtime = "/api/runtime/v1";
const skill = {
  id: "skill-1",
  name: "示例技能",
  source: "user",
  enabled: true,
  description: "示例说明",
};

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

function fixture(entries = []) {
  const fetch = vi.fn(async (url, init = {}) => {
    url = String(url);
    if (url === endpoint && init.method === "POST") return json({});
    if (url === endpoint) return json({ entries });
    if (url === "/api/portal/shared-projects") return json({ projects: [] });
    if (url === `${runtime}/workspaces`) return json([]);
    if (url === `${runtime}/skills`) return json([skill]);
    if (url === `${runtime}/mcp-servers`) return json([]);
    if (url === `${runtime}/presets`) return json([]);
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("publishes a skill enabled by default unless the checkbox is cleared", async () => {
  const fetch = fixture();
  render(<MarketplaceSection />);
  fireEvent.click(
    await screen.findByRole("button", { name: "发布到市场", exact: true }),
  );
  fireEvent.change(await screen.findByLabelText("发布内容"), {
    target: { value: skill.id },
  });
  fireEvent.change(await screen.findByLabelText("本版本更新说明"), {
    target: { value: "首个版本" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发布", exact: true }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"defaultEnabled":true'),
      }),
    ),
  );
});

it("publishes a skill disabled by default when the checkbox is cleared", async () => {
  const fetch = fixture();
  render(<MarketplaceSection />);
  fireEvent.click(
    await screen.findByRole("button", { name: "发布到市场", exact: true }),
  );
  fireEvent.change(await screen.findByLabelText("发布内容"), {
    target: { value: skill.id },
  });
  fireEvent.change(await screen.findByLabelText("本版本更新说明"), {
    target: { value: "首个版本" },
  });
  fireEvent.click(screen.getByLabelText("安装后默认启用"));
  fireEvent.click(screen.getByRole("button", { name: "发布", exact: true }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"defaultEnabled":false'),
      }),
    ),
  );
});

it("marks catalog entries that install disabled by default", async () => {
  fixture([
    {
      id: "entry-1",
      seriesId: "series-1",
      kind: "skill",
      name: "默认关闭技能",
      version: "1.0.0",
      publisher: "管理员",
      description: "示例",
      defaultEnabled: false,
    },
  ]);
  render(<MarketplaceSection />);
  const card = (
    await screen.findByText("默认关闭技能", { exact: true })
  ).closest("article");
  expect(card.textContent).toContain("默认关闭");
});
