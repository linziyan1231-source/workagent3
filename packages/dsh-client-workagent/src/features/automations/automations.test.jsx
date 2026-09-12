// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createAutomations } from "./automations.js";
import {
  Button,
  Card,
  Field,
  Input,
  Section,
  Select,
  Status,
} from "../../ui/elements.js";
afterEach(cleanup);

it("creates a once task using the selected local time and keeps schedule options out of the assistant picker", async () => {
  const request = vi.fn(async () => ({}));
  const Page = createAutomations({
    React,
    request,
    apiRoot: "/v1",
    useResource: (path) => [
      {
        rows: path.endsWith("workspaces")
          ? [{ id: "default", name: "Default" }]
          : [],
        loading: false,
      },
      vi.fn(),
    ],
    usePresets: () => [
      {
        rows: [
          {
            id: "builtin-codex",
            name: "Codex",
            engine: "codex",
            enabled: true,
          },
        ],
      },
    ],
    Section,
    Field,
    Input,
    Select,
    Button,
    Card,
    Status,
    friendlyError: (text) => text,
  });
  render(<Page />);
  expect(
    within(screen.getByLabelText("执行助手")).queryByRole("option", {
      name: "指定时间执行一次",
    }),
  ).toBeNull();
  fireEvent.change(screen.getByLabelText("任务名称"), {
    target: { value: "One report" },
  });
  fireEvent.change(screen.getByLabelText("执行助手"), {
    target: { value: "builtin-codex" },
  });
  fireEvent.change(screen.getByLabelText("所属项目"), {
    target: { value: "default" },
  });
  fireEvent.change(screen.getByLabelText("任务内容"), {
    target: { value: "Prepare report" },
  });
  fireEvent.change(screen.getByLabelText("执行频率"), {
    target: { value: "once" },
  });
  fireEvent.change(screen.getByLabelText(/^执行时间（/), {
    target: { value: "2099-01-01T09:30" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
  await waitFor(() => expect(request).toHaveBeenCalled());
  expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({
    schedule: { kind: "once", at: new Date("2099-01-01T09:30").toISOString() },
    presetId: "builtin-codex",
    engine: "codex",
  });
});
