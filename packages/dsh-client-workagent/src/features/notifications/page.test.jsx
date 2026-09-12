// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationsPage } from "./page.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("acknowledges a notification before navigating and remains on the page when acknowledgment fails", async () => {
  history.replaceState(null, "", "/?workagent=notifications");
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  let fail = true;
  const fetch = vi.fn(async (url, init) => {
    if (String(url).endsWith("/acknowledge") && fail) return new Response('{"error":"delivery_unavailable"}', { status: 503 });
    return new Response(JSON.stringify(init?.method === "POST" ? {} : { notifications: [{ id: "notice/1", title: "任务完成", deep_link: "/?session=done" }] }), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  render(<NotificationsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "打开并标记已读" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(location.search).toBe("?workagent=notifications");
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => url)).toEqual([
    "/api/portal/me/notifications/notice%2F1/read", "/api/portal/me/notifications/notice%2F1/acknowledge",
  ]);
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "打开并标记已读" }));
  await waitFor(() => expect(location.search).toContain("session=done"));
});
