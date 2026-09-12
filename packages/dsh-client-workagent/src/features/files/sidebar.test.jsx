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
import { FileSidebar } from "./sidebar.js";
import { conversationCache } from "../conversations/state.js";

const route = vi.hoisted(() => ({ search: "" }));
vi.mock("../../host/navigation.js", () => ({
  navigation: { useSearch: () => route.search },
}));
vi.mock("../notifications/page.js", () => ({
  TopNotificationButton: () => <button>通知</button>,
}));

beforeEach(() => {
  const saved = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, String(value)),
    removeItem: (key) => saved.delete(key),
  });
  localStorage.setItem("workagent.files.open", "true");
  conversationCache.remove("personal-task");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fixture() {
  const fetch = vi.fn(async (url) => {
    const value = String(url);
    let result;
    if (value === "/api/portal/shared-projects?include_hidden=true")
      result = {
        projects: [
          { id: "project-a", name: "当前共享项目", hidden: true },
          { id: "project-b", name: "其他共享项目" },
        ],
      };
    else if (value === "/api/runtime/v1/sessions/personal-task")
      result = { id: "personal-task", workspaceId: "shared:project-a" };
    else if (value === "/api/runtime/v1/workspaces")
      result = [{ id: "personal", name: "个人项目" }];
    else if (value.endsWith("/trash"))
      result = {
        entries: [],
        usedBytes: 0,
        projectUsedBytes: 0,
        limitBytes: 60 * 1024 ** 3,
        retentionDays: 7,
      };
    else if (value.includes("/content?"))
      return new Response("共享项目文件正文");
    else if (value.includes("/files?"))
      result = [{ name: "note.txt", path: "note.txt", kind: "file", size: 20 }];
    else result = [];
    return new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it.each([
  "?workagent=shared&project=project-a&personal=new",
  "?workagent=shared&project=project-a&session=personal-task",
])(
  "shows the fixed shared project's files and trash even when the project is hidden on %s",
  async (search) => {
    route.search = search;
    const fetch = fixture();
    render(<FileSidebar />);
    expect(await screen.findByText("当前共享项目")).toBeTruthy();
    expect(fetch.mock.calls.some(([url]) =>
      url === "/api/portal/shared-projects?include_hidden=true",
    )).toBe(true);
    expect(screen.queryByRole("combobox", { name: "文件侧栏项目" })).toBeNull();
    expect(screen.queryByText("其他共享项目")).toBeNull();
    fireEvent.click(
      await screen.findByRole("button", { name: "note.txt", exact: true }),
    );
    expect(await screen.findByText("共享项目文件正文")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回文件列表" }));
    fireEvent.click(screen.getByRole("button", { name: "打开项目回收站" }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(
          ([url]) => url === "/api/portal/shared-workspaces/project-a/trash",
        ),
      ).toBe(true),
    );
    const workspaceCalls = fetch.mock.calls
      .map(([url]) => String(url))
      .filter(
        (url) =>
          url.includes("/workspaces") || url.includes("/shared-workspaces"),
      );
    expect(workspaceCalls.length).toBeGreaterThan(0);
    expect(
      workspaceCalls.every((url) =>
        url.startsWith("/api/portal/shared-workspaces/project-a/"),
      ),
    ).toBe(true);
  },
);

it("keeps the ordinary home workspace chooser and private file API", async () => {
  route.search = "?project=personal";
  const fetch = fixture();
  render(<FileSidebar />);
  expect(await screen.findByRole("option", { name: "个人项目" })).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "文件侧栏项目" }).value).toBe(
    "personal",
  );
  await screen.findByRole("button", { name: "note.txt", exact: true });
  expect(
    fetch.mock.calls.some(
      ([url]) => url === "/api/runtime/v1/workspaces/personal/files?path=",
    ),
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "打开项目回收站" })).toBeNull();
});
