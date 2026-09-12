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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspacesPage } from "./page.js";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("../../host/navigation.js", () => ({
  navigation: { navigate },
}));

beforeEach(() => {
  const saved = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, String(value)),
    removeItem: (key) => saved.delete(key),
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  navigate.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const workspaceRoot = "/api/runtime/v1/workspaces";
const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

function fixture({ files = [], text = "", intercept } = {}) {
  const projects = [
    {
      id: "first",
      name: "First",
      directory: "first-project",
      scope: "personal",
    },
    {
      id: "second",
      name: "Second",
      directory: "second-project",
      scope: "personal",
    },
  ];
  const fetch = vi.fn(async (url, init = {}) => {
    const path = String(url);
    const intercepted = intercept?.(path, init);
    if (intercepted !== undefined) return intercepted;
    if (path === workspaceRoot) {
      if (init.method === "POST") {
        const project = { id: "created", ...JSON.parse(init.body) };
        projects.push(project);
        return json(project);
      }
      return json(projects);
    }
    if (path.includes("/files?")) return json(files);
    if (path.endsWith("/move") && !init.method) return json([]);
    if (path.includes("/uploads")) return json([]);
    if (path === "/api/runtime/v1/office-preview/convert")
      return json({ hash: "office-preview" });
    if (path === "/api/runtime/v1/office-preview/content/office-preview.pdf")
      return new Response("pdf", {
        headers: { "content-type": "application/pdf" },
      });
    if (path.endsWith("document-preview.html"))
      return new Response("<html>__JSZIP_SOURCE____DOCX_SOURCE__</html>");
    if (path.endsWith("jszip.js") || path.endsWith("docx-preview.js"))
      return new Response("/* viewer */");
    if (path.includes("/content?")) return new Response(text);
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function openProject(index = 0) {
  fireEvent.click(
    (await screen.findAllByRole("button", { name: "管理文件" }))[index],
  );
  return screen.getByRole("region", { name: "项目文件" });
}

it("renders Markdown and its source through the shared file manager below the selected project", async () => {
  fixture({
    files: [{ name: "notes.md", path: "notes.md", kind: "file", size: 25 }],
    text: "# Project notes\n\n**Ready**",
  });
  const view = render(<WorkspacesPage />);
  const manager = await openProject();
  const cards = view.container.querySelectorAll(".workagent-workspace-card");
  expect(cards[0].nextElementSibling).toBe(manager);
  expect(manager.nextElementSibling).toBe(cards[1]);
  expect(
    within(manager).getByRole("button", { name: "上传文件" }),
  ).toBeTruthy();
  expect(within(manager).getByLabelText("选择上传文件").multiple).toBe(true);
  fireEvent.click(
    await within(manager).findByRole("button", {
      name: "notes.md",
      exact: true,
    }),
  );
  expect(
    await within(manager).findByRole("heading", { name: "Project notes" }),
  ).toBeTruthy();
  expect(
    within(manager).getByRole("button", { name: "编辑文件" }),
  ).toBeTruthy();
  fireEvent.click(within(manager).getByRole("button", { name: "源码" }));
  expect(
    within(manager).getByText("# Project notes", { exact: false }).tagName,
  ).toBe("PRE");
  fireEvent.click(
    within(manager).getByRole("button", { name: "返回文件列表" }),
  );
  fireEvent.click(
    within(manager).getByRole("button", { name: "操作 notes.md" }),
  );
  expect(within(manager).getByRole("button", { name: "移动到…" })).toBeTruthy();
});

it.each(["xlsx", "pptx"])(
  "previews %s files with the shared Office converter",
  async (extension) => {
    const name = `report.${extension}`;
    const fetch = fixture({
      files: [{ name, path: name, kind: "file", size: 100 }],
    });
    render(<WorkspacesPage />);
    const manager = await openProject();
    fireEvent.click(
      await within(manager).findByRole("button", { name, exact: true }),
    );
    const preview = await waitFor(() => {
      const frame = manager.querySelector("iframe");
      expect(frame?.title).toBe(name);
      return frame;
    });
    expect(preview.getAttribute("src")).toContain(
      "/office-preview/content/office-preview.pdf",
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/office-preview/convert",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ workspace: "first-project", path: name }),
      }),
    );
    expect(
      within(manager).queryByText("此文件暂不支持预览，请下载后查看。"),
    ).toBeNull();
  },
);

it("previews DOCX with the shared document viewer", async () => {
  const name = "report.docx";
  fixture({ files: [{ name, path: name, kind: "file", size: 100 }] });
  render(<WorkspacesPage />);
  const manager = await openProject();
  fireEvent.click(
    await within(manager).findByRole("button", { name, exact: true }),
  );
  const preview = await waitFor(() => {
    const frame = manager.querySelector("iframe");
    expect(frame?.title).toBe(name);
    return frame;
  });
  expect(preview.getAttribute("sandbox")).toBe("allow-scripts");
  expect(preview.getAttribute("srcdoc")).toContain("/* viewer */");
});

it("unmounts the old manager and aborts its requests when another project is opened", async () => {
  let resolveFirst;
  let firstSignal;
  fixture({
    intercept: (path, init) => {
      if (path === `${workspaceRoot}/first/files?path=`) {
        firstSignal = init.signal;
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      if (path === `${workspaceRoot}/second/files?path=`)
        return json([
          { name: "second.txt", path: "second.txt", kind: "file", size: 10 },
        ]);
    },
  });
  render(<WorkspacesPage />);
  await openProject();
  await waitFor(() => expect(firstSignal).toBeTruthy());
  const secondManager = await openProject(1);
  await within(secondManager).findByRole("button", {
    name: "second.txt",
    exact: true,
  });
  expect(firstSignal.aborted).toBe(true);
  expect(screen.getAllByRole("region", { name: "项目文件" })).toHaveLength(1);
  await act(async () => {
    resolveFirst(
      json([{ name: "stale.txt", path: "stale.txt", kind: "file" }]),
    );
  });
  expect(screen.queryByRole("button", { name: "stale.txt" })).toBeNull();
});

it("clears open file tabs when search hides a project and preserves the new conversation entry", async () => {
  fixture({
    files: [{ name: "notes.txt", path: "notes.txt", kind: "file", size: 10 }],
    text: "Project content",
  });
  render(<WorkspacesPage />);
  const manager = await openProject();
  fireEvent.click(
    await within(manager).findByRole("button", {
      name: "notes.txt",
      exact: true,
    }),
  );
  await within(manager).findByText("Project content");
  fireEvent.change(screen.getByRole("textbox", { name: "搜索项目" }), {
    target: { value: "Second" },
  });
  expect(screen.queryByRole("region", { name: "项目文件" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
  expect(navigate).toHaveBeenCalledWith("/?frontend=dsh&project=second");
  fireEvent.click(screen.getByRole("button", { name: "清除项目搜索" }));
  await screen.findByRole("button", { name: "notes.txt", exact: true });
  expect(screen.queryByRole("navigation", { name: "已打开文件" })).toBeNull();
  expect(screen.queryByText("Project content")).toBeNull();
});

it("creates a project and opens its shared file manager after clearing the filter", async () => {
  const fetch = fixture();
  render(<WorkspacesPage />);
  await screen.findByText("2 个项目");
  fireEvent.change(screen.getByRole("textbox", { name: "搜索项目" }), {
    target: { value: "missing" },
  });
  fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
  fireEvent.change(screen.getByRole("textbox", { name: "新项目名称" }), {
    target: { value: "Created project" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "创建项目", exact: true }),
  );
  const manager = await screen.findByRole("region", { name: "项目文件" });
  expect(within(manager).getByText("Created project")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "搜索项目" }).value).toBe("");
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      `${workspaceRoot}/created/files?path=`,
      expect.any(Object),
    ),
  );
});

it("routes files dropped into the shared manager to the selected project and directory", async () => {
  const fetch = fixture({
    intercept: (path, init) => {
      if (path === `${workspaceRoot}/second/files?path=`)
        return json([{ name: "docs", path: "docs", kind: "directory" }]);
      if (path === `${workspaceRoot}/second/uploads` && init.method === "POST")
        return json({ ...JSON.parse(init.body), id: "upload", offset: 0 });
      if (path === `${workspaceRoot}/second/uploads/upload/complete`)
        return json({ path: "docs/drop.txt" });
    },
  });
  render(<WorkspacesPage />);
  const manager = await openProject(1);
  fireEvent.click(
    await within(manager).findByRole("button", { name: "docs", exact: true }),
  );
  fireEvent.drop(manager.querySelector(".workagent-file-manager"), {
    dataTransfer: {
      types: ["Files"],
      files: [new File([], "drop.txt", { lastModified: 1 })],
    },
  });
  await within(manager).findByText("已上传 1 个文件");
  expect(fetch).toHaveBeenCalledWith(
    `${workspaceRoot}/second/uploads`,
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        path: "docs/drop.txt",
        name: "drop.txt",
        size: 0,
        lastModified: 1,
      }),
    }),
  );
});
