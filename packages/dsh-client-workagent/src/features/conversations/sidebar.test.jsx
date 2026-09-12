// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SidebarSessions } from "./sidebar.js";

const navigation = vi.hoisted(() => ({
  useSearch: () => "?session=ordinary-session",
  navigate: vi.fn(),
}));
vi.mock("../../host/navigation.js", () => ({
  navigation,
  closeMobileSidebar: vi.fn(),
}));
vi.mock("../collaboration/shared.js", () => ({
  sortProjectsByChat: (rows) => rows,
}));
vi.mock("../agents/avatar-components.js", () => ({
  SessionAvatar: () => <span>Agent</span>,
}));
vi.mock("../content/index.js", () => ({
  workbench: {
    usePins: () => {
      const [pins, setPins] = React.useState([]);
      return {
        pins,
        toggle: (id) =>
          setPins((rows) =>
            rows.includes(id)
              ? rows.filter((value) => value !== id)
              : [...rows, id],
          ),
        move: vi.fn(),
      };
    },
    Notifications: () => null,
    SessionReminder: () => <div>提醒设置</div>,
  },
}));

beforeEach(() => {
  const saved = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, String(value)),
    removeItem: (key) => saved.delete(key),
  });
  navigation.navigate.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("pins through the common menu, renames through the ordinary API and confirms deletion", async () => {
  let rows = [
    {
      id: "ordinary-session",
      title: "旧任务",
      workspaceId: "default",
      updatedAt: "2026-09-12T08:00:00Z",
    },
  ];
  const mutations = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      let result = [];
      if (init?.method === "PATCH") {
        const body = JSON.parse(init.body);
        mutations.push({ url, method: init.method, body });
        rows = rows.map((row) => ({ ...row, title: body.title }));
        result = rows[0];
      } else if (init?.method === "DELETE") {
        mutations.push({ url, method: init.method });
        rows = [];
        result = {};
      } else if (url.endsWith("/sessions")) result = rows;
      return new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  render(<SidebarSessions />);
  fireEvent.click(
    await screen.findByRole("button", { name: "编辑对话 旧任务" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "置顶对话" }));
  expect(mutations).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "编辑对话 旧任务" }));
  expect(
    screen.getByRole("button", { name: "取消置顶", exact: true }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "管理对话" }));
  fireEvent.change(screen.getByRole("textbox", { name: "对话名称" }), {
    target: { value: "  新任务  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByRole("button", { name: "编辑对话 新任务" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mutations).toEqual([
    {
      url: "/api/runtime/v1/sessions/ordinary-session",
      method: "PATCH",
      body: { title: "新任务" },
    },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "编辑对话 新任务" }));
  fireEvent.click(screen.getByRole("button", { name: "管理对话" }));
  fireEvent.click(screen.getByRole("button", { name: "删除", exact: true }));
  expect(screen.getByRole("dialog", { name: "确认删除" })).toBeTruthy();
  expect(mutations).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "删除", exact: true }));
  await waitFor(() =>
    expect(navigation.navigate).toHaveBeenCalledWith("/?frontend=dsh"),
  );
  expect(mutations[1]).toEqual({
    url: "/api/runtime/v1/sessions/ordinary-session",
    method: "DELETE",
  });
  expect(screen.queryByRole("button", { name: "编辑对话 新任务" })).toBeNull();
});
