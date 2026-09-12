// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ConversationMenu,
  ConversationManagementDialog,
} from "./conversation-management.js";

afterEach(cleanup);

it("shows the common conversation actions with the current pin state and optional reminder", () => {
  const pin = vi.fn(),
    reminder = vi.fn(),
    manage = vi.fn(),
    close = vi.fn();
  const props = {
    title: "设计任务",
    projectName: "共享项目",
    onPin: pin,
    onReminder: reminder,
    onManage: manage,
    onClose: close,
  };
  const view = render(<ConversationMenu {...props} pinned={false} />);
  expect(screen.getByRole("dialog", { name: "对话操作" })).toBeTruthy();
  expect(screen.getByText("项目：共享项目")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "置顶对话" }));
  fireEvent.click(screen.getByRole("button", { name: "消息提醒" }));
  fireEvent.click(screen.getByRole("button", { name: "管理对话" }));
  expect(pin).toHaveBeenCalledOnce();
  expect(reminder).toHaveBeenCalledOnce();
  expect(manage).toHaveBeenCalledOnce();
  view.rerender(<ConversationMenu {...props} pinned onReminder={undefined} />);
  expect(screen.getByRole("button", { name: "取消置顶" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "消息提醒" })).toBeNull();
  fireEvent.keyDown(document.activeElement, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

it("edits the controlled name and requires the separate delete confirmation", () => {
  const save = vi.fn(),
    remove = vi.fn(),
    close = vi.fn();
  function Example() {
    const [name, setName] = React.useState("旧名称");
    const [deleting, setDeleting] = React.useState(false);
    return (
      <ConversationManagementDialog
        name={name}
        onNameChange={setName}
        onSave={() => save(name)}
        onDelete={remove}
        onRequestDelete={() => setDeleting(true)}
        onClose={close}
        deleting={deleting}
        deleteDescription="只删除个人任务，对共享项目文件没有影响。"
      />
    );
  }
  render(<Example />);
  const input = screen.getByRole("textbox", { name: "对话名称" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "  " } });
  expect(screen.getByRole("button", { name: "保存" }).disabled).toBe(true);
  fireEvent.submit(screen.getByRole("dialog", { name: "管理对话" }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "新名称" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(save).toHaveBeenCalledWith("新名称");
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  expect(screen.getByRole("dialog", { name: "确认删除" })).toBeTruthy();
  expect(
    screen.getByText("只删除个人任务，对共享项目文件没有影响。"),
  ).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  expect(remove).toHaveBeenCalledOnce();
});

it("keeps an in-flight management action open and shows its recoverable error", () => {
  const save = vi.fn(),
    remove = vi.fn(),
    close = vi.fn();
  const props = {
    name: "设计任务",
    onNameChange: vi.fn(),
    onSave: save,
    onDelete: remove,
    onRequestDelete: vi.fn(),
    onClose: close,
  };
  const view = render(<ConversationManagementDialog {...props} busy />);
  expect(screen.getByRole("textbox").disabled).toBe(true);
  expect(screen.getAllByRole("button").every((button) => button.disabled)).toBe(
    true,
  );
  fireEvent.keyDown(document.activeElement, { key: "Escape" });
  fireEvent.submit(screen.getByRole("dialog"));
  expect(save).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  view.rerender(
    <ConversationManagementDialog {...props} error="名称未能保存，请重试。" />,
  );
  expect(screen.getByRole("alert").textContent).toBe("名称未能保存，请重试。");
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(save).toHaveBeenCalledOnce();
});
