// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  SidebarAction,
  SidebarGroup,
  SidebarRow,
  SidebarStatus,
} from "./sidebar.js";

afterEach(cleanup);

it("keeps opening a conversation separate from its row operations and status", () => {
  const open = vi.fn(),
    more = vi.fn();
  render(
    <SidebarRow
      title="项目讨论"
      subtitle="渠道来源"
      selected
      onOpen={open}
      status={<SidebarStatus running label="正在运行" />}
      actions={<SidebarAction label="讨论操作" onClick={more} />}
    />,
  );
  const main = screen.getByRole("button", { name: /项目讨论/ });
  expect(main.getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("img", { name: "正在运行" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "讨论操作" }));
  expect(more).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(main);
  expect(open).toHaveBeenCalledOnce();
});

it("collapses a group without firing its add action or leaving hidden rows focusable", () => {
  const toggle = vi.fn(),
    add = vi.fn();
  const props = {
    title: "项目",
    onToggle: toggle,
    actions: <SidebarAction label="新建讨论" icon="plus" onClick={add} />,
  };
  const view = render(
    <SidebarGroup {...props} expanded>
      <SidebarRow title="讨论" />
    </SidebarGroup>,
  );
  fireEvent.click(screen.getByRole("button", { name: "新建讨论" }));
  expect(add).toHaveBeenCalledOnce();
  expect(toggle).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "项目" }));
  expect(toggle).toHaveBeenCalledOnce();
  view.rerender(
    <SidebarGroup {...props} expanded={false}>
      <SidebarRow title="讨论" />
    </SidebarGroup>,
  );
  expect(screen.queryByRole("button", { name: "讨论" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "项目" }).getAttribute("aria-expanded"),
  ).toBe("false");
});
