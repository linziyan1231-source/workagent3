// @vitest-environment jsdom
import React from "react";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createFileComposer,
  composerText,
  bindComposerFiles,
} from "./file-composer.js";
import { createWorkbench } from "../content/workbench.js";
import { fileReferenceText } from "../../../../contracts/src/file-reference.ts";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
const fileURL = (id, path) =>
  `/api/runtime/v1/workspaces/${id}/content?path=${encodeURIComponent(path)}`;
const reference = fileReferenceText({
  workspaceId: "one",
  path: "资料/三七互娱.docx",
  name: "三七互娱.docx",
});
function harness(initial = `分析 ${reference} 的内容`) {
  const openFile = vi.fn();
  const Editor = createFileComposer({ React, fileURL, openFile });
  const changes = vi.fn();
  function App() {
    const [value, set] = React.useState(initial);
    return (
      <Editor
        aria-label="消息"
        value={value}
        onChange={(event) => {
          changes(event.target.value);
          set(event.target.value);
        }}
        workspaceId="one"
      />
    );
  }
  const view = render(<App />);
  return { ...view, editor: screen.getByLabelText("消息"), changes, openFile };
}
it("renders a named link without path text, previews it and removes the entire reference without deleting the file", () => {
  const { editor, openFile, changes } = harness();
  expect(editor.textContent).toBe("分析 📄三七互娱.docx× 的内容");
  expect(editor.textContent).not.toContain("项目文件");
  expect(editor.querySelector("[data-file-reference]").title).toBe(
    "资料/三七互娱.docx",
  );
  fireEvent.click(screen.getByRole("link", { name: "预览 三七互娱.docx" }));
  expect(openFile).toHaveBeenCalledWith({
    workspaceId: "one",
    path: "资料/三七互娱.docx",
    name: "三七互娱.docx",
  });
  fireEvent.click(
    screen.getByRole("button", { name: "移除引用 三七互娱.docx" }),
  );
  expect(changes).toHaveBeenLastCalledWith("分析  的内容");
});
it("inserts at the saved caret and restores the same durable reference with main/side drafts", () => {
  const { editor, changes, unmount } = harness("前后");
  editor.focus();
  const range = document.createRange();
  range.setStart(editor.firstChild, 1);
  range.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  fireEvent.mouseUp(editor);
  act(() => editor.workagentInsertReference(reference));
  expect(changes).toHaveBeenLastCalledWith(`前${reference}后`);
  unmount();
  const workbench = createWorkbench({ React, fileURL, request: vi.fn() });
  sessionStorage.setItem(
    "workagent.draft.main",
    JSON.stringify(`前${reference}后`),
  );
  sessionStorage.setItem("workagent.draft.side", JSON.stringify("侧聊草稿"));
  function Draft({ id }) {
    const [value, set] = workbench.useDraft(id);
    return (
      <workbench.FileComposer
        aria-label={id}
        value={value}
        onChange={(event) => set(event.target.value)}
        workspaceId="one"
      />
    );
  }
  render(
    <>
      <Draft id="main" />
      <Draft id="side" />
    </>,
  );
  expect(composerText(screen.getByLabelText("main"))).toBe(`前${reference}后`);
  fireEvent.click(
    screen.getByRole("button", { name: "移除引用 三七互娱.docx" }),
  );
  expect(JSON.parse(sessionStorage.getItem("workagent.draft.main"))).toBe(
    "前后",
  );
  expect(screen.getByLabelText("side").textContent).toBe("侧聊草稿");
});
it("deletes a file atom with Backspace and treats pasted HTML as plain text", () => {
  const { editor, changes } = harness(reference);
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  fireEvent.keyDown(editor, { key: "Backspace" });
  expect(changes).toHaveBeenLastCalledWith("");
  fireEvent.paste(editor, {
    clipboardData: {
      files: [],
      getData: (type) =>
        type === "text/plain" ? '<img src=x onerror="bad()">' : "",
    },
  });
  expect(editor.querySelector("img")).toBeNull();
  expect(editor.textContent).toBe('<img src=x onerror="bad()">');
});

it("previews image references while keeping durable copy, removal and undo", () => {
  const image = fileReferenceText({
    workspaceId: "one",
    path: "附件/design.png",
    name: "design.png",
  });
  const { editor, changes } = harness(`说明 ${image}`);
  expect(
    screen.getByRole("img", { name: "design.png" }).getAttribute("src"),
  ).toContain("design.png");
  expect(composerText(editor)).toBe(`说明 ${image}`);
  fireEvent.click(screen.getByRole("button", { name: "移除引用 design.png" }));
  expect(changes).toHaveBeenLastCalledWith("说明 ");
  fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
  expect(screen.getByRole("img", { name: "design.png" })).toBeTruthy();
  fireEvent.error(screen.getByRole("img", { name: "design.png" }));
  expect(
    screen.getByRole("link", { name: "预览 design.png" }).textContent,
  ).toBe("📄design.png");
});

it("routes page drops to the active overlay instead of the retained background composer", () => {
  const background = document.createElement("form");
  const main = document.createElement("input");
  background.append(main);
  const overlay = document.createElement("div");
  overlay.className = "workagent-overlay";
  const form = document.createElement("form"),
    input = document.createElement("textarea");
  form.append(input);
  overlay.append(form);
  document.body.append(background, overlay);
  const mainUpload = vi.fn(),
    sharedUpload = vi.fn();
  const cleanMain = bindComposerFiles(main, mainUpload, false),
    cleanShared = bindComposerFiles(input, sharedUpload, false);
  const file = new File(["doc"], "brief.docx");
  fireEvent.drop(overlay, {
    dataTransfer: { types: ["Files"], files: [file] },
  });
  expect(mainUpload).not.toHaveBeenCalled();
  expect(sharedUpload).toHaveBeenCalledWith([file]);
  cleanMain();
  cleanShared();
  background.remove();
  overlay.remove();
});
