// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createShared } from "./src/shared.js";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("uses authenticated shared routes, retains failed drafts and identifies the assistant explicitly", async () => {
  const calls = [];
  const request = vi.fn(async (path, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body, method: init?.method });
    if (path.endsWith("/members")) return { members: [{ userId: 1, displayName: "张同事", role: "member" }] };
    if (path.endsWith("/shared-files")) return { data: [] };
    if (path.includes("/shared-messages?")) return { messages: [] };
    if (path.endsWith("/shared-messages")) {
      if (body.body === "失败草稿") throw new Error("连接中断");
      return { ai_started: true, message: { id: "message", body: body.body, created_at: "2026-09-08T00:00:00Z", author_name: "我" } };
    }
    return {};
  });
  const resources = {
    "shared-projects": [{ id: "project", name: "共享资料", currentRole: "member" }],
    "shared-invites": [],
    "shared-conversations": [{ id: "chat", project_id: "project", name: "工作讨论", assistant_id: "assistant" }],
    presets: [], "model-options": [],
  };
  const Page = createShared({ React, request, apiRoot: "/api/runtime/v1", friendlyError: (value) => value,
    useResource: (path) => [{ rows: resources[path.split("/").at(-1).split("?")[0]], error: "" }, async () => {}],
    Section: ({ children }) => <section>{children}</section>, Button: ({ children, ...props }) => <button type="button" {...props}>{children}</button>,
    Input: (props) => <input {...props} />, Markdown: ({ children }) => <p>{children}</p>,
  });
  const close = vi.fn();
  vi.stubGlobal("EventSource", class { close = close; });
  const view = render(<Page />);
  fireEvent.change(screen.getByLabelText("选择共享项目"), { target: { value: "project" } });
  await screen.findByText("张同事 · 成员");
  expect(screen.queryByText("邀请同事")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "工作讨论" }));
  fireEvent.change(screen.getByLabelText("共享消息"), { target: { value: "失败草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await screen.findByText("连接中断");
  expect(screen.getByLabelText("共享消息").value).toBe("失败草稿");
  fireEvent.change(screen.getByLabelText("共享消息"), { target: { value: "请处理资料" } });
  fireEvent.click(screen.getByLabelText("请助手回复"));
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await waitFor(() => expect(screen.getByLabelText("共享消息").value).toBe(""));
  expect(calls.find((call) => call.body?.body === "请处理资料").body).toMatchObject({ conversation_id: "chat", mentions: [{ kind: "assistant", id: "assistant" }] });
  view.unmount(); expect(close).toHaveBeenCalledOnce();
});
