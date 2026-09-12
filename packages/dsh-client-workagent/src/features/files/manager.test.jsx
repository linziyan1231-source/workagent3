// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceFileManager } from "./manager.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("loads and previews a project file without the application shell, preserving its text", async () => {
  const fetch = vi.fn(async (url) => {
    if (String(url).includes("/content?")) return new Response("<script>unsafe()</script>Full Access");
    return new Response(JSON.stringify(String(url).includes("/files?") ? [{ name: "note.txt", path: "note.txt", kind: "file", size: 30 }] : []), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  const view = render(<WorkspaceFileManager workspace={{ id: "project/one", name: "Project" }} />);
  fireEvent.click(await screen.findByRole("button", { name: "note.txt", exact: true }));
  expect(await screen.findByText("<script>unsafe()</script>Full Access")).toBeTruthy();
  expect(view.container.querySelector("script")).toBeNull();
  expect(fetch.mock.calls.every(([url]) => String(url).includes("/project%2Fone/"))).toBe(true);
  view.unmount();
  fetch.mockClear();
  window.dispatchEvent(new Event("workagent:files-changed"));
  expect(fetch).not.toHaveBeenCalled();
});
