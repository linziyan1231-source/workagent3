// @vitest-environment jsdom
import React from "react";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createShared, reconcileSharedMentions } from "./shared.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const dependencies = {
  React,
  apiRoot: "/api/runtime/v1",
  friendlyError: (value) => value,
  useResource: () => [{ rows: [], error: "" }, async () => {}],
  Button: ({ children, ...props }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Input: (props) => <input {...props} />,
  Markdown: ({ children }) => <p>{children}</p>,
  usePins: () => {
    const [pins, setPins] = React.useState([]);
    return {
      pins,
      toggle: (id) =>
        setPins((rows) =>
          rows.includes(id) ? rows.filter((row) => row !== id) : [...rows, id],
        ),
    };
  },
};
const type = (body) =>
  fireEvent.change(screen.getByLabelText("共享消息"), {
    target: { value: body, selectionStart: body.length },
  });
const send = () =>
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

it("only sends selected current-message identities, including keyboard selection and deletion", async () => {
  const onSend = vi.fn(async () => ({ ai_status: "started" }));
  const Page = createShared({ ...dependencies, request: vi.fn() });
  render(
    <Page.Composer
      conversation={{
        assistants: [
          {
            assistant_id: "actual-preset",
            name: "助手",
            assistant_backend: "codex",
          },
        ],
      }}
      members={[{ userId: 7, displayName: "同事" }]}
      onSend={onSend}
    />,
  );
  type("@助手 pasted text");
  send();
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][0].mentions).toEqual([]);
  await waitFor(() => expect(screen.getByLabelText("共享消息").value).toBe(""));
  type("@");
  fireEvent.keyDown(screen.getByLabelText("共享消息"), { key: "Enter" });
  send();
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
  expect(onSend.mock.calls[1][0].mentions).toEqual([
    { kind: "assistant", id: "actual-preset" },
  ]);
  await waitFor(() => expect(screen.getByLabelText("共享消息").value).toBe(""));
  type("下一条普通消息");
  send();
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(3));
  expect(onSend.mock.calls[2][0].mentions).toEqual([]);
  await waitFor(() => expect(screen.getByLabelText("共享消息").value).toBe(""));
  type("@");
  fireEvent.click(screen.getByRole("option", { name: /同事/ }));
  send();
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(4));
  expect(onSend.mock.calls[3][0].mentions).toEqual([
    { kind: "member", id: "7" },
  ]);
  await waitFor(() => expect(screen.getByLabelText("共享消息").value).toBe(""));
  type("@");
  fireEvent.click(screen.getByRole("option", { name: /助手/ }));
  type("改为普通消息");
  send();
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(5));
  expect(onSend.mock.calls[4][0].mentions).toEqual([]);
});

it("retains failed drafts and retry identity, clears saved busy messages without queuing", async () => {
  const onSend = vi
    .fn()
    .mockRejectedValueOnce(new Error("连接中断"))
    .mockResolvedValue({ ai_status: "busy", ai_reason: "shared_run_busy" });
  const Page = createShared({ ...dependencies, request: vi.fn() });
  render(<Page.Composer onSend={onSend} />);
  type("保留这条讨论");
  send();
  await screen.findByText("连接中断");
  expect(screen.getByLabelText("共享消息").value).toBe("保留这条讨论");
  send();
  await screen.findByText(/消息已发送。助手正在处理/);
  expect(screen.getByLabelText("共享消息").value).toBe("");
  expect(onSend.mock.calls[0][0].client_message_id).toBe(
    onSend.mock.calls[1][0].client_message_id,
  );
  expect(onSend).toHaveBeenCalledTimes(2);
});

it("keeps empty shared projects visible and provisions their default discussion on entry", async () => {
  const request = vi.fn(async (path) => {
    if (path.includes("shared-projects?"))
      return { projects: [{ id: "project", name: "空项目", hidden: false }] };
    if (path.includes("shared-conversations?")) return { conversations: [] };
    if (path.endsWith("shared-invites")) return { invites: [] };
    if (path.endsWith("/discussion"))
      return { conversation: { id: "default-discussion" } };
    throw new Error(`unexpected ${path}`);
  });
  const navigate = vi.fn(),
    close = vi.fn();
  vi.stubGlobal(
    "EventSource",
    class {
      close = close;
    },
  );
  const Page = createShared({
    ...dependencies,
    request,
    navigation: { navigate, useSearch: () => "" },
  });
  const view = render(<Page.Sidebar />);
  await screen.findByRole("button", { name: "空项目" });
  fireEvent.click(screen.getByRole("button", { name: "开始讨论" }));
  await waitFor(() =>
    expect(navigate).toHaveBeenCalledWith(
      "/?workagent=shared&project=project&discussion=default-discussion",
    ),
  );
  expect(
    request.mock.calls.some(([path]) => path.endsWith("shared-messages")),
  ).toBe(false);
  view.unmount();
  expect(close).toHaveBeenCalledOnce();
});

it("keeps the create dialog alive while typing the project name", async () => {
  const request = vi.fn(async (path) => {
    if (path.includes("shared-users")) return { users: [] };
    throw new Error(`unexpected ${path}`);
  });
  const Page = createShared({ ...dependencies, request });
  render(<Page.CreateProject onClose={() => {}} />);
  fireEvent.change(screen.getByLabelText("共享项目名称"), {
    target: { value: "秋" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "创建项目" }).disabled).toBe(
      false,
    ),
  );
  expect(screen.getByRole("dialog", { name: "新建协作项目" })).toBeTruthy();
});

it("uses the same file manager and panel controls as personal conversations", async () => {
  const project = { id: "project", name: "协作项目", currentRole: "owner" };
  const conversation = {
    id: "discussion",
    project_id: project.id,
    name: "讨论",
    state: "idle",
  };
  const request = vi.fn(async (path) => {
    if (path.includes("shared-projects?")) return { projects: [project] };
    if (path.includes("shared-conversations?"))
      return { conversations: [conversation] };
    if (path.includes("shared-messages")) return { messages: [] };
    if (path.endsWith("/members")) return { members: [] };
    if (path.includes("shared-invites")) return { invites: [] };
    throw new Error(`unexpected ${path}`);
  });
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
    },
  );
  const FileManager = vi.fn(() => <div>统一文件管理器</div>);
  const uploadClient = {
    uploadFiles: vi.fn(),
    Panel: () => null,
  };
  const Page = createShared({
    ...dependencies,
    request,
    FileManager,
    createUploads: () => uploadClient,
    navigation: {
      navigate: vi.fn(),
      useSearch: () => "?project=project&discussion=discussion",
    },
  });
  render(<Page />);
  fireEvent.click(await screen.findByRole("button", { name: "文件" }));
  const panel = screen.getByRole("complementary", {
    name: "项目文件侧栏",
  });
  expect(panel.textContent).toContain("协作项目");
  expect(screen.getByText("统一文件管理器")).toBeTruthy();
  expect(FileManager.mock.calls.at(-1)[0]).toMatchObject({
    workspace: project,
    root: "/api/portal/shared-workspaces/project",
    trashRoot: "/api/portal/shared-workspaces/project/trash",
    uploadClient,
    editable: false,
  });
  expect(
    FileManager.mock.calls.at(-1)[0].contentURL("project", "资料/a.txt"),
  ).toBe(
    "/api/portal/shared-workspaces/project/content?path=%E8%B5%84%E6%96%99%2Fa.txt",
  );
  fireEvent.click(screen.getByRole("button", { name: "放大文件侧栏" }));
  expect(panel.classList.contains("is-wide")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "关闭文件侧栏" }));
  expect(screen.queryByRole("complementary", { name: "项目文件侧栏" })).toBe(
    null,
  );
});

it("tracks mention offsets across edits and invalidates edited names", () => {
  const mention = {
    start: 0,
    end: 3,
    label: "@助手",
    kind: "assistant",
    id: "preset",
  };
  expect(
    reconcileSharedMentions("@助手 你好", "开头 @助手 你好", [mention]),
  ).toEqual([{ ...mention, start: 3, end: 6 }]);
  expect(
    reconcileSharedMentions("@助手 你好", "@助理 你好", [mention]),
  ).toEqual([]);
});

const personalTaskDefaults = async () => ({
  engine: "harness",
  presetId: "builtin-general",
  modelId: "model-x",
  thinkingEffort: "high",
  permissionMode: "workspace_write",
});
const personalProject = {
  id: "project",
  name: "协作项目",
  hidden: false,
  currentRole: "owner",
};
const personalTaskRequest = () =>
  vi.fn(async (path, options) => {
    if (path.includes("shared-projects?"))
      return { projects: [personalProject] };
    if (path.includes("shared-conversations?"))
      return {
        conversations: [
          { id: "discussion", project_id: "project", name: "讨论" },
        ],
      };
    if (path.endsWith("shared-invites")) return { invites: [] };
    if (path.endsWith("/members")) return { members: [] };
    if (path.includes("shared-messages")) return { messages: [] };
    throw new Error(`unexpected ${path} ${options?.method || ""}`);
  });

it("opens a personal task draft from the sidebar without a name or creating a session", async () => {
  const request = personalTaskRequest();
  const navigate = vi.fn(),
    closeSidebar = vi.fn();
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
    },
  );
  const Page = createShared({
    ...dependencies,
    request,
    closeSidebar,
    navigation: { navigate, useSearch: () => "" },
  });
  render(<Page.Sidebar />);
  fireEvent.click(
    await screen.findByRole("button", { name: "在 协作项目 中新建讨论" }),
  );
  expect(screen.getByLabelText("名称").value).toBe("");
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "新建个人任务" }));
  expect(navigate).toHaveBeenCalledWith(
    "/?workagent=shared&project=project&personal=new",
  );
  expect(closeSidebar).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog", { name: "新建讨论" })).toBeNull();
  expect(
    request.mock.calls.filter(([, options]) => options?.method === "POST"),
  ).toEqual([]);
});

it("opens the same personal task draft from the project page without creating a session", async () => {
  const request = personalTaskRequest();
  const navigate = vi.fn(),
    closeSidebar = vi.fn();
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
    },
  );
  const Page = createShared({
    ...dependencies,
    request,
    closeSidebar,
    navigation: {
      navigate,
      useSearch: () =>
        "?workagent=shared&project=project&discussion=discussion",
    },
  });
  render(<Page />);
  fireEvent.click(await screen.findByLabelText("项目更多操作"));
  fireEvent.click(screen.getByRole("button", { name: "新建讨论" }));
  expect(screen.getByLabelText("讨论名称").value).toBe("");
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "新建个人任务" }));
  expect(navigate).toHaveBeenCalledWith(
    "/?workagent=shared&project=project&personal=new",
  );
  expect(closeSidebar).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog", { name: "新建讨论" })).toBeNull();
  expect(
    request.mock.calls.filter(([, options]) => options?.method === "POST"),
  ).toEqual([]);
});

it("lists personal tasks under the project and deletes them from the row menu", async () => {
  const task = {
    id: "row-1",
    project_id: "project",
    name: "我的任务",
    kind: "personal_task",
    runtime_session_id: "session-1",
  };
  const request = vi.fn(async (path, options) => {
    if (path.includes("shared-projects?"))
      return { projects: [personalProject] };
    if (path.includes("shared-conversations?"))
      return { conversations: [task] };
    if (path.endsWith("shared-invites")) return { invites: [] };
    if (
      path === "/api/runtime/v1/sessions/session-1" &&
      options?.method === "DELETE"
    )
      return undefined;
    if (path.endsWith("shared-personal-tasks") && options?.method === "DELETE")
      return undefined;
    throw new Error(`unexpected ${path} ${options?.method || ""}`);
  });
  const navigate = vi.fn();
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
    },
  );
  const Page = createShared({
    ...dependencies,
    request,
    navigation: { navigate, useSearch: () => "" },
    personalTaskDefaults,
  });
  render(<Page.Sidebar />);
  const row = await screen.findByRole("button", { name: "我的任务 个人" });
  expect(row.textContent).toContain("个人");
  fireEvent.click(row);
  expect(navigate).toHaveBeenCalledWith(
    "/?workagent=shared&project=project&session=session-1",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "个人任务操作 我的任务" }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "管理对话" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "删除", exact: true }),
  );
  expect(request).not.toHaveBeenCalledWith(
    "/api/runtime/v1/sessions/session-1",
    {
      method: "DELETE",
    },
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "删除", exact: true }),
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith("/api/portal/shared-personal-tasks", {
      method: "DELETE",
      body: JSON.stringify({ conversation_id: "row-1" }),
    }),
  );
  expect(request).not.toHaveBeenCalledWith(
    "/api/runtime/v1/sessions/session-1",
    {
      method: "DELETE",
    },
  );
});

it("keeps personal tasks out of the page discussion switcher", async () => {
  const request = vi.fn(async (path) => {
    if (path.includes("shared-projects?"))
      return { projects: [personalProject] };
    if (path.includes("shared-conversations?"))
      return {
        conversations: [
          { id: "discussion", project_id: "project", name: "讨论" },
          {
            id: "row-1",
            project_id: "project",
            name: "我的任务",
            kind: "personal_task",
            runtime_session_id: "session-1",
          },
        ],
      };
    if (path.includes("shared-messages")) return { messages: [] };
    if (path.endsWith("/members")) return { members: [] };
    if (path.includes("shared-invites")) return { invites: [] };
    throw new Error(`unexpected ${path}`);
  });
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
    },
  );
  const Page = createShared({
    ...dependencies,
    request,
    navigation: {
      navigate: vi.fn(),
      useSearch: () => "?project=project&discussion=discussion",
    },
    personalTaskDefaults,
  });
  render(<Page />);
  const select = await screen.findByRole("combobox", { name: "切换讨论" });
  expect([...select.options].map((option) => option.textContent)).toEqual([
    "讨论",
  ]);
});

it("uses the project tree for discussion navigation, pinning and member actions", async () => {
  const closeMobileSidebar = vi.fn();
  const discussion = {
    id: "discussion",
    project_id: "project",
    name: "设计评审",
    pinned: false,
  };
  const request = vi.fn(async (path, options) => {
    if (path.includes("shared-projects?"))
      return {
        projects: [
          {
            id: "project",
            name: "设计项目",
            hidden: false,
            currentRole: "owner",
          },
        ],
      };
    if (path.includes("shared-conversations?"))
      return { conversations: [{ ...discussion }] };
    if (path.endsWith("shared-conversations") && options?.method === "PATCH") {
      Object.assign(discussion, JSON.parse(options.body));
      return { conversation: discussion };
    }
    if (path.endsWith("shared-invites") || path.endsWith("/invites"))
      return { invites: [] };
    if (path.endsWith("/members")) return { members: [] };
    throw new Error(`unexpected ${path}`);
  });
  const navigate = vi.fn();
  const Page = createShared({
    ...dependencies,
    closeMobileSidebar,
    request,
    navigation: { navigate, useSearch: () => "" },
  });
  render(<Page.Sidebar />);
  expect(
    screen.queryByRole("button", { name: "讨论操作 设计评审" }),
  ).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "设计评审" }));
  expect(navigate).toHaveBeenCalledWith(
    "/?workagent=shared&project=project&discussion=discussion",
  );
  fireEvent.click(screen.getByRole("button", { name: "置顶 设计评审" }));
  await screen.findByRole("button", { name: "取消置顶 设计评审" });
  expect(request).toHaveBeenCalledWith("/api/portal/shared-conversations", {
    method: "PATCH",
    body: JSON.stringify({ conversation_id: "discussion", pinned: true }),
  });
  fireEvent.click(screen.getByRole("button", { name: "设计项目" }));
  expect(screen.queryByRole("button", { name: "设计评审" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "项目操作 设计项目" }));
  fireEvent.click(screen.getByRole("button", { name: "邀请与成员" }));
  await screen.findByRole("dialog", { name: "项目成员" });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "项目成员" })).toBeNull();
  expect(closeMobileSidebar).not.toHaveBeenCalled();
});

it("does not offer uninvited presets in mentions", () => {
  const Page = createShared({
    ...dependencies,
    request: vi.fn(),
    useResource: () => [
      {
        rows: [
          { id: "global", name: "Uninvited", engine: "codex", enabled: true },
        ],
      },
    ],
  });
  render(
    <Page.Composer
      conversation={{ assistants: [] }}
      members={[{ userId: 7, displayName: "同事" }]}
      onSend={vi.fn()}
    />,
  );
  type("@");
  expect(screen.getByRole("option", { name: /同事/ })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /Uninvited/ })).toBeNull();
});

it("shares paste and page drop uploads, previews images and removes references without changing mentions", async () => {
  const uploadFiles = vi.fn(async (_project, files, options) => {
    for (const file of files) await options.onUploaded(`附件/${file.name}`);
    return { failures: [] };
  });
  const onSend = vi.fn(async () => ({}));
  const Page = createShared({
    ...dependencies,
    request: vi.fn(),
    createUploads: () => ({ uploadFiles }),
  });
  render(
    <Page.Composer
      projectId="one"
      conversation={{}}
      members={[{ userId: 7, displayName: "同事" }]}
      onSend={onSend}
    />,
  );
  type("@");
  fireEvent.keyDown(screen.getByLabelText("共享消息"), { key: "Enter" });
  screen.getByLabelText("共享消息").setSelectionRange(0, 3);
  fireEvent.paste(screen.getByLabelText("共享消息"), {
    clipboardData: {
      files: [new File(["image"], "design.png", { type: "image/png" })],
    },
  });
  await screen.findByRole("img", { name: "design.png" });
  fireEvent.drop(document.body, {
    dataTransfer: {
      types: ["Files"],
      files: [new File(["doc"], "brief.docx")],
    },
  });
  await screen.findByRole("link", { name: "预览 brief.docx" });
  expect(uploadFiles).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "移除附件 design.png" }));
  send();
  await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onSend.mock.calls[0][0].attachments).toEqual(["附件/brief.docx"]);
  expect(onSend.mock.calls[0][0].mentions).toEqual([
    { kind: "member", id: "7" },
  ]);
});

it("mentions multiple joined assistants and rejects a removed member in a draft", async () => {
  const onSend = vi.fn(async () => ({
    assistants: [
      { assistant_id: "first", status: "started" },
      { assistant_id: "other", status: "started" },
    ],
  }));
  const Page = createShared({ ...dependencies, request: vi.fn() });
  const agents = [
    { assistant_id: "first", name: "Codex", assistant_backend: "codex" },
    { assistant_id: "other", name: "Kimi", assistant_backend: "kimi" },
  ];
  const view = render(
    <Page.Composer conversation={{ assistants: agents }} onSend={onSend} />,
  );
  type("@");
  fireEvent.click(screen.getByRole("option", { name: /Codex/ }));
  type("@Codex @");
  fireEvent.click(screen.getByRole("option", { name: /Kimi/ }));
  send();
  await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
  expect(onSend.mock.calls[0][0].mentions).toEqual([
    { kind: "assistant", id: "first" },
    { kind: "assistant", id: "other" },
  ]);
  expect(onSend.mock.calls[0][0].assistant).toBeUndefined();
  await waitFor(() => expect(screen.getByLabelText("共享消息").value).toBe(""));
  type("@");
  fireEvent.click(screen.getByRole("option", { name: /Kimi/ }));
  view.rerender(
    <Page.Composer
      conversation={{ assistants: [agents[0]] }}
      onSend={onSend}
    />,
  );
  send();
  await screen.findByText("请先邀请这个助手加入项目，再 @ 它。");
  expect(onSend).toHaveBeenCalledOnce();
});

const groupProject = { id: "project", name: "群", currentRole: "owner" };
const groupAgents = [
  {
    assistant_id: "first",
    name: "Codex",
    assistant_backend: "codex",
    model_id: "gpt-one",
    thinking_effort: "medium",
    state: "accepted",
  },
  {
    assistant_id: "second",
    name: "Kimi",
    assistant_backend: "kimi",
    model_id: "kimi-one",
    thinking_effort: "medium",
    state: "accepted",
  },
];
const groupOptions = [
  {
    id: "first",
    name: "Codex",
    engine: "codex",
    models: [
      {
        id: "gpt-one",
        name: "GPT one",
        reasoning: ["low", "medium", "high"].map((id) => ({ id, name: id })),
        defaultReasoning: "medium",
      },
      {
        id: "gpt-two",
        name: "GPT two",
        reasoning: ["low", "high", "max"].map((id) => ({ id, name: id })),
        defaultReasoning: "low",
      },
    ],
  },
  {
    id: "second",
    name: "Kimi",
    engine: "kimi",
    models: [
      {
        id: "kimi-one",
        name: "Kimi one",
        reasoning: ["low", "high", "max"].map((id) => ({ id, name: id })),
        defaultReasoning: "low",
      },
    ],
  },
];
const groupRequest = (members = groupAgents) =>
  vi.fn(async (path, options) => {
    if (path.endsWith("/assistants")) return { assistants: members };
    if (path.endsWith("/assistant-options"))
      return { assistants: groupOptions };
    if (path.endsWith("/assistant-invites"))
      return { member: groupAgents[1], invite: { status: "accepted" } };
    if (options?.method === "PATCH")
      return { member: { ...groupAgents[0], ...JSON.parse(options.body) } };
    if (path.includes("shared-projects?")) return { projects: [groupProject] };
    if (path.includes("shared-conversations?")) return { conversations: [] };
    if (path.includes("shared-invites")) return { invites: [] };
    throw Error(`unexpected ${path}`);
  });
it("invites assistants through the members panel with immediate acceptance", async () => {
  const request = groupRequest([groupAgents[0]]);
  const Page = createShared({ ...dependencies, request });
  render(<Page.AssistantMembers project={groupProject} revision={0} />);
  await screen.findByRole("option", { name: "Kimi" });
  expect(screen.queryByRole("option", { name: "Codex" })).toBeNull();
  fireEvent.change(screen.getByLabelText("邀请助手"), {
    target: { value: "second" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送助手邀请" }));
  await screen.findByText("助手已接受邀请并加入项目。");
  expect(request).toHaveBeenCalledWith(
    "/api/portal/shared-projects/project/assistant-invites",
    { method: "POST", body: JSON.stringify({ assistant_id: "second" }) },
  );
});
it("changes only the selected member's model and effort without an engine selector", async () => {
  const request = groupRequest();
  const Page = createShared({ ...dependencies, request });
  render(
    <Page.AssistantSettings
      project={groupProject}
      revision={0}
      onClose={vi.fn()}
    />,
  );
  await screen.findByLabelText("Codex 模型");
  expect(screen.getAllByRole("combobox")).toHaveLength(4);
  expect(
    [...screen.getByLabelText("Kimi 思考强度").options].map((o) => o.value),
  ).toEqual(["low", "high", "max"]);
  expect(screen.getByLabelText("Kimi 思考强度").value).toBe("low");
  expect(
    [...screen.getByLabelText("Codex 模型").options].map((o) => o.value),
  ).toEqual(["gpt-one", "gpt-two"]);
  fireEvent.change(screen.getByLabelText("Codex 模型"), {
    target: { value: "gpt-two" },
  });
  fireEvent.change(screen.getByLabelText("Codex 思考强度"), {
    target: { value: "high" },
  });
  fireEvent.submit(screen.getByRole("form", { name: "Codex 的设置" }));
  await screen.findByText("已保存，下次 @ 时生效。");
  expect(request).toHaveBeenCalledWith(
    "/api/portal/shared-projects/project/assistants/first",
    {
      method: "PATCH",
      body: JSON.stringify({ model_id: "gpt-two", thinking_effort: "high" }),
    },
  );
});
it("locates a mentioned message beyond the first history page", async () => {
  const scroll = vi.fn();
  const previous = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    const request = vi.fn(async (path) => ({
      messages: path.includes("after=200")
        ? [
            {
              id: "target",
              seq: 201,
              body: "提到你",
              kind: "user",
              author_name: "同事",
              created_at: new Date().toISOString(),
            },
          ]
        : Array.from({ length: 200 }, (_, i) => ({
            id: `m-${i}`,
            seq: i + 1,
            body: `earlier ${i}`,
            kind: "user",
            author_name: "同事",
            created_at: new Date().toISOString(),
          })),
    }));
    const Page = createShared({
      ...dependencies,
      request,
      navigation: { navigate: vi.fn(), useSearch: () => "?message=target" },
    });
    render(
      <Page.Chat
        project={groupProject}
        conversation={{ id: "discussion", assistants: [] }}
        members={[]}
        revision={0}
      />,
    );
    await screen.findByText("提到你");
    expect(scroll).toHaveBeenCalled();
    expect(
      document
        .querySelector('[data-shared-message-id="target"]')
        .classList.contains("workagent-message-highlight"),
    ).toBe(true);
    expect(
      request.mock.calls.some(([path]) => path.includes("after=200")),
    ).toBe(true);
  } finally {
    Element.prototype.scrollIntoView = previous;
  }
});
