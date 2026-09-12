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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createShared } from "./shared.js";

beforeEach(() => {
  for (const storage of ["localStorage", "sessionStorage"]) {
    const values = new Map();
    vi.stubGlobal(storage, {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
      clear: () => values.clear(),
    });
  }
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture() {
  const project = {
    id: "project",
    name: "成员项目",
    currentRole: "member",
    hidden: false,
  };
  const conversations = [
    {
      id: "recent",
      project_id: project.id,
      name: "最新任务",
      kind: "personal_task",
      runtime_session_id: "session-recent",
      pinned: false,
    },
    {
      id: "mine",
      project_id: project.id,
      name: "我的任务",
      kind: "personal_task",
      runtime_session_id: "session-mine",
      pinned: false,
      assistant_backend: "codex",
    },
  ];
  const actualSession = {
    id: "session-mine",
    title: "Runtime原始标题",
    engine: "kimi",
    workspaceId: "shared:project",
    preset: {
      id: "research",
      resolvedSnapshot: {
        id: "research",
        name: "研究助手",
        engine: "kimi",
        avatar: "🔬",
      },
    },
  };
  const runtimeSessions = [
    { id: "session-recent", engine: "harness", preset: { id: "general" } },
    actualSession,
  ];
  const failures = { remaining: 0 };
  const request = vi.fn(async (path, options) => {
    if (path.includes("shared-projects?")) return { projects: [project] };
    if (path.includes("shared-conversations?"))
      return { conversations: conversations.map((row) => ({ ...row })) };
    if (path.endsWith("shared-invites")) return { invites: [] };
    if (
      path === "/api/portal/shared-conversations" &&
      options?.method === "PATCH"
    ) {
      if (failures.remaining > 0) {
        failures.remaining--;
        throw new Error("连接中断");
      }
      const { conversation_id, ...fields } = JSON.parse(options.body);
      const row = conversations.find((item) => item.id === conversation_id);
      Object.assign(row, fields);
      return { conversation: { ...row } };
    }
    throw new Error(`unexpected ${path} ${options?.method || ""}`);
  });
  const reloadSessions = vi.fn(async () => {});
  const SessionAvatar = vi.fn(({ session }) => (
    <span data-testid={`avatar-${session?.id || "loading"}`} />
  ));
  const Page = createShared({
    React,
    request,
    apiRoot: "/api/runtime/v1",
    SessionAvatar,
    friendlyError: (value) => value,
    navigation: {
      navigate: vi.fn(),
      useSearch: () => "?workagent=shared&project=project&session=session-mine",
    },
    useResource: (endpoint) => [
      {
        rows: endpoint?.endsWith("/sessions") ? runtimeSessions : [],
        error: "",
      },
      reloadSessions,
    ],
    Button: ({ children, ...props }) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    Input: (props) => <input {...props} />,
    Markdown: ({ children }) => <p>{children}</p>,
    usePins: () => ({ pins: [], toggle: vi.fn() }),
  });
  const view = render(<Page.Sidebar />);
  const order = () =>
    [
      ...view.container.querySelectorAll(
        ".workagent-sidebar-session .workagent-session-title",
      ),
    ].map((node) => node.textContent);
  const patches = () =>
    request.mock.calls.filter(([, options]) => options?.method === "PATCH");
  return { request, failures, SessionAvatar, actualSession, order, patches };
}

async function openMenu(name = "我的任务") {
  fireEvent.click(
    await screen.findByRole("button", { name: `个人任务操作 ${name}` }),
  );
  return screen.getByRole("dialog", { name: "对话操作" });
}
async function openManagement() {
  const menu = await openMenu();
  fireEvent.click(within(menu).getByRole("button", { name: "管理对话" }));
  return screen.getByRole("dialog", { name: "管理对话" });
}

it("lets a project member rename their personal task through the shared conversation controls only", async () => {
  const { patches } = fixture();
  const dialog = await openManagement();
  fireEvent.change(within(dialog).getByLabelText("对话名称"), {
    target: { value: "  新任务名称  " },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await screen.findByRole("button", { name: "新任务名称 个人" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(patches()).toEqual([
    [
      "/api/portal/shared-conversations",
      {
        method: "PATCH",
        body: JSON.stringify({ conversation_id: "mine", name: "新任务名称" }),
      },
    ],
  ]);
  expect(screen.queryByText("Runtime原始标题")).toBeNull();
});

it("moves a pinned task ahead of other project tasks and restores the order after unpinning", async () => {
  const { order, patches } = fixture();
  await openMenu();
  expect(order()).toEqual(["最新任务", "我的任务"]);
  fireEvent.click(screen.getByRole("button", { name: "置顶对话" }));
  await waitFor(() => expect(order()).toEqual(["我的任务", "最新任务"]));
  await openMenu();
  fireEvent.click(
    screen.getByRole("button", { name: "取消置顶", exact: true }),
  );
  await waitFor(() => expect(order()).toEqual(["最新任务", "我的任务"]));
  expect(patches()).toEqual(
    [true, false].map((pinned) => [
      "/api/portal/shared-conversations",
      {
        method: "PATCH",
        body: JSON.stringify({ conversation_id: "mine", pinned }),
      },
    ]),
  );
});

it("keeps the management dialog and edited name after failure, then retries without a runtime title write", async () => {
  const { failures, patches } = fixture();
  failures.remaining = 1;
  const dialog = await openManagement();
  fireEvent.change(within(dialog).getByLabelText("对话名称"), {
    target: { value: "保留的新名称" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "连接中断",
  );
  expect(within(dialog).getByLabelText("对话名称").value).toBe("保留的新名称");
  expect(screen.getByRole("button", { name: "我的任务 个人" })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await screen.findByRole("button", { name: "保留的新名称 个人" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(patches()).toHaveLength(2);
  expect(patches()[0]).toEqual(patches()[1]);
  expect(
    patches().every(([path]) => path === "/api/portal/shared-conversations"),
  ).toBe(true);
});

it("keeps a failed pin action in its menu without changing the task order", async () => {
  const { failures, order } = fixture();
  failures.remaining = 1;
  const dialog = await openMenu();
  fireEvent.click(within(dialog).getByRole("button", { name: "置顶对话" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "连接中断",
  );
  expect(order()).toEqual(["最新任务", "我的任务"]);
  fireEvent.click(within(dialog).getByRole("button", { name: "置顶对话" }));
  await waitFor(() => expect(order()).toEqual(["我的任务", "最新任务"]));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("gives the shared row avatar its bound runtime session's actual Agent preset and engine", async () => {
  const { SessionAvatar, actualSession } = fixture();
  await screen.findByTestId("avatar-session-mine");
  const props = SessionAvatar.mock.calls
    .map(([props]) => props)
    .find((props) => props.session?.id === "session-mine");
  expect(props.session).toBe(actualSession);
  expect(props.session.engine).toBe("kimi");
  expect(props.session.preset.resolvedSnapshot).toEqual(
    actualSession.preset.resolvedSnapshot,
  );
});
