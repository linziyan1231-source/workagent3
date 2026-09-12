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
import { FeedbackForm } from "./feedback.js";
vi.mock("../../platform/api.js", () => ({
  request: vi.fn(async () => ({ items: [] })),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("retains a failed report and retries with the same operation identity", async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error("网络中断"))
    .mockResolvedValue({ ok: true, json: async () => ({ id: "report-1" }) });
  vi.stubGlobal("fetch", fetch);
  render(<FeedbackForm />);
  fireEvent.change(screen.getByLabelText("问题描述"), {
    target: { value: "文件打不开" },
  });
  fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
  await screen.findByText("网络中断");
  expect(screen.getByLabelText("问题描述").value).toBe("文件打不开");
  fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
  await screen.findByText("已保存反馈 report-1");
  expect(fetch.mock.calls[0][1].body.get("requestId")).toBe(
    fetch.mock.calls[1][1].body.get("requestId"),
  );
  expect(screen.getByLabelText("问题描述").value).toBe("");
});

it("allows reviewing and editing the diagnostic attachment before submission", async () => {
  const fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ id: "report-2" }),
  }));
  vi.stubGlobal("fetch", fetch);
  render(<FeedbackForm />);
  fireEvent.click(screen.getByRole("button", { name: "预览诊断摘要" }));
  fireEvent.change(screen.getByLabelText("诊断摘要"), {
    target: { value: "reviewed summary" },
  });
  fireEvent.click(screen.getByRole("button", { name: "附加这份摘要" }));
  expect(screen.getByText("diagnostic-summary.txt")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("问题描述"), {
    target: { value: "issue" },
  });
  fireEvent.click(screen.getByRole("button", { name: "提交反馈" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(fetch.mock.calls[0][1].body.getAll("attachments")).toHaveLength(1);
});
