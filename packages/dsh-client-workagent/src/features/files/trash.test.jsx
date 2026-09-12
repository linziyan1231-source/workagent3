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
import { createFileTrash } from "./trash.js";

afterEach(cleanup);
const firstRoot = "/api/portal/shared-workspaces/project-a/trash";
const secondRoot = "/api/portal/shared-workspaces/project-b/trash";
const row = {
  id: "deleted-a",
  name: "设计说明.txt",
  path: "资料/设计说明.txt",
  kind: "file",
  size: 1024,
  deletedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
};
const listing = (entries = [row]) => ({
  entries,
  usedBytes: 3 * 1024 ** 3,
  projectUsedBytes: entries.reduce((size, entry) => size + entry.size, 0),
  limitBytes: 60 * 1024 ** 3,
  retentionDays: 7,
});
function viewFor(request) {
  const { useFileTrash } = createFileTrash({
    React,
    request,
    h: React.createElement,
    Icon: ({ name }) => <svg data-icon={name} />,
    Button: ({ children, ...props }) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    FileIconButton: ({ name, label, ...props }) => (
      <button type="button" aria-label={label} {...props}>
        <svg data-icon={name} />
      </button>
    ),
    FileTreeRow: ({ children, className }) => (
      <div className={`workagent-file-tree-row ${className}`}>{children}</div>
    ),
    friendlyError: (value) => value,
    fileSize: (size) => `${size} B`,
  });
  return function View({ root = firstRoot, enabled = true }) {
    const trash = useFileTrash({ root, enabled });
    return enabled ? (
      <div>
        <button onClick={trash.refresh}>刷新回收站</button>
        {trash.content}
      </div>
    ) : null;
  };
}
const openMenu = async (name = row.name) =>
  fireEvent.click(await screen.findByRole("button", { name: `操作 ${name}` }));

it("loads only the selected project's entries and confirms restoration before sending it", async () => {
  let entries = [row];
  const request = vi.fn(async (path, options = {}) => {
    if (
      path === `${firstRoot}/${row.id}/restore` &&
      options.method === "POST"
    ) {
      entries = [];
      return { path: row.path, name: row.name };
    }
    expect(path).toBe(firstRoot);
    return listing(entries);
  });
  const View = viewFor(request);
  render(<View />);
  await openMenu();
  expect(screen.getByText(row.path)).toBeTruthy();
  expect(screen.getByText("3.0 GB / 60.0 GB")).toBeTruthy();
  expect(screen.getByText(/按删除时间从早到晚自动清理/)).toBeTruthy();
  expect(screen.getByLabelText("共享回收空间使用量").max).toBe(60 * 1024 ** 3);
  fireEvent.click(screen.getByRole("button", { name: "恢复", exact: true }));
  expect(request.mock.calls.some(([, options]) => options?.method)).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
  await screen.findByText(`已恢复“${row.name}”`);
  await screen.findByText("本项目回收站为空");
  expect(request).toHaveBeenCalledWith(`${firstRoot}/${row.id}/restore`, {
    method: "POST",
  });
});

it("keeps the item when its original path conflicts and never requests an overwrite", async () => {
  const request = vi.fn(async (_path, options = {}) => {
    if (options.method === "POST")
      throw Object.assign(new Error("file_exists"), { status: 409 });
    return listing();
  });
  const View = viewFor(request);
  render(<View />);
  await openMenu();
  fireEvent.click(screen.getByRole("button", { name: "恢复", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "原位置已有同名文件。请先在项目文件中重命名或移走同名文件，再恢复。",
  );
  expect(screen.getByText(row.name)).toBeTruthy();
  expect(
    request.mock.calls.find(([, options]) => options?.method === "POST")[1],
  ).toEqual({ method: "POST" });
});

it("confirms permanent deletion of a directory and refreshes this project's list", async () => {
  const directory = {
    ...row,
    id: "deleted-dir",
    name: "归档",
    path: "归档",
    kind: "directory",
  };
  let entries = [directory];
  const request = vi.fn(async (path, options = {}) => {
    if (options.method === "DELETE") {
      expect(path).toBe(`${firstRoot}/deleted-dir`);
      entries = [];
      return {};
    }
    return listing(entries);
  });
  const View = viewFor(request);
  render(<View />);
  await openMenu(directory.name);
  fireEvent.click(
    screen.getByRole("button", { name: "永久删除", exact: true }),
  );
  expect(
    screen.getByText("永久删除“归档”及其内容？此操作无法撤销。"),
  ).toBeTruthy();
  expect(request.mock.calls.some(([, options]) => options?.method)).toBe(false);
  fireEvent.click(
    within(screen.getByRole("form", { name: "永久删除文件" })).getByRole(
      "button",
      { name: "永久删除" },
    ),
  );
  await screen.findByText("本项目回收站为空");
  expect(await screen.findByText("已永久删除“归档”")).toBeTruthy();
});

it("discards delayed responses from a previously selected project", async () => {
  let resolveFirst;
  const request = vi.fn((root) =>
    root === firstRoot
      ? new Promise((resolve) => {
          resolveFirst = resolve;
        })
      : Promise.resolve(
          listing([
            {
              ...row,
              id: "deleted-b",
              name: "当前项目.txt",
              path: "当前项目.txt",
            },
          ]),
        ),
  );
  const View = viewFor(request);
  const mounted = render(<View />);
  expect(screen.getByText("正在加载回收站…")).toBeTruthy();
  mounted.rerender(<View root={secondRoot} />);
  await screen.findByRole("button", { name: "操作 当前项目.txt" });
  await act(async () => resolveFirst(listing()));
  expect(screen.queryByText(row.name)).toBeNull();
  expect(request.mock.calls[0][1].signal.aborted).toBe(true);
});

it("shows a useful loading error and reloads without leaving the file manager", async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error("连接暂时中断"))
    .mockResolvedValue(listing([]));
  const View = viewFor(request);
  render(<View />);
  await screen.findByText("暂时无法读取回收站");
  expect(screen.getByRole("alert").textContent).toBe("连接暂时中断");
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await screen.findByText("本项目回收站为空");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("labels legacy root restores and avoids loading when the recycle view is closed", async () => {
  const request = vi.fn(async () => listing([{ ...row, legacy: true }]));
  const View = viewFor(request);
  const mounted = render(<View enabled={false} />);
  expect(request).not.toHaveBeenCalled();
  mounted.rerender(<View />);
  await openMenu();
  expect(screen.getByText("旧版记录 · 恢复至根目录")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "恢复", exact: true }));
  expect(screen.getByText(`将“${row.name}”恢复到项目根目录？`)).toBeTruthy();
  mounted.unmount();
  await waitFor(() =>
    expect(request.mock.calls[0][1].signal.aborted).toBe(true),
  );
});
