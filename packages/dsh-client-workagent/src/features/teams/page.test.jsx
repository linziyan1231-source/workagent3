// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TeamsPage } from "./page.js";

const fixture = vi.hoisted(() => ({
  team: {
    id: "team-a",
    name: "Reviewers",
    workspaceId: "workspace-a",
    members: [
      {
        id: "lead",
        name: "Lead",
        role: "lead",
        status: "idle",
        engine: "codex",
        presetId: "builtin-codex",
        sessionId: "session-a",
      },
    ],
  },
}));
vi.mock("../../platform/resources.js", () => ({
  useResource: (path) => [
    {
      rows: path.endsWith("teams") ? [fixture.team] : [],
      loading: false,
      error: "",
    },
    vi.fn(),
  ],
}));
vi.mock("../agents/api.js", () => ({
  usePresets: () => [
    {
      rows: [
        { id: "builtin-codex", name: "Codex", engine: "codex", enabled: true },
      ],
    },
    vi.fn(),
  ],
}));
vi.mock("../content/index.js", () => ({
  Markdown: ({ children }) => <div>{children}</div>,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("starts a durable team run on HTTP and exposes pause, resume and cancellation without promising rollback", async () => {
  let run;
  const fetch = vi.fn(async (path, init = {}) => {
    if (init.method === "POST") {
      if (path.endsWith("/runs"))
        run = {
          id: "run-a",
          input: JSON.parse(init.body).input,
          status: "running",
          segment: 1,
          dispatchCount: 1,
        };
      if (path.endsWith("/pause")) run = { ...run, status: "paused" };
      if (path.endsWith("/resume"))
        run = { ...run, status: "running", segment: 2 };
      if (path.endsWith("/cancel")) run = { ...run, status: "cancelled" };
      return new Response(JSON.stringify(run), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify(path.endsWith("/runs") && run ? [run] : []),
      { headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("crypto", { getRandomValues: (bytes) => bytes.fill(7) });
  render(<TeamsPage />);
  fireEvent.click(screen.getByRole("button", { name: "交给团队自主完成" }));
  fireEvent.change(screen.getByLabelText("团队操作内容"), {
    target: { value: "Review and summarize" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  await screen.findByText("团队协作中");
  expect(
    JSON.parse(
      fetch.mock.calls.find(
        ([path, init]) => path.endsWith("/runs") && init.method === "POST",
      )[1].body,
    ),
  ).toEqual({ input: "Review and summarize", operationId: "07".repeat(16) });
  fireEvent.click(screen.getByRole("button", { name: "暂停后续协作" }));
  await screen.findByText("已暂停");
  fireEvent.click(screen.getByRole("button", { name: "继续协作" }));
  await screen.findByText("第 2 段 · 已执行 1/64 个成员回合");
  expect(screen.getByText(/已发生的文件和网络操作不会自动撤销/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "取消本次协作" }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "取消本次协作" })).toBeNull(),
  );
});
