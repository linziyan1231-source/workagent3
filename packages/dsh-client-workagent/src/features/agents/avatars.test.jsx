// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { createAssistantAvatars, readAssistantAvatar } from "./avatars.js";
afterEach(cleanup);
const setup = (request = vi.fn().mockResolvedValue([])) =>
  createAssistantAvatars({
    React,
    request,
    apiRoot: "/api/runtime/v1",
    EngineMark: ({ engine }) => <i data-testid="engine">{engine}</i>,
  });
it("uses custom identity and gracefully falls back when an image fails", () => {
  const { AssistantAvatar } = setup();
  const { container, rerender } = render(
    <AssistantAvatar
      preset={{ id: "custom", name: "设计师", engine: "codex" }}
    />,
  );
  expect(screen.getByText("设")).toBeTruthy();
  expect(screen.queryByTestId("engine")).toBeNull();
  rerender(
    <AssistantAvatar
      preset={{ name: "设计师", avatar: "https://example.test/avatar.png" }}
    />,
  );
  fireEvent.error(container.querySelector("img"));
  expect(screen.getByText("设")).toBeTruthy();
});
it("refreshes current avatars for existing sessions without changing their snapshots", async () => {
  const request = vi
    .fn()
    .mockResolvedValue([{ id: "custom", name: "设计师", avatar: "emoji:🎨" }]);
  const { SessionAvatar } = setup(request);
  const session = {
    preset: {
      presetId: "custom",
      resolvedSnapshot: { name: "设计师", avatar: null },
    },
  };
  render(
    <>
      <SessionAvatar session={session} />
      <SessionAvatar session={session} />
    </>,
  );
  await waitFor(() => expect(screen.getAllByText("🎨")).toHaveLength(2));
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValue([
    { id: "custom", name: "设计师", avatar: "emoji:🐼" },
  ]);
  window.dispatchEvent(new Event("workagent:presets-changed"));
  await waitFor(() => expect(screen.getAllByText("🐼")).toHaveLength(2));
  expect(session.preset.resolvedSnapshot.avatar).toBeNull();
});
it("selects, resets and reports save errors", async () => {
  const { AvatarPicker } = setup();
  const save = vi.fn().mockRejectedValueOnce(new Error("保存失败"));
  render(
    <AvatarPicker preset={{ name: "助手" }} value="emoji:🦊" onChange={save} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "使用🐼头像" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "保存失败",
  );
  expect(save).toHaveBeenCalledWith("emoji:🐼");
  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(null));
});
it("rejects unsupported or oversized uploads before decoding", async () => {
  await expect(
    readAssistantAvatar(new File(["text"], "a.txt", { type: "text/plain" })),
  ).rejects.toThrow("PNG");
  await expect(
    readAssistantAvatar({ type: "image/png", size: 6 * 1024 * 1024 }),
  ).rejects.toThrow("5 MB");
});
