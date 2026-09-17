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
import { WorkspaceFileManager } from "./manager.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("loads and previews a project file without the application shell, preserving its text", async () => {
  const fetch = vi.fn(async (url) => {
    if (String(url).includes("/content?"))
      return new Response("<script>unsafe()</script>Full Access");
    return new Response(
      JSON.stringify(
        String(url).includes("/files?")
          ? [{ name: "note.txt", path: "note.txt", kind: "file", size: 30 }]
          : [],
      ),
      { headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetch);
  const view = render(
    <WorkspaceFileManager workspace={{ id: "project/one", name: "Project" }} />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "note.txt", exact: true }),
  );
  expect(
    await screen.findByText("<script>unsafe()</script>Full Access"),
  ).toBeTruthy();
  expect(view.container.querySelector("script")).toBeNull();
  expect(
    fetch.mock.calls.every(([url]) => String(url).includes("/project%2Fone/")),
  ).toBe(true);
  view.unmount();
  fetch.mockClear();
  window.dispatchEvent(new Event("workagent:files-changed"));
  expect(fetch).not.toHaveBeenCalled();
});

it("releases replaced and late search cursors without a publish panel", async () => {
  let finishLate;
  const fetch = vi.fn(async (url, init = {}) => {
    const path = String(url);
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (path.includes("/search?q=first"))
      return new Response(
        JSON.stringify({ items: [], nextCursor: "old-cursor" }),
        { headers: { "content-type": "application/json" } },
      );
    if (path.includes("/search?q=second"))
      return new Promise((resolve) => {
        finishLate = resolve;
      });
    return new Response("[]", {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  const view = render(
    <WorkspaceFileManager
      workspace={{ id: "project-a", name: "Shared", currentRole: "member" }}
    />,
  );
  expect(screen.queryByRole("button", { name: "应用预览与发布" })).toBeNull();
  fireEvent.change(screen.getByLabelText("搜索整个项目"), {
    target: { value: "first" },
  });
  await screen.findByRole("button", { name: "继续搜索更多结果" });
  fireEvent.change(screen.getByLabelText("搜索整个项目"), {
    target: { value: "second" },
  });
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(
        ([path, init]) =>
          String(path).includes("cursor=old-cursor") &&
          init.method === "DELETE",
      ),
    ).toBe(true),
  );
  await waitFor(() => expect(finishLate).toBeTypeOf("function"));
  view.unmount();
  finishLate(
    new Response(JSON.stringify({ items: [], nextCursor: "late-cursor" }), {
      headers: { "content-type": "application/json" },
    }),
  );
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(
        ([path, init]) =>
          String(path).includes("cursor=late-cursor") &&
          init.method === "DELETE",
      ),
    ).toBe(true),
  );
});

it("offers search results as a keyboard-navigable dropdown", async () => {
  const fetch = vi.fn(async (url) => {
    const path = String(url);
    if (path.includes("/search?q="))
      return new Response(
        JSON.stringify({
          items: [
            { name: "readme.md", path: "docs/readme.md", kind: "file", size: 10 },
            { name: "notes.md", path: "notes.md", kind: "file", size: 20 },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    if (path.includes("/content?")) return new Response("content");
    return new Response("[]", {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  render(<WorkspaceFileManager workspace={{ id: "project-a", name: "P" }} />);
  const input = screen.getByRole("combobox", { name: "搜索整个项目" });
  fireEvent.change(input, { target: { value: "md" } });
  const listbox = await screen.findByRole("listbox", {
    name: "项目搜索结果",
  });
  const options = await screen.findAllByRole("option");
  expect(options).toHaveLength(2);
  expect(options[0].textContent).toContain("readme.md");
  expect(options[0].textContent).toContain("docs");
  expect(options[0].getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(options[1].getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(([path]) => String(path).includes("/content?")),
    ).toBe(true),
  );
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(listbox.isConnected).toBe(false);
});

it("moves dragged files out to the parent folder when dropped on blank space", async () => {
  const fetch = vi.fn(async (url, init = {}) => {
    const path = String(url);
    if (init.method === "POST" && path.includes("/move"))
      return new Response(
        JSON.stringify({
          id: "op1",
          state: "completed",
          applied: 1,
          moves: [{ source: "a/b.txt", destination: "b.txt" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    if (init.method === "GET" && path.endsWith("/move"))
      return new Response("[]", {
        headers: { "content-type": "application/json" },
      });
    if (path.includes("/files?path=a"))
      return new Response(
        JSON.stringify([{ name: "b.txt", path: "a/b.txt", kind: "file", size: 5 }]),
        { headers: { "content-type": "application/json" } },
      );
    if (path.includes("/files?"))
      return new Response(
        JSON.stringify([{ name: "a", path: "a", kind: "directory" }]),
        { headers: { "content-type": "application/json" } },
      );
    return new Response("[]", {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  render(<WorkspaceFileManager workspace={{ id: "project-a", name: "P" }} />);
  fireEvent.click(await screen.findByRole("button", { name: "a", exact: true }));
  const row = await screen.findByRole("button", { name: "b.txt", exact: true });
  const payload = {
    workspaceId: "project-a",
    entries: [{ name: "b.txt", path: "a/b.txt", kind: "file" }],
  };
  const data = {
    types: ["application/x-workagent-project-files"],
    effectAllowed: "",
    dropEffect: "",
    setData: vi.fn(),
    getData: () => JSON.stringify(payload),
  };
  fireEvent.dragStart(row, { dataTransfer: data });
  const tree = screen.getByLabelText("项目文件树");
  fireEvent.dragOver(tree, { dataTransfer: data });
  fireEvent.drop(tree, { dataTransfer: data });
  await waitFor(() => {
    const call = fetch.mock.calls.find(
      ([path, init]) =>
        String(path).includes("/move") && init?.method === "POST",
    );
    expect(call).toBeTruthy();
    expect(JSON.parse(call[1].body).moves).toEqual([
      { source: "a/b.txt", destination: "b.txt" },
    ]);
  });
});

it("deletes checked files in batch after confirmation and refreshes the list", async () => {
  const fetch = vi.fn(async (url, init = {}) => {
    const path = String(url);
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (path.includes("/files?"))
      return new Response(
        JSON.stringify([
          { name: "a.txt", path: "a.txt", kind: "file", size: 5 },
          { name: "b.txt", path: "b.txt", kind: "file", size: 6 },
        ]),
        { headers: { "content-type": "application/json" } },
      );
    return new Response("[]", {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  render(<WorkspaceFileManager workspace={{ id: "project-a", name: "P" }} />);
  fireEvent.click(await screen.findByLabelText("选择 a.txt"));
  fireEvent.click(screen.getByLabelText("选择 b.txt"));
  expect(await screen.findByText("已选择 2 项")).toBeTruthy();
  expect(screen.getByRole("button", { name: "下载" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  expect(await screen.findByText("确认删除 2 项？")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => {
    const deleted = fetch.mock.calls
      .filter(([, init]) => init?.method === "DELETE")
      .map(([path]) => String(path));
    expect(deleted.some((path) => path.includes("path=a.txt"))).toBe(true);
    expect(deleted.some((path) => path.includes("path=b.txt"))).toBe(true);
  });
  expect(await screen.findByText("已删除 2 项")).toBeTruthy();
  await waitFor(() =>
    expect(
      fetch.mock.calls.filter(
        ([path, init]) => String(path).includes("/files?") && !init?.method,
      ).length,
    ).toBeGreaterThan(1),
  );
});
