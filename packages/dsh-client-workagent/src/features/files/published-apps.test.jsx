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
import { PublishedApps } from "./published-apps.js";
import { request } from "../../platform/api.js";
vi.mock("../../platform/api.js", () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(request).mockReset();
});
const app = {
  id: "app1",
  workspaceId: "project1",
  name: "Report",
  kind: "static",
  entry: "index.html",
  versions: [],
  enabled: false,
};

it("preserves the shared project identity when creating an owner publication", async () => {
  vi.mocked(request).mockImplementation(async (path, options) => {
    if (options?.method === "POST") {
      expect(JSON.parse(options.body).workspaceId).toBe("shared:project1");
      throw new Error("stop after creation check");
    }
    return { items: [] };
  });
  render(
    <PublishedApps
      workspace={{ id: "project1", name: "Shared", currentRole: "owner" }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "创建并预览" }));
  await screen.findByRole("alert");
  expect(
    vi
      .mocked(request)
      .mock.calls.some(([, options]) => options?.method === "POST"),
  ).toBe(true);
});

it("keeps a created application available for retry after preview failure", async () => {
  let created = false;
  vi.mocked(request).mockImplementation(async (path, options) => {
    if (path === "/api/portal/apps" && options?.method === "POST") {
      created = true;
      return app;
    }
    if (path === "/api/portal/apps") return { items: created ? [app] : [] };
    throw new Error("application_port_unavailable");
  });
  render(<PublishedApps workspace={{ id: "project1", name: "Report" }} />);
  fireEvent.click(screen.getByRole("button", { name: "创建并预览" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "预览" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "创建并预览" }).disabled).toBe(
    false,
  );
});

it("sends preview access through a POST form without placing its ticket in the URL", async () => {
  const submit = vi
    .spyOn(HTMLFormElement.prototype, "submit")
    .mockImplementation(function () {
      expect(this.method).toBe("post");
      expect(this.action).toBe("http://192.0.2.1:21001/__workagent/access");
      expect(this.querySelector('[name="ticket"]').value).toBe(
        "private-ticket",
      );
      expect(this.target).toBe(screen.getByTitle("交互式应用预览").name);
    });
  vi.mocked(request).mockImplementation(async (path) => {
    if (path === "/api/portal/apps") return { items: [app] };
    if (path.endsWith("/previews")) return app;
    if (path.includes("access-ticket"))
      return {
        url: "http://192.0.2.1:21001/__workagent/access",
        ticket: "private-ticket",
      };
    throw new Error(path);
  });
  render(<PublishedApps workspace={{ id: "project1", name: "Report" }} />);
  fireEvent.click(await screen.findByRole("button", { name: "预览" }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(screen.getByTitle("交互式应用预览").getAttribute("src")).toBeNull();
});
