// @vitest-environment jsdom
import React from "react";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkbench } from "./workbench.js";
const features = createWorkbench({ React });
it("preserves a failed reply and clears it only after successful submission", async () => {
  const onReply = vi
    .fn()
    .mockRejectedValueOnce(new Error("发送失败"))
    .mockResolvedValueOnce(undefined);
  render(
    <features.Question id="reply" sessionId="session" onReply={onReply}>
      申请哪个专业？
    </features.Question>,
  );
  const input = screen.getByRole("textbox", { name: "回复补充问题" });
  const send = screen.getByRole("button", { name: "发送回复" });
  expect(send.disabled).toBe(true);
  fireEvent.change(input, { target: { value: "商业分析" } });
  fireEvent.click(send);
  await screen.findByText("发送失败");
  expect(input.value).toBe("商业分析");
  fireEvent.click(send);
  await screen.findByText("已发送");
  expect(input.value).toBe("");
  expect(onReply).toHaveBeenNthCalledWith(2, "商业分析");
});
it("keeps question drafts separate and prevents repeated pending submissions", async () => {
  let finish;
  const onReply = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  sessionStorage.setItem("workagent.draft.session", JSON.stringify("底部草稿"));
  const view = render(
    <features.Question id="reply" sessionId="session" onReply={onReply} />,
  );
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "英语" } });
  view.unmount();
  render(
    <features.Question id="reply" sessionId="session" onReply={onReply} />,
  );
  expect(screen.getByRole("textbox").value).toBe("英语");
  const form = screen.getByRole("textbox").closest("form");
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(onReply).toHaveBeenCalledTimes(1);
  finish();
  await waitFor(() => expect(screen.getByRole("textbox").value).toBe(""));
  expect(sessionStorage.getItem("workagent.draft.session")).toBe(
    JSON.stringify("底部草稿"),
  );
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

it("renders an accessible question card and collapsed progress using existing presentation slots", () => {
  const { container } = render(
    <>
      <features.Question id="question">
        <p>新文书申请哪个学校？</p>
      </features.Question>
      <features.Process
        items={{
          p: { processId: "p", kind: "commentary", text: "正在查看材料" },
        }}
      />
    </>,
  );
  const card = screen.getByRole("article", { name: "补充问题" });
  expect(card.className).toBe("workagent-question");
  expect(card.textContent).toContain("新文书申请哪个学校？");
  expect(container.querySelector("details").open).toBe(false);
  expect(container.querySelector("details").textContent).toContain("进度说明");
  expect(container.querySelector(".workagent-message")).toBeNull();
});

it("shows answered questions as expandable history without another reply form", () => {
  const { container } = render(
    <features.Question id="q" sessionId="s" answered onReply={vi.fn()}>
      <p>学校和专业？</p>
    </features.Question>,
  );
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText("✓ 已补充")).toBeTruthy();
  expect(container.querySelector("details").open).toBe(false);
  fireEvent.click(container.querySelector("summary"));
  expect(container.querySelector("details").open).toBe(true);
  expect(container.querySelector("article").id).toBe("workagent-question-q");
});
