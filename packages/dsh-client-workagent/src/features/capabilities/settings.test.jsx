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
import { MCPSkillsSection } from "./settings.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const skills = [
  {
    id: "managed-skill",
    name: "受管技能",
    source: "managed",
    enabled: true,
    health: "ready",
  },
  {
    id: "builtin-skill",
    name: "内置技能",
    source: "builtin",
    enabled: false,
    health: "ready",
  },
  {
    id: "user-skill",
    name: "用户技能",
    source: "user",
    enabled: true,
    health: "ready",
  },
];

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

function fixture() {
  const fetch = vi.fn(async (url) => {
    url = String(url);
    if (url === "/api/runtime/v1/skills") return json(skills);
    if (url === "/api/runtime/v1/mcp-servers") return json([]);
    if (url === "/api/runtime/v1/capability-sync/status")
      return json({ items: [] });
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("combines MCP and skills under one section", async () => {
  fixture();
  render(<MCPSkillsSection />);
  const section = (
    await screen.findByText("受管技能", { exact: true })
  ).closest("section");
  expect(section.getAttribute("data-workagent-section")).toBe("MCP与技能");
  expect(within(section).getByText("MCP 服务", { exact: true })).toBeTruthy();
  expect(within(section).getByText("技能", { exact: true })).toBeTruthy();
});

it("shows enable/disable toggles for skills of every source", async () => {
  fixture();
  render(<MCPSkillsSection />);
  const managed = (
    await screen.findByText("受管技能", { exact: true })
  ).closest("article");
  expect(managed.textContent).toContain("平台受管");
  expect(
    within(managed).getByRole("button", { name: "停用", exact: true }),
  ).toBeTruthy();
  const builtin = screen
    .getByText("内置技能", { exact: true })
    .closest("article");
  expect(builtin.textContent).toContain("系统内置");
  expect(
    within(builtin).getByRole("button", { name: "启用", exact: true }),
  ).toBeTruthy();
});

it("toggles a managed skill through the same PATCH used for user skills", async () => {
  const fetch = fixture();
  render(<MCPSkillsSection />);
  const card = (await screen.findByText("受管技能", { exact: true })).closest(
    "article",
  );
  fireEvent.click(
    within(card).getByRole("button", { name: "停用", exact: true }),
  );
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/skills/managed-skill",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ enabled: false }),
      }),
    ),
  );
});
