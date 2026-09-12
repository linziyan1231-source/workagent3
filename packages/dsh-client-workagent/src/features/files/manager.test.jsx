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

it("releases replaced and late search cursors and hides publishing from shared members", async () => {
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
  await screen.findByRole("button", { name: "继续搜索" });
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
