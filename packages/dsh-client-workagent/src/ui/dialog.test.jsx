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
import { Dialog, useConfirm } from "./dialog.js";
import { Button } from "./elements.js";

afterEach(cleanup);

it("traps keyboard focus, closes with Escape, and restores the opener", () => {
  function Example() {
    const [open, setOpen] = React.useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>打开</button>
        {open && (
          <Dialog title="名称" onClose={() => setOpen(false)}>
            <input aria-label="名称" />
            <Button>保存</Button>
          </Dialog>
        )}
      </>
    );
  }
  render(<Example />);
  const opener = screen.getByRole("button", { name: "打开" });
  opener.focus();
  fireEvent.click(opener);
  expect(document.activeElement).toBe(screen.getByRole("textbox"));
  screen.getByRole("button", { name: "保存" }).focus();
  fireEvent.keyDown(document.activeElement, { key: "Tab" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "关闭" }),
  );
  fireEvent.keyDown(document.activeElement, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "保存" }),
  );
  fireEvent.keyDown(document.activeElement, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it("only confirms the destructive operation after explicit confirmation and keeps its parent dialog open", async () => {
  const remove = vi.fn();
  function Example() {
    const { confirm, confirmation } = useConfirm();
    return (
      <>
        {confirmation}
        <Dialog title="操作" onClose={() => {}}>
          <Button
            onClick={async () => {
              if (
                await confirm({
                  title: "删除任务",
                  description: "删除后无法恢复",
                  danger: true,
                  confirmLabel: "确认删除",
                })
              )
                remove();
            }}
          >
            删除
          </Button>
        </Dialog>
      </>
    );
  }
  render(<Example />);
  fireEvent.click(screen.getByRole("button", { name: "删除", exact: true }));
  const confirmation = screen.getByRole("alertdialog");
  expect(document.activeElement).toBe(
    within(confirmation).getByRole("button", { name: "取消" }),
  );
  expect(Number(confirmation.parentElement.style.zIndex)).toBeGreaterThan(
    Number(screen.getByRole("dialog").parentElement.style.zIndex),
  );
  fireEvent.keyDown(document.activeElement, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "删除", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  await waitFor(() => expect(remove).toHaveBeenCalledOnce());
});

it("keeps a busy dialog open and skips disabled controls for initial focus", () => {
  const close = vi.fn();
  render(
    <Dialog title="保存" closeDisabled onClose={close}>
      <input disabled aria-label="不可编辑" />
      <textarea aria-label="内容" />
    </Dialog>,
  );
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "内容" }),
  );
  fireEvent.keyDown(document.activeElement, { key: "Escape" });
  fireEvent.mouseDown(screen.getByRole("dialog").parentElement);
  expect(close).not.toHaveBeenCalled();
});

it("traps focus across collapsed member menus and excludes controls hidden by CSS", () => {
  render(
    <Dialog title="项目成员" onClose={() => {}}>
      <input aria-label="隐藏搜索" style={{ display: "none" }} />
      <input aria-label="跳过搜索" tabIndex={-1} />
      <input aria-label="搜索成员" />
      <details>
        <summary>管理成员</summary>
        <Button>移除成员</Button>
        <Button>转移所有权</Button>
      </details>
      <div style={{ visibility: "hidden" }}>
        <Button>不可见操作</Button>
      </div>
    </Dialog>,
  );
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "搜索成员" }),
  );
  const summary = screen.getByText("管理成员");
  const close = screen.getByRole("button", { name: "关闭" });
  summary.focus();
  fireEvent.keyDown(summary, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(summary);
  summary.parentElement.open = true;
  const transfer = screen.getByRole("button", { name: "转移所有权" });
  transfer.focus();
  fireEvent.keyDown(transfer, { key: "Tab" });
  expect(document.activeElement).toBe(close);
});
