// @vitest-environment jsdom
import React from "react";
import * as primitives from "@deepseek-ai/dsh-client-ui-primitives";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let registration;
let client;

beforeAll(async () => {
  window.__ModuleLoader__ = { load: (value) => (registration = value) };
  await import("./client.js");
  client = registration.factory((name) => {
    if (name === "react") return React;
    if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
    throw new Error(`unexpected client external ${name}`);
  });
});

beforeEach(() => {
  sessionStorage.clear();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const values = new Map();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, String(value)),
    },
  });
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

function compose(
  localeScope = {
    getSnapshot: () => ({ value: { preference: "zh" } }),
    subscribe: () => () => {},
  },
  services = {},
) {
  const entries = [];
  const theme = {
    getTheme: vi.fn(() => ({ preference: "light", resolved: "light" })),
    setTheme: vi.fn(),
  };
  const ctx = {
    ...services,
    theme,
    effect: (callback) => callback(),
    locale: { setLocale: vi.fn() },
    settingsScope: {
      bind: () => localeScope,
    },
    slots: {
      inject: (_name, callback) => {
        const result = callback();
        if (result?.[Symbol.iterator]) [...result];
        return () => {};
      },
      register: (options, Component) => {
        entries.push({ options, Component });
        return () => {};
      },
    },
  };
  client.apply(ctx);
  entries.theme = theme;
  entries.locale = ctx.locale;
  return entries;
}

describe("WorkAgent dsh slot components", () => {
  it("creates a weekly continuation and edits a versioned cron schedule", async () => {
    window.history.replaceState({}, "", "/?workagent=automations");
    let definitions = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (path, init = {}) => {
        const url = String(path);
        let value = [];
        if (init.method === "POST" || init.method === "PATCH") {
          const input = JSON.parse(init.body);
          definitions = [
            {
              ...input,
              id: "job",
              version: (input.version || 0) + 1,
              nextRunAt: null,
            },
          ];
          value = definitions[0];
        } else if (url.endsWith("/automations")) value = definitions;
        else if (url.endsWith("/presets"))
          value = [{ id: "kimi", name: "Kimi", engine: "kimi", enabled: true }];
        else if (url.endsWith("/workspaces"))
          value = [{ id: "project", name: "项目" }];
        else if (url.endsWith("/sessions"))
          value = [
            {
              id: "continued",
              title: "每周会话",
              engine: "kimi",
              workspaceId: "project",
            },
            {
              id: "wrong",
              title: "其他项目",
              engine: "kimi",
              workspaceId: "elsewhere",
            },
          ];
        return new Response(JSON.stringify(value), {
          headers: { "Content-Type": "application/json" },
        });
      });
    const overlay = compose().find(
      (entry) => entry.options.id === "workagent-page",
    );
    render(React.createElement(overlay.Component));
    await screen.findByRole("option", { name: "Kimi" });
    for (const [label, value] of [
      ["任务名称", "汇总"],
      ["执行助手", "kimi"],
      ["所属项目", "project"],
      ["任务内容", "检查进展"],
      ["执行频率", "weekly"],
      ["执行方式", "existing"],
    ])
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    expect(screen.queryByRole("option", { name: "其他项目" })).toBeNull();
    fireEvent.change(screen.getByLabelText("继续的对话"), {
      target: { value: "continued" },
    });
    fireEvent.change(screen.getByLabelText("结果通知"), {
      target: { value: "on_failure" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
    await screen.findByRole("button", { name: "编辑任务" });
    expect(definitions[0]).toMatchObject({
      schedule: { kind: "weekly", daysOfWeek: [1], hour: 9 },
      executionMode: "existing",
      conversationId: "continued",
      notificationPolicy: "on_failure",
    });
    fireEvent.click(screen.getByRole("button", { name: "编辑任务" }));
    fireEvent.change(screen.getByLabelText("执行频率"), {
      target: { value: "cron" },
    });
    fireEvent.change(screen.getByLabelText("Cron 表达式"), {
      target: { value: "0 8 * * 1-5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存任务" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"),
      ).toBe(true),
    );
    expect(
      JSON.parse(
        fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")[1]
          .body,
      ),
    ).toMatchObject({
      version: 1,
      schedule: { kind: "cron", expression: "0 8 * * 1-5" },
    });
  });
  it("saves completion notifications only after explicit target selection and shows delivery failures", async () => {
    let saved = {
      enabled: false,
      targetId: "",
      baseURL: "",
      targets: [{ id: "target-1", label: "飞书 · 我的聊天", connected: true }],
      deliveries: [
        {
          id: "job-1",
          title: "报告任务",
          targetLabel: "飞书 · 我的聊天",
          status: "failed",
          error: "渠道未连接",
        },
      ],
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init = {}) => {
        if (init.method === "PUT")
          saved = { ...saved, ...JSON.parse(init.body) };
        return new Response(JSON.stringify(saved), {
          headers: { "content-type": "application/json" },
        });
      });
    const Component = compose().find(
      (entry) => entry.options.id === "workagent-completion-notifications",
    ).Component;
    const view = render(<Component />);
    const toggle = await screen.findByRole("switch", { name: "任务完成提醒" });
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    fireEvent.change(screen.getByRole("combobox", { name: "接收聊天" }), {
      target: { value: "target-1" },
    });
    expect(screen.queryByRole("textbox", { name: "WorkAgent 访问网址" })).toBeNull();
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PUT"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "保存提醒设置" }));
    await screen.findByText("提醒设置已保存");
    expect(saved).toMatchObject({
      enabled: true,
      targetId: "target-1",

    });
    expect(JSON.parse(fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")[1].body)).not.toHaveProperty("baseURL");
    expect(screen.getByText("渠道未连接")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试推送" }).disabled).toBe(
      false,
    );
    view.unmount();
  });

  it("shows a readable error when a converted preview is missing instead of embedding JSON", async () => {
    localStorage.setItem("workagent.files.open", "true");
    localStorage.setItem("workagent.hero.workspace", "preview-project");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (path) => {
      if (
        String(path).includes("/interactions?") ||
        String(path).endsWith("/uploads")
      )
        return new Response("[]", {
          headers: { "content-type": "application/json" },
        });
      if (String(path) === "/api/speech/capability")
        return new Response('{"enabled":false}', {
          headers: { "content-type": "application/json" },
        });
      const url = String(path);
      if (url.includes("/office-preview/content/"))
        return new Response(
          JSON.stringify({ error: "office_preview_not_found" }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      const body = url.endsWith("/workspaces")
        ? [{ id: "preview-project", name: "预览项目" }]
        : url.includes("/files")
          ? [{ name: "表格.xlsx", path: "表格.xlsx", kind: "file", size: 1200 }]
          : { hash: "converted" };
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    });
    const Sidebar = compose().find(
      (entry) => entry.options.id === "workagent-files",
    ).Component;
    const view = render(<Sidebar />);
    fireEvent.click(
      await screen.findByRole("button", { name: "表格.xlsx", exact: true }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "可下载原文件查看",
    );
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(view.container.textContent).not.toContain(
      "office_preview_not_found",
    );
    view.unmount();
  });
  it("binds the file sidebar to the session project and previews text safely", async () => {
    window.history.replaceState({}, "", "/?session=files-session");
    localStorage.setItem("workagent.hero.workspace", "other-project");
    localStorage.setItem("workagent.files.open", "true");
    localStorage.setItem("workagent.files.width", "320");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (path) => {
        if (
          String(path).includes("/interactions?") ||
          String(path).endsWith("/uploads")
        )
          return new Response("[]", {
            headers: { "content-type": "application/json" },
          });
        if (String(path) === "/api/speech/capability")
          return new Response('{"enabled":false}', {
            headers: { "content-type": "application/json" },
          });
        const url = new URL(String(path), "http://localhost");
        if (url.pathname.endsWith("/content"))
          return new Response("<script>window.unsafe = true</script>中文内容");
        const value = url.pathname.endsWith("/workspaces")
          ? [
              { id: "session-project", name: "会话项目" },
              { id: "other-project", name: "上次项目" },
            ]
          : url.pathname.endsWith("/files")
            ? [{ name: "说明.txt", path: "说明.txt", kind: "file", size: 30 }]
            : { id: "files-session", workspaceId: "session-project" };
        return new Response(JSON.stringify(value), {
          headers: { "Content-Type": "application/json" },
        });
      });
    const Sidebar = compose().find(
      (entry) => entry.options.id === "workagent-files",
    ).Component;
    const view = render(<Sidebar />);
    fireEvent.click(
      await screen.findByRole("button", { name: "说明.txt", exact: true }),
    );
    expect(
      await screen.findByText("<script>window.unsafe = true</script>中文内容"),
    ).toBeTruthy();
    expect(view.container.querySelector("script")).toBeNull();
    expect(
      view.container.querySelector(".workagent-files-toggle").textContent,
    ).toBe("");
    fireEvent.keyDown(
      screen.getByRole("separator", { name: "调整文件栏宽度" }),
      { key: "ArrowLeft" },
    );
    expect(localStorage.getItem("workagent.files.width")).toBe("344");
    expect(
      screen.queryByRole("separator", { name: "调整预览区高度" }),
    ).toBeNull();
    expect(
      view.container.querySelector(".workagent-file-manager-content").hidden,
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: "说明.txt", exact: true }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "返回文件列表" }));
    fireEvent.click(
      screen.getByRole("button", { name: "说明.txt", exact: true }),
    );
    await screen.findByText("<script>window.unsafe = true</script>中文内容");
    fireEvent.click(screen.getByRole("button", { name: "最大化文件预览" }));
    expect(
      view.container.querySelector(".workagent-file-preview-pane.is-maximized"),
    ).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("button", { name: "还原文件预览" }), {
      key: "Escape",
    });
    expect(
      view.container.querySelector(".workagent-file-preview-pane.is-maximized"),
    ).toBeNull();
    expect(screen.queryByRole("combobox", { name: "文件侧栏项目" })).toBeNull();
    expect(
      fetchMock.mock.calls.some(([path]) =>
        String(path).includes("/other-project/"),
      ),
    ).toBe(false);
    fireEvent.click(
      view.container.querySelector(
        '.workagent-file-preview-pane button[aria-label="关闭文件侧栏"]',
      ),
    );
    expect(localStorage.getItem("workagent.files.open")).toBe("false");
    fireEvent.click(
      screen.getByRole("button", { name: "打开文件侧栏", exact: true }),
    );
    expect(
      screen.getByText("<script>window.unsafe = true</script>中文内容"),
    ).toBeTruthy();
    view.unmount();
  });

  it("shows unassigned session files without falling back to a remembered project", async () => {
    window.history.replaceState({}, "", "/?session=loose-session");
    localStorage.setItem("workagent.files.open", "true");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async (path) =>
          new Response(
            JSON.stringify(
              String(path).endsWith("/loose-session")
                ? { workspaceId: "default" }
                : [],
            ),
            { headers: { "Content-Type": "application/json" } },
          ),
      );
    const Sidebar = compose().find(
      (entry) => entry.options.id === "workagent-files",
    ).Component;
    const view = render(<Sidebar />);
    await screen.findByText("当前会话文件");
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([path]) =>
          String(path).includes("/workspaces/default/files"),
        ),
      ).toBe(true),
    );
    view.unmount();
  });

  it("does not replace a newer file preview with an older delayed response", async () => {
    localStorage.setItem("workagent.files.open", "true");
    localStorage.setItem("workagent.hero.workspace", "project");
    let finishOld;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (path) => {
      if (String(path).includes("/interactions?"))
        return new Response("[]", {
          headers: { "content-type": "application/json" },
        });
      if (String(path) === "/api/speech/capability")
        return new Response('{"enabled":false}', {
          headers: { "content-type": "application/json" },
        });
      const url = new URL(String(path), "http://localhost");
      if (url.pathname.endsWith("/content")) {
        if (url.searchParams.get("path") === "old.txt")
          return new Promise((resolve) => {
            finishOld = resolve;
          });
        return new Response("新的文件内容");
      }
      return new Response(
        JSON.stringify(
          url.pathname.endsWith("/workspaces")
            ? [{ id: "project", name: "项目" }]
            : ["old.txt", "new.txt"].map((name) => ({
                name,
                path: name,
                kind: "file",
                size: 20,
              })),
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    const Sidebar = compose().find(
      (entry) => entry.options.id === "workagent-files",
    ).Component;
    const view = render(<Sidebar />);
    fireEvent.click(
      await screen.findByRole("button", { name: "old.txt", exact: true }),
    );
    fireEvent.click(screen.getByRole("button", { name: "返回文件列表" }));
    fireEvent.click(
      screen.getByRole("button", { name: "new.txt", exact: true }),
    );
    await screen.findByText("新的文件内容");
    await act(async () => {
      finishOld(new Response("旧文件内容"));
    });
    expect(screen.queryByText("旧文件内容")).toBeNull();
    expect(screen.getByText("新的文件内容")).toBeTruthy();
    view.unmount();
  });

  it("uses exclusive uploads and reports conflicts without hiding existing files", async () => {
    localStorage.setItem("workagent.files.open", "true");
    localStorage.setItem("workagent.hero.workspace", "project");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (path, init = {}) =>
        new Response(
          JSON.stringify(
            init.method === "POST"
              ? { error: "destination_exists" }
              : String(path).endsWith("/workspaces")
                ? [{ id: "project", name: "项目" }]
                : [
                    {
                      name: "notes.txt",
                      path: "notes.txt",
                      kind: "file",
                      size: 20,
                    },
                  ],
          ),
          {
            status: init.method === "POST" ? 409 : 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    const Sidebar = compose().find(
      (entry) => entry.options.id === "workagent-files",
    ).Component;
    const view = render(<Sidebar />);
    await screen.findByRole("button", { name: "notes.txt", exact: true });
    fireEvent.change(screen.getByLabelText("选择上传文件"), {
      target: { files: [new File(["replacement"], "notes.txt")] },
    });
    await screen.findByText("notes.txt：同名文件已存在，请换一个名称。");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/uploads"),
      expect.objectContaining({ method: "POST" }),
    );
    expect(
      screen.getByRole("button", { name: "notes.txt", exact: true }),
    ).toBeTruthy();
    view.unmount();
  });

  it("accepts a 1 GB file and rejects larger files before sending them", async () => {
    localStorage.setItem("workagent.files.open", "true");
    localStorage.setItem("workagent.hero.workspace", "project");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (path, init = {}) =>
        new Response(
          JSON.stringify(
            init.method === "POST"
              ? {
                  id: "upload",
                  size: 1024 ** 3,
                  offset: 1024 ** 3,
                  path: "large.bin",
                }
              : String(path).endsWith("/workspaces")
                ? [{ id: "project", name: "项目" }]
                : [],
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const Sidebar = compose().find(
      (entry) => entry.options.id === "workagent-files",
    ).Component;
    const view = render(<Sidebar />);
    await screen.findByLabelText("选择上传文件");
    const file = new File(["fixture"], "large.bin");
    Object.defineProperty(file, "size", { value: 1024 ** 3 });
    fireEvent.change(screen.getByLabelText("选择上传文件"), {
      target: { files: [file] },
    });
    await screen.findByText("已上传 1 个文件");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/uploads"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"size":1073741824'),
      }),
    );
    const oversized = new File(["fixture"], "oversized.bin");
    Object.defineProperty(oversized, "size", { value: 1024 ** 3 + 1 });
    fireEvent.change(screen.getByLabelText("选择上传文件"), {
      target: { files: [oversized] },
    });
    await screen.findByText("oversized.bin：超过 1 GB");
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) => init?.method === "POST" && init?.body !== undefined,
      ),
    ).toHaveLength(1);
    view.unmount();
  });

  it.each([
    ["new conversation", "/", "workagent-workspace-composer", "输入消息"],
    [
      "existing conversation",
      "/?session=ime-session",
      "workagent-page",
      "继续对话",
    ],
  ])(
    "preserves IME confirmation in the %s composer",
    async (_name, url, slot, label) => {
      window.history.replaceState({}, "", url);
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async (path) =>
          new Response(
            JSON.stringify(
              String(path).endsWith("/sessions/ime-session")
                ? { id: "ime-session", engine: "codex", title: "输入法测试" }
                : [],
            ),
            { headers: { "Content-Type": "application/json" } },
          ),
      );
      const Component = compose().find(
        (entry) => entry.options.id === slot,
      ).Component;
      const view = render(<Component />);
      const input = screen.getByLabelText(label);
      const submit = vi
        .spyOn(input.form, "requestSubmit")
        .mockImplementation(() => {});
      await act(async () => {});
      fireEvent.compositionStart(input);
      fireEvent.change(input, { target: { value: "nihao" } });
      expect(
        fireEvent.keyDown(input, { key: "Enter", isComposing: true }),
      ).toBe(true);
      expect(submit).not.toHaveBeenCalled();
      expect(input.value).toBe("nihao");
      fireEvent.compositionEnd(input, { data: "你好" });
      fireEvent.change(input, { target: { value: "你好" } });
      // Some IMEs end composition before their confirming keydown, but retain 229.
      expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })).toBe(
        true,
      );
      expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(
        true,
      );
      expect(submit).not.toHaveBeenCalled();
      expect(input.value).toBe("你好");
      expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 13 })).toBe(
        false,
      );
      expect(submit).toHaveBeenCalledTimes(1);
      view.unmount();
    },
  );

  it("keeps the account language Chinese after delayed settings and reloads", () => {
    let value;
    let changed;
    const scope = {
      getSnapshot: () => ({ value }),
      subscribe: (callback) => {
        changed = callback;
        return () => {};
      },
    };
    const initial = compose(scope);
    expect(initial.locale.setLocale).not.toHaveBeenCalled();
    value = { preference: "en" };
    changed();
    expect(initial.locale.setLocale).toHaveBeenCalledWith("zh");
    const later = compose(scope);
    expect(later.locale.setLocale).toHaveBeenCalledWith("zh");
    value = { preference: "zh" };
    expect(compose(scope).locale.setLocale).not.toHaveBeenCalled();
    value = {};
    expect(compose(scope).locale.setLocale).toHaveBeenCalledWith("zh");
  });
  it("renders WorkAgent branding through official brand slots", () => {
    const entries = compose();
    const brand = entries.find(
      (entry) => entry.options.name === "sidebar.brand.name",
    );
    render(React.createElement(brand.Component));
    expect(screen.getByText("WorkAgent")).toBeTruthy();
    expect(document.title).toBe("WorkAgent");
  });

  it("removes the host configuration-file action", async () => {
    compose();
    const button = document.createElement("button");
    button.textContent = "打开配置文件";
    document.body.append(button);
    await waitFor(() => expect(document.body.contains(button)).toBe(false));
  });

  it("keeps the product title when the upstream renderer selects a session", async () => {
    compose();
    document.title = "Example session — DeepSeek Harness";
    await waitFor(() => expect(document.title).toBe("WorkAgent"));
    document.querySelector("title").textContent = "DeepSeek Harness";
    await waitFor(() => expect(document.title).toBe("WorkAgent"));
  });

  it("persists the text size and keeps general permissions hidden", () => {
    const entries = compose();
    const Typography = entries.find(
      (entry) => entry.options.id === "workagent-typography",
    ).Component;
    const { unmount } = render(<Typography />);
    expect(screen.getByLabelText("字体大小").value).toBe("13");
    fireEvent.change(screen.getByLabelText("字体大小"), {
      target: { value: "16" },
    });
    expect(localStorage.getItem("workagent.font-size")).toBe("16");
    expect(
      document.documentElement.style.getPropertyValue("--workagent-font-scale"),
    ).toBe(String(16 / 14));
    unmount();
    render(<Typography />);
    expect(screen.getByLabelText("字体大小").value).toBe("16");
  });

  it("shows retry status and waits for turn completion after an assistant item", async () => {
    window.history.replaceState({}, "", "/?session=retry-session");
    let stream;
    const previous = globalThis.EventSource;
    globalThis.EventSource = class {
      constructor() {
        stream = this;
      }
      close() {}
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify(
            String(path).endsWith("/messages") ||
              String(path).includes("/interactions?")
              ? []
              : { id: "retry-session", engine: "codex", title: "重试状态" },
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const Overlay = compose().find(
      (entry) => entry.options.id === "workagent-page",
    ).Component;
    const view = render(<Overlay />);
    try {
      await screen.findByText("重试状态");
      const emit = (value) =>
        act(() => stream.onmessage({ data: JSON.stringify(value) }));
      emit({ type: "turn.started" });
      expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
      emit({
        type: "turn.retrying",
        message: "We're experiencing high demand",
      });
      expect(screen.getByRole("status").textContent).toContain("模型服务繁忙");
      emit({ type: "assistant.completed" });
      expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
      emit({ type: "turn.completed" });
      expect(screen.queryByRole("status")).toBeNull();
      expect(
        screen.getByRole("button", { name: "发送", exact: true }),
      ).toBeTruthy();
      emit({ type: "turn.started" });
      emit({ type: "turn.failed", message: "high demand" });
      expect(screen.getByRole("alert").textContent).toContain(
        "模型服务当前繁忙",
      );
      expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
    } finally {
      view.unmount();
      globalThis.EventSource = previous;
    }
  });

  it("preserves the selected project from a direct new conversation link", async () => {
    window.history.replaceState(
      {},
      "",
      "/?frontend=dsh&project=workspace-direct",
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify(
            String(path).endsWith("/workspaces")
              ? [{ id: "workspace-direct", name: "直接开始" }]
              : [],
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const Composer = compose().find(
      (entry) => entry.options.id === "workagent-workspace-composer",
    ).Component;
    render(<Composer />);
    await waitFor(() =>
      expect(screen.getByLabelText("个人项目").value).toBe("workspace-direct"),
    );
  });

  it("searches projects and opens the name field only after clicking new", async () => {
    window.history.replaceState({}, "", "/?workagent=workspaces");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify([
            { id: "design", name: "品牌设计" },
            { id: "research", name: "Research" },
          ]),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const Overlay = compose().find(
      (entry) => entry.options.id === "workagent-page",
    ).Component;
    render(<Overlay />);
    await screen.findByText("品牌设计");
    expect(screen.queryByLabelText("新项目名称")).toBeNull();
    fireEvent.change(screen.getByLabelText("搜索项目"), {
      target: { value: " RESEARCH " },
    });
    expect(screen.queryByText("品牌设计")).toBeNull();
    expect(screen.getByText("Research")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("搜索项目"), {
      target: { value: "找不到" },
    });
    expect(screen.getByText("没有找到匹配的项目")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清除项目搜索" }));
    expect(screen.getByText("品牌设计")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "新建项目", exact: true }),
    );
    expect(screen.getByLabelText("新项目名称")).toBe(document.activeElement);
    fireEvent.click(screen.getByRole("button", { name: "取消", exact: true }));
    expect(screen.queryByLabelText("新项目名称")).toBeNull();
  });

  it("keeps a sidebar spinner through retries, shows completion and remembers reads", async () => {
    window.history.replaceState({}, "", "/?session=session-live");
    let session = {
      id: "session-live",
      title: "状态测试",
      engine: "codex",
      updatedAt: "2026-09-06T00:00:00Z",
      activity: { state: "running" },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify(String(path).endsWith("/sessions") ? [session] : []),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const Sidebar = compose().find(
      (entry) => entry.options.id === "workagent-sidebar-browser",
    ).Component;
    const { unmount } = render(<Sidebar />);
    expect(await screen.findByRole("img", { name: "正在运行" })).toBeTruthy();
    session = { ...session, activity: { state: "retrying" } };
    act(() => window.dispatchEvent(new Event("workagent:sessions-changed")));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "正在运行" })).toBeTruthy(),
    );
    session = {
      ...session,
      activity: { state: "idle" },
      lastTurn: {
        id: "turn-1",
        status: "completed",
        completedAt: session.updatedAt,
      },
    };
    act(() => window.dispatchEvent(new Event("workagent:sessions-changed")));
    expect(
      await screen.findByRole("img", { name: "已完成，未读" }),
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: "正在运行" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /状态测试 已完成/ }));
    expect(screen.queryByRole("img", { name: "已完成，未读" })).toBeNull();
    expect(localStorage.getItem("workagent.session-seen.session-live")).toBe(
      "turn-1",
    );
    unmount();
    window.history.replaceState({}, "", "/");
    render(<Sidebar />);
    await screen.findByText("状态测试");
    expect(screen.queryByRole("img", { name: "已完成，未读" })).toBeNull();
    session = {
      ...session,
      lastTurn: { ...session.lastTurn, id: "turn-2", status: "failed" },
    };
    act(() => window.dispatchEvent(new Event("workagent:sessions-changed")));
    expect(
      await screen.findByRole("img", { name: "运行失败，未读" }),
    ).toBeTruthy();
  });

  it("renames nested project files, provides downloads and confirms deletion", async () => {
    window.history.replaceState({}, "", "/?workagent=workspaces");
    let name = "原稿.txt";
    let removed = false;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (path, init = {}) => {
        if (String(path).includes("/interactions?"))
          return new Response("[]", {
            headers: { "content-type": "application/json" },
          });
        if (String(path) === "/api/speech/capability")
          return new Response('{"enabled":false}', {
            headers: { "content-type": "application/json" },
          });
        const url = String(path);
        if (init.method === "POST") {
          name = JSON.parse(init.body).destination.split("/").pop();
          return new Response(null, { status: 204 });
        }
        if (init.method === "DELETE") {
          removed = true;
          return new Response(null, { status: 204 });
        }
        const payload = url.includes("/files?path=")
          ? removed
            ? []
            : [{ name, path: `资料/${name}`, kind: "file" }]
          : url.endsWith("/files")
            ? [{ name: "资料", path: "资料", kind: "directory" }]
            : [{ id: "project-1", name: "项目" }];
        return new Response(JSON.stringify(payload), {
          headers: { "Content-Type": "application/json" },
        });
      });
    const Overlay = compose().find(
      (entry) => entry.options.id === "workagent-page",
    ).Component;
    render(<Overlay />);
    fireEvent.click(await screen.findByRole("button", { name: "管理文件" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "资料", exact: true }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "重命名 原稿.txt" }),
    );
    fireEvent.change(screen.getByLabelText("文件名"), {
      target: { value: "定稿.txt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    const download = await screen.findByRole("link", { name: "下载 定稿.txt" });
    expect(download.getAttribute("href")).toContain(
      encodeURIComponent("资料/定稿.txt"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/v1/workspaces/project-1/move",
      expect.objectContaining({
        body: JSON.stringify({
          source: "资料/原稿.txt",
          destination: "资料/定稿.txt",
        }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "删除 定稿.txt" }));
    expect(removed).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "删除", exact: true }));
    expect(await screen.findByText("此文件夹还没有文件")).toBeTruthy();
    expect(removed).toBe(true);
  });

  it("renders MCP state and calls the managed toggle API", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init = {}) => {
        if (init.method === "PATCH")
          return new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        return new Response(
          JSON.stringify([
            {
              id: "docs",
              name: "Docs",
              source: "user",
              enabled: true,
              oauthState: "needs_auth",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
    const entries = compose();
    const section = entries.find(
      (entry) => entry.options.id === "workagent-mcp",
    );
    render(React.createElement(section.Component));
    fireEvent.click(await screen.findByRole("button", { name: "停用" }));
    expect(screen.getByRole("button", { name: "授权" })).toBeTruthy();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runtime/v1/mcp-servers/docs",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      enabled: false,
    });
  });

  it("creates an HTTP MCP server from the focused form", async () => {
    let rows = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_path, init = {}) => {
        if (init.method === "POST") {
          const input = JSON.parse(init.body);
          rows = [{ ...input, id: "docs", health: "unknown" }];
          return new Response(JSON.stringify(rows[0]), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
    const mcp = compose().find((entry) => entry.options.id === "workagent-mcp");
    const { container } = render(React.createElement(mcp.Component));
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "Docs" },
    });
    fireEvent.change(screen.getByLabelText("服务地址"), {
      target: { value: "https://example.com/mcp" },
    });
    fireEvent.submit(screen.getByLabelText("服务地址").closest("form"));
    expect(await screen.findByText("Docs")).toBeTruthy();
    expect(
      JSON.parse(
        fetchMock.mock.calls.find((call) => call[1]?.method === "POST")[1].body,
      ),
    ).toMatchObject({
      name: "Docs",
      transport: { kind: "http", url: "https://example.com/mcp" },
    });
  });

  it("presents a visible skill market and installs from it", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (path, init = {}) => {
        if (String(path).includes("/interactions?"))
          return new Response("[]", {
            headers: { "content-type": "application/json" },
          });
        if (String(path) === "/api/speech/capability")
          return new Response('{"enabled":false}', {
            headers: { "content-type": "application/json" },
          });
        const target = String(path);
        const payload = target.includes("/marketplace")
          ? { entries: [] }
          : target.includes("skill-market")
            ? init.method === "POST"
              ? {}
              : {
                  skills: [
                    {
                      id: "writing",
                      name: "Writing helper",
                      version: "1.0.0",
                    },
                  ],
                }
            : [];
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
    const section = compose().find(
      (entry) => entry.options.id === "workagent-market",
    );
    render(React.createElement(section.Component));
    expect(await screen.findByText("Writing helper")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "获取" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/portal/skill-market/install",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("switches built-in assistants and keeps the saved state when a request fails", async () => {
    let enabled = false;
    let fail = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (path, init = {}) => {
        if (init.method === "PATCH") {
          if (fail)
            return new Response(JSON.stringify({ error: "save_failed" }), {
              status: 500,
            });
          enabled = JSON.parse(init.body).enabled;
        }
        return new Response(
          JSON.stringify(
            String(path).includes("/presets")
              ? [
                  {
                    id: "builtin-general",
                    name: "General",
                    engine: "harness",
                    source: "builtin",
                    enabled,
                  },
                ]
              : [],
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    const section = compose().find(
      (entry) => entry.options.id === "workagent-presets",
    );
    render(React.createElement(section.Component));
    const picker = compose().find(
      (entry) => entry.options.id === "workagent-agent-picker",
    );
    render(React.createElement(picker.Component));
    const control = await screen.findByRole("switch", { name: "DSH 开关" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
    fireEvent.click(control);
    await waitFor(() =>
      expect(control.getAttribute("aria-checked")).toBe("true"),
    );
    expect(
      await screen.findByRole("radio", { name: "DSH", exact: true }),
    ).toBeTruthy();
    fail = true;
    fireEvent.click(control);
    await screen.findByRole("alert");
    expect(control.getAttribute("aria-checked")).toBe("true");
    fail = false;
    fireEvent.click(control);
    await waitFor(() =>
      expect(control.getAttribute("aria-checked")).toBe("false"),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("radio", { name: "DSH", exact: true }),
      ).toBeNull(),
    );
  });

  it("creates, edits, and deletes a preset through the complete editor", async () => {
    let rows = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_path, init = {}) => {
        if (init.method === "POST") {
          const input = JSON.parse(init.body);
          rows = [{ ...input, id: "new", source: "user" }];
          return new Response(JSON.stringify(rows[0]), {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (init.method === "PATCH") {
          rows = [{ ...rows[0], ...JSON.parse(init.body) }];
          return new Response(JSON.stringify(rows[0]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (init.method === "DELETE") {
          rows = [];
          return new Response(null, { status: 204 });
        }
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
    const section = compose().find(
      (entry) => entry.options.id === "workagent-presets",
    );
    const { container } = render(React.createElement(section.Component));
    expect(screen.queryByLabelText("模型")).toBeNull();
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "Writer" },
    });
    fireEvent.submit(container.querySelector("form"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runtime/v1/presets",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(
      JSON.parse(
        fetchMock.mock.calls.find((call) => call[1]?.method === "POST")[1].body,
      ),
    ).toMatchObject({
      name: "Writer",
      engine: "harness",
      skillIds: [],
      mcpServerIds: [],
    });
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("名称"), {
      target: { value: "Editor" },
    });
    fireEvent.submit(container.querySelector("form"));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runtime/v1/presets/new",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    expect(confirm).toHaveBeenCalledWith(
      "确定删除助手“Editor”？此操作无法撤销。",
    );
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
    expect(screen.getByText("Editor", { selector: "strong" })).toBeTruthy();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runtime/v1/presets/new",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });

  it("leaves channel settings to the native IM plugin", () => {
    const entries = compose();
    expect(
      entries.some((entry) =>
        [
          "workagent-engines",
          "workagent-extensions",
          "workagent-channels",
        ].includes(entry.options.id),
      ),
    ).toBe(false);
  });

  it("reloads capabilities on reopening and falls back when a saved effort is retired", async () => {
    let refreshed = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify(
            String(path).endsWith("/model-options")
              ? [
                  {
                    engine: "harness",
                    state: "ready",
                    models: [
                      {
                        id: "live-model",
                        name: refreshed ? "Updated model" : "Live model",
                        isDefault: true,
                        defaultReasoning: refreshed ? "xhigh" : "low",
                        reasoning: refreshed
                          ? [{ id: "xhigh", name: "xhigh" }]
                          : [{ id: "low", name: "low" }],
                      },
                    ],
                  },
                ]
              : String(path).endsWith("/presets")
                ? [
                    {
                      id: "builtin-general",
                      engine: "harness",
                      name: "General",
                      enabled: true,
                    },
                  ]
                : [],
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const composer = compose().find(
      (entry) => entry.options.id === "workagent-workspace-composer",
    );
    const first = render(React.createElement(composer.Component));
    await waitFor(() =>
      expect(screen.getByLabelText("思考级别").value).toBe("low"),
    );
    expect(screen.getByLabelText("模型").value).toBe("live-model");
    expect(screen.getByLabelText("思考级别").options.length).toBe(1);
    expect(screen.queryByLabelText("刷新模型和思考强度")).toBeNull();
    refreshed = true;
    first.unmount();
    render(React.createElement(composer.Component));
    await waitFor(() =>
      expect(screen.getByLabelText("思考级别").value).toBe("xhigh"),
    );
    expect(screen.getByRole("option", { name: "Updated model" })).toBeTruthy();
  });

  it("keeps draft choices per engine but restores defaults when starting a new conversation", async () => {
    const presets = [
      { id: "builtin-general", engine: "harness", enabled: true },
      { id: "builtin-codex", engine: "codex", enabled: true },
    ];
    let unavailable = false;
    let retired = false;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (path) => {
        if (String(path).includes("/interactions?"))
          return new Response("[]", {
            headers: { "content-type": "application/json" },
          });
        if (String(path) === "/api/speech/capability")
          return new Response('{"enabled":false}', {
            headers: { "content-type": "application/json" },
          });
        const models = ["first", "second"]
          .filter((id) => !retired || id !== "second")
          .map((id) => ({
            id,
            name: id,
            isDefault: id === "first",
            defaultReasoning: "low",
            reasoning: [{ id: "low" }, { id: "high" }],
          }));
        const payload = String(path).endsWith("/model-options")
          ? presets.map(({ engine }) => ({
              engine,
              state: unavailable ? "unavailable" : "ready",
              models: unavailable ? [] : models,
            }))
          : String(path).endsWith("/presets")
            ? presets
            : [];
        return new Response(JSON.stringify(payload), {
          headers: { "Content-Type": "application/json" },
        });
      });
    const composer = compose().find(
      (entry) => entry.options.id === "workagent-workspace-composer",
    );
    const mount = () => render(React.createElement(composer.Component));
    const expectChoice = async (model, effort) =>
      waitFor(() => {
        expect(screen.getByLabelText("模型").value).toBe(model);
        expect(screen.getByLabelText("思考级别").value).toBe(effort);
      });
    let view = mount();
    await expectChoice("first", "low");
    fireEvent.change(screen.getByLabelText("模型"), {
      target: { value: "second" },
    });
    fireEvent.change(screen.getByLabelText("思考级别"), {
      target: { value: "high" },
    });
    await expectChoice("second", "high");
    fireEvent.change(screen.getByLabelText("模型"), {
      target: { value: "first" },
    });
    await expectChoice("first", "low");
    fireEvent.change(screen.getByLabelText("模型"), {
      target: { value: "second" },
    });
    await expectChoice("second", "high");
    window.dispatchEvent(
      new CustomEvent("workagent:hero-agent", { detail: "builtin-codex" }),
    );
    await expectChoice("first", "low");
    window.dispatchEvent(
      new CustomEvent("workagent:hero-agent", { detail: "builtin-general" }),
    );
    await expectChoice("second", "high");
    view.unmount();
    unavailable = true;
    view = mount();
    await screen.findByRole("option", { name: "暂无可用模型" });
    expect(screen.getByLabelText("模型").disabled).toBe(true);
    view.unmount();
    unavailable = false;
    view = mount();
    await expectChoice("first", "low");
    expect(
      fetchMock.mock.calls.filter(([path]) =>
        String(path).endsWith("/model-options"),
      ),
    ).toHaveLength(3);
    view.unmount();
    retired = true;
    mount();
    await expectChoice("first", "low");
  });

  it("renders centrally managed models without credential fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            engine: "harness",
            state: "ready",
            models: [
              {
                id: "deepseek",
                name: "DeepSeek",
                isDefault: true,
                reasoning: [],
              },
            ],
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const section = compose().find(
      (entry) => entry.options.id === "workagent-models",
    );
    render(React.createElement(section.Component));
    expect(
      await screen.findByText("DeepSeek", { selector: "strong" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "刷新模型" })).toBeNull();
    expect(screen.queryByLabelText(/key/i)).toBeNull();
  });

  it("shows remaining percentages in user settings without dollar amounts", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async path => new Response(JSON.stringify(String(path) === "/api/quota/dollars" ? {budgets:[{pool:"codex",dailyUsd:2,weeklyUsd:5,dailyLimitUsd:40,weeklyLimitUsd:80},{pool:"kimi",dailyUsd:1,weeklyUsd:3,dailyLimitUsd:10,weeklyLimitUsd:20}]} : []),{headers:{"Content-Type":"application/json"}}));
    const Component=compose().find(entry=>entry.options.id==="workagent-quota").Component;
    const view=render(<Component />);
    expect(await screen.findByText("95%")).toBeTruthy();
    expect(screen.getByText("94%")).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/\$|美元/);
    expect(screen.getByText("DSH 与 Codex / ChatGPT 共享额度。")).toBeTruthy();
    view.unmount();
  });
  it("uses the official theme service", () => {
    const entries = compose();
    const themeEntry = entries.find(
      (entry) => entry.options.id === "workagent-theme",
    );
    render(React.createElement(themeEntry.Component, { wide: true }));
    fireEvent.click(screen.getByRole("button", { name: "主题" }));
    expect(entries.theme.setTheme).toHaveBeenCalledWith("dark");
  });

  it("selects every assistant and supports personal project choices", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (path) => {
      if (String(path).includes("/interactions?"))
        return new Response("[]", {
          headers: { "content-type": "application/json" },
        });
      if (String(path) === "/api/speech/capability")
        return new Response('{"enabled":false}', {
          headers: { "content-type": "application/json" },
        });
      const target = String(path);
      const payload = target.endsWith("/presets")
        ? [
            {
              id: "builtin-codex",
              name: "Codex",
              engine: "codex",
              enabled: true,
            },
            {
              id: "builtin-general",
              name: "General",
              engine: "harness",
              enabled: true,
            },
            { id: "builtin-kimi", name: "Kimi", engine: "kimi", enabled: true },
          ]
        : target.endsWith("/sessions")
          ? [
              {
                id: "session-1",
                title: "设计评审",
                engine: "harness",
                workspaceId: "workspace-2",
                updatedAt: "2026-09-05T00:00:00Z",
              },
            ]
          : [
              { id: "workspace-1", name: "Personal workspace" },
              { id: "workspace-2", name: "设计项目" },
            ];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const entries = compose();
    const agent = entries.find(
      (entry) => entry.options.id === "workagent-agent-picker",
    );
    const workspace = entries.find(
      (entry) => entry.options.id === "workagent-workspace-composer",
    );
    const sidebar = entries.find(
      (entry) => entry.options.id === "workagent-sidebar-browser",
    );
    render(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(agent.Component),
        React.createElement(workspace.Component),
        React.createElement(sidebar.Component),
      ),
    );

    const codex = await screen.findByRole("radio", { name: "Codex" });
    expect(codex.disabled).toBe(false);
    fireEvent.click(codex);
    expect(codex.getAttribute("aria-checked")).toBe("true");
    const kimi = screen.getByRole("radio", { name: "Kimi" });
    expect(kimi.disabled).toBe(false);
    fireEvent.click(kimi);
    expect(kimi.getAttribute("aria-checked")).toBe("true");

    const projectSelect = await screen.findByLabelText("个人项目");
    expect(screen.getByRole("option", { name: "不使用项目" })).toBeTruthy();
    fireEvent.change(projectSelect, { target: { value: "workspace-2" } });
    expect(projectSelect.value).toBe("workspace-2");
    const projectButton = screen.getByRole("button", { name: "设计项目" });
    fireEvent.click(projectButton);
    expect(projectButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("clears the conversation filter when search is closed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (path) => {
      if (String(path).includes("/interactions?"))
        return new Response("[]", {
          headers: { "content-type": "application/json" },
        });
      if (String(path) === "/api/speech/capability")
        return new Response('{"enabled":false}', {
          headers: { "content-type": "application/json" },
        });
      const payload = String(path).endsWith("/sessions")
        ? [
            {
              id: "session-1",
              title: "设计评审",
              engine: "harness",
              workspaceId: "workspace-1",
              updatedAt: "2026-09-05T00:00:00Z",
            },
          ]
        : [{ id: "workspace-1", name: "Personal workspace" }];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const sidebar = compose().find(
      (entry) => entry.options.id === "workagent-sidebar-browser",
    );
    render(React.createElement(sidebar.Component));

    expect(await screen.findByText("设计评审")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "搜索对话" }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索对话" }), {
      target: { value: "没有结果" },
    });
    expect(screen.getByText("没有匹配的对话")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "关闭搜索" }));
    expect(screen.queryByRole("textbox", { name: "搜索对话" })).toBeNull();
    expect(screen.getByText("设计评审")).toBeTruthy();
  });

  it("keeps projectless conversations outside project groups", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (path) => {
      if (String(path).includes("/interactions?"))
        return new Response("[]", {
          headers: { "content-type": "application/json" },
        });
      if (String(path) === "/api/speech/capability")
        return new Response('{"enabled":false}', {
          headers: { "content-type": "application/json" },
        });
      const target = String(path);
      const payload = target.endsWith("/sessions")
        ? [
            {
              id: "session-free",
              title: "临时对话",
              engine: "harness",
              workspaceId: "default",
              updatedAt: "2026-09-05T00:00:00Z",
            },
          ]
        : [];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const sidebar = compose().find(
      (entry) => entry.options.id === "workagent-sidebar-browser",
    );
    render(React.createElement(sidebar.Component));

    expect(await screen.findByText("临时对话")).toBeTruthy();
    expect(screen.getByText("对话")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "default" })).toBeNull();
  });

  it("collapses project and conversation sections independently and remembers them", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify(
            String(path).endsWith("/workspaces")
              ? [
                  { id: "project-a", name: "项目甲" },
                  { id: "project-b", name: "项目乙" },
                ]
              : String(path).endsWith("/sessions")
                ? [
                    {
                      id: "linked",
                      title: "项目内对话",
                      engine: "codex",
                      workspaceId: "project-a",
                      updatedAt: "2026-09-06",
                    },
                    {
                      id: "free",
                      title: "独立对话",
                      engine: "kimi",
                      updatedAt: "2026-09-06",
                    },
                  ]
                : [],
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const Sidebar = compose().find(
      (entry) => entry.options.id === "workagent-sidebar-browser",
    ).Component;
    const first = render(<Sidebar />);
    await screen.findByText("项目内对话");
    fireEvent.click(
      screen.getByRole("button", { name: "项目甲", exact: true }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "收起项目", exact: true }),
    );
    expect(screen.queryByText("项目甲")).toBeNull();
    expect(screen.queryByText("项目乙")).toBeNull();
    expect(screen.getByText("独立对话")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "展开项目", exact: true }),
    );
    expect(screen.getByText("项目甲")).toBeTruthy();
    expect(screen.queryByText("项目内对话")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "收起项目", exact: true }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "收起对话", exact: true }),
    );
    expect(screen.queryByText("独立对话")).toBeNull();
    first.unmount();
    render(<Sidebar />);
    expect(
      screen
        .getByRole("button", { name: "展开项目" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: "展开对话" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "展开对话" }));
    await screen.findByText("独立对话");
    expect(screen.queryByText("项目甲")).toBeNull();
  });

  it("keeps only failed conversations selected after a partial batch delete", async () => {
    let removed = false;
    const calls = [];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (path, init = {}) => {
        const target = String(path);
        if (init.method === "DELETE") {
          calls.push(target);
          if (target.endsWith("/one")) {
            removed = true;
            return new Response(null, { status: 204 });
          }
          return new Response('{"error":"session_busy"}', { status: 409 });
        }
        const payload = target.endsWith("/sessions")
          ? [
              !removed && {
                id: "one",
                title: "成功项",
                engine: "codex",
                workspaceId: "project",
                updatedAt: "2026-09-08T01:00:00Z",
              },
              {
                id: "two",
                title: "失败项",
                engine: "codex",
                workspaceId: "project",
                updatedAt: "2026-09-08T00:00:00Z",
              },
            ].filter(Boolean)
          : target.endsWith("/workspaces")
            ? [{ id: "project", name: "项目" }]
            : [];
        return new Response(JSON.stringify(payload), {
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    const sidebar = compose().find(
      (entry) => entry.options.id === "workagent-sidebar-browser",
    );
    render(React.createElement(sidebar.Component));
    await screen.findByRole("button", { name: "编辑对话 成功项" });
    fireEvent.click(screen.getByRole("button", { name: "多选对话" }));
    fireEvent.click(screen.getByRole("button", { name: "全选当前列表" }));
    fireEvent.click(screen.getByRole("button", { name: "删除选中（2）" }));
    await screen.findByRole("button", { name: "删除选中（1）" });
    expect(screen.getByRole("alert").textContent).toContain("失败项");
    expect(screen.getByLabelText("选择对话 失败项").checked).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("renames projects and deletes conversations from the sidebar", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (path, init = {}) => {
        if (String(path).includes("/interactions?"))
          return new Response("[]", {
            headers: { "content-type": "application/json" },
          });
        if (String(path) === "/api/speech/capability")
          return new Response('{"enabled":false}', {
            headers: { "content-type": "application/json" },
          });
        const target = String(path);
        const payload = target.endsWith("/sessions")
          ? [
              {
                id: "session-1",
                title: "旧对话",
                engine: "codex",
                workspaceId: "workspace-1",
                updatedAt: "2026-09-05T00:00:00Z",
              },
            ]
          : target.endsWith("/teams")
            ? []
            : [{ id: "workspace-1", name: "旧项目" }];
        return new Response(
          init.method === "DELETE" ? null : JSON.stringify(payload),
          {
            status: init.method === "DELETE" ? 204 : 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });
    const sidebar = compose().find(
      (entry) => entry.options.id === "workagent-sidebar-browser",
    );
    render(React.createElement(sidebar.Component));
    fireEvent.click(
      await screen.findByRole("button", { name: "编辑项目 旧项目" }),
    );
    const projectName = screen
      .getByRole("dialog", { name: "重命名" })
      .querySelector("input");
    fireEvent.change(projectName, { target: { value: "新项目" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runtime/v1/workspaces/workspace-1",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑对话 旧对话" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runtime/v1/sessions/session-1",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });

  it("creates automations with the selected assistant engine and retains failed input", async () => {
    window.history.replaceState({}, "", "/?workagent=automations");
    let fail = true;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (path, init = {}) => {
        if (String(path).includes("/interactions?"))
          return new Response("[]", {
            headers: { "content-type": "application/json" },
          });
        if (String(path) === "/api/speech/capability")
          return new Response('{"enabled":false}', {
            headers: { "content-type": "application/json" },
          });
        if (init.method === "POST")
          return new Response(
            JSON.stringify(fail ? { error: "暂时无法创建" } : {}),
            { status: fail ? 500 : 200 },
          );
        const rows = String(path).endsWith("/presets")
          ? [
              { id: "kimi", name: "Kimi", engine: "kimi", enabled: true },
              { id: "off", name: "Disabled", enabled: false },
            ]
          : String(path).endsWith("/workspaces")
            ? [{ id: "project", name: "设计项目" }]
            : [];
        return new Response(JSON.stringify(rows), {
          headers: { "Content-Type": "application/json" },
        });
      });
    const overlay = compose().find(
      (entry) => entry.options.id === "workagent-page",
    );
    render(React.createElement(overlay.Component));
    await screen.findByRole("option", { name: "Kimi" });
    expect(screen.queryByRole("option", { name: "Disabled" })).toBeNull();
    fireEvent.change(screen.getByLabelText("任务名称"), {
      target: { value: "进展汇总" },
    });
    fireEvent.change(screen.getByLabelText("执行助手"), {
      target: { value: "kimi" },
    });
    fireEvent.change(screen.getByLabelText("所属项目"), {
      target: { value: "project" },
    });
    fireEvent.change(screen.getByLabelText("任务内容"), {
      target: { value: "汇总项目进展" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("任务内容").value).toBe("汇总项目进展");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
    await waitFor(() =>
      expect(screen.getByLabelText("任务内容").value).toBe(""),
    );
    const calls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1][1].body)).toMatchObject({
      presetId: "kimi",
      engine: "kimi",
      workspaceId: "project",
      input: "汇总项目进展",
      schedule: { kind: "interval", everyMinutes: 60 },
    });
  });

  it("runs scheduled tasks from the dedicated page", async () => {
    window.history.replaceState({}, "", "/?workagent=automations");
    const definition = {
      id: "daily",
      name: "Daily brief",
      nextRunAt: "tomorrow",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_path, init = {}) =>
        new Response(
          JSON.stringify(init.method === "POST" ? {} : [definition]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    const overlay = compose().find(
      (entry) => entry.options.id === "workagent-page",
    );
    render(React.createElement(overlay.Component));
    fireEvent.click(await screen.findByRole("button", { name: "立即运行" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runtime/v1/automations/daily/run",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("clears the successful home draft and allows another send without remounting", async () => {
    let turns=0;
    vi.spyOn(globalThis,"fetch").mockImplementation(async (path,init={})=>{
      const url=String(path);let payload=[];
      if(init.method==="POST"&&url.endsWith("/sessions"))payload={id:`created-${turns}`};
      else if(init.method==="POST"&&url.endsWith("/turns")){turns++;payload={};}
      else if(url.endsWith("/presets"))payload=[{id:"builtin-general",engine:"codex",name:"Codex",enabled:true}];
      else if(url.endsWith("/model-options"))payload=[{engine:"codex",state:"ready",models:[{id:"test-model",name:"test",isDefault:true,reasoning:[]}]}];
      return new Response(JSON.stringify(payload),{headers:{"Content-Type":"application/json"}});
    });
    const Component=compose().find(e=>e.options.id==="workagent-workspace-composer").Component;
    const view=render(<Component/>);
    await waitFor(()=>expect(screen.getByLabelText("模型").value).toBe("test-model"));
    for(const value of ["test connection","second message"]){
      fireEvent.change(screen.getByLabelText("输入消息"),{target:{value}});
      await waitFor(()=>expect(screen.getByRole("button",{name:"发送消息"}).disabled).toBe(false));
      fireEvent.click(screen.getByRole("button",{name:"发送消息"}));
      await waitFor(()=>expect(screen.getByLabelText("输入消息").value).toBe(""));
    }
    expect(turns).toBe(2);view.unmount();
  });
  it("creates team work from the new-conversation composer", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (path, init = {}) => {
        if (String(path).includes("/interactions?"))
          return new Response("[]", {
            headers: { "content-type": "application/json" },
          });
        if (String(path) === "/api/speech/capability")
          return new Response('{"enabled":false}', {
            headers: { "content-type": "application/json" },
          });
        const target = String(path);
        let payload = [];
        if (init.method === "POST" && target.endsWith("/teams"))
          payload = {
            id: "team-1",
            members: [{ sessionId: "team-session-1" }],
          };
        else if (init.method === "POST" && target.endsWith("/turns"))
          return new Response(JSON.stringify({ error: "turn_not_started" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        else if (target.endsWith("/presets"))
          payload = [
            {
              id: "builtin-general",
              name: "General",
              engine: "harness",
              enabled: true,
            },
          ];
        else if (target.endsWith("/workspaces"))
          payload = [{ id: "team-project", name: "Research", scope: "team" }];
        else if (target.endsWith("/model-options"))
          payload = [
            {
              engine: "harness",
              state: "ready",
              models: [
                {
                  id: "test-model",
                  name: "Test model",
                  isDefault: true,
                  reasoning: [],
                },
              ],
            },
          ];
        else if (target.includes("/notifications"))
          payload = { notifications: [] };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
    const composer = compose().find(
      (entry) => entry.options.id === "workagent-workspace-composer",
    );
    render(React.createElement(composer.Component));
    await screen.findByLabelText("个人项目");
    await waitFor(() =>
      expect(screen.getByLabelText("模型").value).toBe("test-model"),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "团队模式" }));
    fireEvent.change(screen.getByLabelText("团队项目"), {
      target: { value: "team-project" },
    });
    fireEvent.change(screen.getByLabelText("输入消息"), {
      target: { value: "Investigate" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runtime/v1/teams",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("browses and previews workspace text files", async () => {
    window.history.replaceState({}, "", "/?workagent=workspaces");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (path) => {
      if (String(path).includes("/interactions?"))
        return new Response("[]", {
          headers: { "content-type": "application/json" },
        });
      if (String(path) === "/api/speech/capability")
        return new Response('{"enabled":false}', {
          headers: { "content-type": "application/json" },
        });
      if (String(path).includes("/content?"))
        return new Response("hello workspace", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      const payload = String(path).endsWith("/files")
        ? [{ name: "notes.txt", path: "notes.txt", kind: "file" }]
        : [{ id: "workspace-1", name: "Project" }];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const overlay = compose().find(
      (entry) => entry.options.id === "workagent-page",
    );
    render(React.createElement(overlay.Component));
    fireEvent.click(await screen.findByRole("button", { name: "管理文件" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "预览 notes.txt" }),
    );
    expect(await screen.findByText("hello workspace")).toBeTruthy();
  });

  it("shows unread notifications and acknowledges them", async () => {
    window.history.replaceState({}, "", "/?workagent=notifications");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_path, init = {}) =>
        new Response(
          JSON.stringify(
            init.method === "POST"
              ? { success: true }
              : {
                  notifications: [
                    { id: "notice-1", kind: "task", message: "Done" },
                  ],
                },
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const overlay = compose().find(
      (entry) => entry.options.id === "workagent-page",
    );
    render(React.createElement(overlay.Component));
    expect(await screen.findByText("Done")).toBeTruthy();
    expect(screen.getByText("未读 1 条")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "标记已读" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/portal/me/notifications/notice-1/acknowledge",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("opens the runtime conversation for a session deep link", async () => {
    window.history.replaceState(
      {},
      "",
      "/?session=session-1&message=message-1",
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (path) => {
      if (String(path).includes("/interactions?"))
        return new Response("[]", {
          headers: { "content-type": "application/json" },
        });
      if (String(path) === "/api/speech/capability")
        return new Response('{"enabled":false}', {
          headers: { "content-type": "application/json" },
        });
      const payload = String(path).endsWith("/messages")
        ? [
            {
              id: "message-1",
              role: "assistant",
              text: "我是 **Codex**，可以处理 `Markdown`。\n\n- 第一项\n- 第二项\n\n3. 第三项\n4. 第四项\n\n后续段落",
            },
          ]
        : {
            id: "session-1",
            engine: "codex",
            title: "整理项目进度",
            preset: {
              presetId: "builtin-codex",
              resolvedSnapshot: { name: "Codex" },
            },
          };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const overlay = compose().find(
      (entry) => entry.options.id === "workagent-page",
    );
    const { container } = render(React.createElement(overlay.Component));
    expect(screen.getByRole("dialog", { name: "会话" })).toBeTruthy();
    expect(screen.getByLabelText("继续对话")).toBeTruthy();
    expect(await screen.findByText("整理项目进度")).toBeTruthy();
    expect(
      container.querySelector(".workagent-markdown strong")?.textContent,
    ).toBe("Codex");
    expect(container.textContent).not.toContain("**Codex**");
    expect(
      container.querySelectorAll(".workagent-markdown ul > li"),
    ).toHaveLength(2);
    expect(
      container.querySelectorAll(".workagent-markdown ol > li"),
    ).toHaveLength(2);
    expect(container.querySelector(".workagent-markdown ol").start).toBe(3);
    expect(container.querySelector(".workagent-markdown > li")).toBeNull();
    const target = container.querySelector('[data-message-id="message-1"]');
    target.scrollIntoView = vi.fn();
    await waitFor(() => expect(target.scrollIntoView).toHaveBeenCalled());
    expect(target.classList.contains("workagent-message-highlight")).toBe(true);
  });
});

describe("conversation controls", () => {
  it("reads native projection history and sends/cancels through standard session operations", async () => {
    window.history.replaceState({}, "", "/?session=session-main");
    const listeners = new Set();
    let value;
    const projection = {
      messages: [
        { id: "original-id", role: "assistant", text: "canonical reply" },
      ],
      metadata: {
        id: "session-main",
        engine: "codex",
        title: "Native title",
        queue: [],
      },
      activity: { state: "idle" },
      draft: "",
      progress: "",
      activeTool: false,
    };
    const face = {
      getSnapshot: () => value,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    const prompt = vi.fn(async () => ({ ok: true, value: { accepted: true } }));
    const cancel = vi.fn(async () => ({ ok: true, value: { accepted: true } }));
    const binding = {
      sessionId: "session-main",
      session: { projections: { faceOf: vi.fn(() => face) }, prompt, cancel },
    };
    const history = vi.fn(async () => ({
      result: {
        ok: true,
        value: {
          events: [],
          hasMore: false,
          projections: { asOfSeq: 4, values: { nativeSession: projection } },
        },
      },
    }));
    const open = vi.fn();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async (path) =>
          new Response(
            JSON.stringify(
              String(path).endsWith("/sessions/session-main")
                ? { id: "session-main", engine: "codex", title: "Native title" }
                : [],
            ),
            { headers: { "content-type": "application/json" } },
          ),
      );
    const previous = globalThis.EventSource;
    const eventSource = vi.fn();
    globalThis.EventSource = class {
      constructor(url) {
        eventSource(url);
      }
      close() {}
    };
    const Component = compose(undefined, {
      sessions: {
        binding: () => binding,
        open,
        list: { subscribe: () => () => {} },
      },
      connection: {
        api: {
          sessions: {
            history,
            models: async () => ({
              result: {
                ok: true,
                value: {
                  current: { provider: "codex", model: "gpt-6-astra" },
                  groups: [
                    {
                      id: "codex",
                      name: "Codex",
                      models: [{ id: "gpt-6-astra", name: "GPT-6 Astra" }],
                    },
                  ],
                },
              },
            }),
          },
        },
      },
      on: () => () => {},
    }).find((entry) => entry.options.id === "workagent-page").Component;
    const view = render(<Component />);
    try {
      await screen.findByText("canonical reply");
      expect((await screen.findByLabelText("当前会话模型")).value).toBe(
        "codex/gpt-6-astra",
      );
      expect(history).toHaveBeenCalledWith(
        { sessionId: "session-main" },
        expect.any(AbortSignal),
      );
      expect(
        fetchMock.mock.calls.some(([path]) =>
          /\/sessions\/session-main\/(messages|queue|events)$/.test(
            String(path),
          ),
        ),
      ).toBe(false);
      expect(eventSource).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText("继续对话"), {
        target: { value: "next request" },
      });
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      await waitFor(() =>
        expect(prompt).toHaveBeenCalledWith(
          [{ type: "text", text: "next request" }],
          "queue",
        ),
      );
      await act(async () => {
        value = {
          ...projection,
          activity: { state: "running" },
          draft: "streaming fact",
        };
        listeners.forEach((fn) => fn());
      });
      await screen.findByText("streaming fact");
      fireEvent.click(screen.getByRole("button", { name: "停止" }));
      await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "停止" })).toBeNull(),
      );
      prompt.mockResolvedValueOnce({
        ok: false,
        error: { code: "quota-exceeded", message: "native quota rejected" },
      });
      fireEvent.change(screen.getByLabelText("继续对话"), {
        target: { value: "keep rejected input" },
      });
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      await screen.findByText("native quota rejected");
      await waitFor(() =>
        expect(screen.getByLabelText("继续对话").value).toBe(
          "keep rejected input",
        ),
      );
      expect(open).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      globalThis.EventSource = previous;
    }
  });
  it("keeps newer native projections across delayed history and repulls on connection reset without legacy fallback", async () => {
    window.history.replaceState({}, "", "/?session=session-main");
    const listeners = new Set();
    const resets = new Set();
    let value;
    let settle;
    const makeProjection = (text) => ({
      messages: [{ id: "same-id", role: "assistant", text }],
      metadata: { engine: "kimi", title: "Native", queue: [] },
      activity: { state: "idle" },
      draft: "",
      progress: "",
    });
    const response = (projection) => ({
      result: {
        ok: true,
        value: {
          events: [],
          hasMore: false,
          projections: { asOfSeq: 10, values: { nativeSession: projection } },
        },
      },
    });
    const history = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      )
      .mockResolvedValue(response(makeProjection("after reconnect")));
    const face = {
      getSnapshot: () => value,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    const binding = { session: { projections: { faceOf: () => face } } };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async (path) =>
          new Response(
            JSON.stringify(
              String(path).endsWith("/sessions/session-main")
                ? { id: "session-main", engine: "kimi" }
                : [],
            ),
            { headers: { "content-type": "application/json" } },
          ),
      );
    const Component = compose(undefined, {
      sessions: { binding: () => binding, list: { subscribe: () => () => {} } },
      connection: { api: { sessions: { history } } },
      on: (_name, fn) => {
        resets.add(fn);
        return () => resets.delete(fn);
      },
    }).find((entry) => entry.options.id === "workagent-page").Component;
    const view = render(<Component />);
    try {
      await waitFor(() => expect(history).toHaveBeenCalledOnce());
      await act(async () => {
        value = makeProjection("newer push");
        listeners.forEach((fn) => fn());
      });
      await screen.findByText("newer push");
      await act(async () => settle(response(makeProjection("stale baseline"))));
      expect(screen.queryByText("stale baseline")).toBeNull();
      await act(async () => resets.forEach((fn) => fn()));
      await screen.findByText("after reconnect");
      expect(screen.queryByText("newer push")).toBeNull();
      history.mockResolvedValueOnce({
        result: {
          ok: false,
          error: { code: "transport", message: "native history unavailable" },
        },
      });
      await act(async () => resets.forEach((fn) => fn()));
      await screen.findByText("native history unavailable");
      expect(screen.getByText("after reconnect")).toBeTruthy();
      expect(
        fetchMock.mock.calls.some(([path]) =>
          /\/sessions\/session-main\/(messages|queue|events)$/.test(
            String(path),
          ),
        ),
      ).toBe(false);
    } finally {
      view.unmount();
    }
    expect(listeners.size).toBe(0);
    expect(resets.size).toBe(0);
  });
  it("binds main and native side-chat projections independently without changing standard current selection", async () => {
    window.history.replaceState({}, "", "/?session=session-main");
    localStorage.setItem("workagent.side-chat.session-main", "session-side");
    const main = {
      id: "session-main",
      title: "Main title",
      engine: "codex",
      activity: { state: "idle" },
    };
    const side = {
      id: "session-side",
      title: "Side title",
      engine: "codex",
      parentSessionId: main.id,
      branchKind: "side_chat",
      activity: { state: "idle" },
    };
    const prompt = vi.fn(async () => ({ ok: true, value: { accepted: true } }));
    const bindings = Object.fromEntries(
      [main, side].map((row) => [
        row.id,
        {
          session: {
            projections: {
              faceOf: () => ({
                getSnapshot: () => undefined,
                subscribe: () => () => {},
              }),
            },
            prompt: row.id === side.id ? prompt : vi.fn(),
          },
        },
      ]),
    );
    const history = vi.fn(async ({ sessionId }) => ({
      result: {
        ok: true,
        value: {
          events: [],
          hasMore: false,
          projections: {
            asOfSeq: 3,
            values: {
              nativeSession: {
                metadata: {
                  ...(sessionId === main.id ? main : side),
                  queue: [],
                },
                messages: [
                  {
                    id: sessionId + "-message",
                    role: "assistant",
                    text:
                      sessionId === main.id
                        ? "main canonical"
                        : "side canonical",
                  },
                ],
                activity: { state: "idle" },
                draft: "",
                progress: "",
              },
            },
          },
        },
      },
    }));
    const open = vi.fn();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async (path) =>
          new Response(
            JSON.stringify(
              String(path).endsWith("/sessions")
                ? [main, side]
                : String(path).endsWith("/session-main")
                  ? main
                  : String(path).endsWith("/session-side")
                    ? side
                    : [],
            ),
            { headers: { "content-type": "application/json" } },
          ),
      );
    const Component = compose(undefined, {
      sessions: {
        binding: (id) => bindings[id],
        open,
        list: { subscribe: () => () => {} },
      },
      connection: { api: { sessions: { history } } },
      on: () => () => {},
    }).find((entry) => entry.options.id === "workagent-page").Component;
    const view = render(<Component />);
    try {
      await screen.findByText("main canonical");
      await screen.findByText("side canonical");
      fireEvent.change(screen.getByLabelText("侧聊消息"), {
        target: { value: "side only" },
      });
      fireEvent.submit(screen.getByLabelText("侧聊消息").closest("form"));
      await waitFor(() =>
        expect(prompt).toHaveBeenCalledWith(
          [{ type: "text", text: "side only" }],
          "queue",
        ),
      );
      expect(bindings[main.id].session.prompt).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(
        fetchMock.mock.calls.some(([path]) =>
          /\/(messages|queue|events)$/.test(String(path)),
        ),
      ).toBe(false);
    } finally {
      view.unmount();
    }
  });
  function mountChat(
    active = false,
    busyEnter = "queue",
    queue = [],
    sideFixture,
  ) {
    window.history.replaceState({}, "", "/?session=session-main");
    const session = {
      id: "session-main",
      title: "Main",
      engine: "codex",
      activity: { state: active ? "running" : "idle" },
    };
    const messages = [
      { id: "m1", role: "user", text: "original text" },
      { id: "m2", role: "assistant", text: "agent reply" },
    ];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (path, init = {}) => {
        if (String(path).includes("/interactions?"))
          return new Response("[]", {
            headers: { "content-type": "application/json" },
          });
        if (String(path) === "/api/speech/capability")
          return new Response('{"enabled":false}', {
            headers: { "content-type": "application/json" },
          });
        const url = String(path);
        if (sideFixture && init.method === "DELETE") {
          if (sideFixture.failDelete)
            return new Response(
              JSON.stringify({ error: "session_close_failed" }),
              { status: 503, headers: { "content-type": "application/json" } },
            );
          sideFixture.rows = sideFixture.rows.filter(
            (row) => !url.endsWith(`/${row.id}`),
          );
          return new Response(null, { status: 204 });
        }
        if (
          sideFixture &&
          init.method === "POST" &&
          url.endsWith("/side-chat")
        ) {
          const fresh = {
            ...session,
            id: "side-new",
            title: "Fresh side",
            parentSessionId: session.id,
            branchKind: "side_chat",
          };
          sideFixture.rows.push(fresh);
          return new Response(JSON.stringify({ id: fresh.id }), {
            headers: { "content-type": "application/json" },
          });
        }
        const payload = url.endsWith("/queue")
          ? queue
          : url.endsWith("/sessions")
            ? (sideFixture?.rows ?? [])
            : url.endsWith("/messages")
              ? messages
              : (sideFixture?.rows.find((row) => url.endsWith(`/${row.id}`)) ??
                session);
        if (init.method === "POST")
          return new Response(JSON.stringify({ error: "test rejection" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          });
        return new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        });
      });
    const streams = [];
    const previous = globalThis.EventSource;
    globalThis.EventSource = class {
      constructor() {
        streams.push(this);
      }
      close() {}
    };
    const Component = compose({
      getSnapshot: () => ({ value: { preference: "zh", busyEnter } }),
      subscribe: () => () => {},
    }).find((entry) => entry.options.id === "workagent-page").Component;
    const view = render(<Component />);
    return {
      fetchMock,
      streams,
      done: () => {
        view.unmount();
        globalThis.EventSource = previous;
      },
    };
  }
  it("restores cached chat and draft before the network responds and ignores abandoned history", async () => {
    const f = mountChat();
    const originalFetch = f.fetchMock.getMockImplementation();
    let resolveHistory;
    let delayMain = false;
    const navigate = (id) => {
      const anchor = document.createElement("a");
      anchor.href = `/?session=${id}`;
      document.body.append(anchor);
      fireEvent.click(anchor);
      anchor.remove();
    };
    try {
      await screen.findByText("agent reply");
      fireEvent.change(screen.getByLabelText("继续对话"), {
        target: { value: "unsent main draft" },
      });
      f.fetchMock.mockImplementation((path, init) => {
        if (delayMain && String(path).includes("/sessions/session-main"))
          return new Promise(() => {});
        if (String(path).endsWith("/sessions/navigation-delayed/messages")) {
          return new Promise((resolve) => {
            resolveHistory = resolve;
          });
        }
        if (String(path).endsWith("/sessions/navigation-delayed"))
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "navigation-delayed",
                title: "Delayed chat",
                engine: "codex",
              }),
              { headers: { "content-type": "application/json" } },
            ),
          );
        return originalFetch(path, init);
      });
      navigate("navigation-delayed");
      await screen.findByText("Delayed chat");
      expect(screen.queryByText("agent reply")).toBeNull();
      expect(screen.getByLabelText("继续对话").value).toBe("");
      delayMain = true;
      navigate("session-main");
      expect(screen.getByText("agent reply")).toBeTruthy();
      expect(screen.getByLabelText("继续对话").value).toBe("unsent main draft");
      await act(async () =>
        resolveHistory(
          new Response(
            JSON.stringify([
              { id: "late", role: "assistant", text: "abandoned response" },
            ]),
            { headers: { "content-type": "application/json" } },
          ),
        ),
      );
      expect(screen.queryByText("abandoned response")).toBeNull();
      expect(screen.getByText("agent reply")).toBeTruthy();
    } finally {
      f.done();
    }
  });
  it("confirms side-chat deletion, preserves failures, and opens a fresh chat instead of old history", async () => {
    const key = "workagent.side-chat.session-main";
    localStorage.setItem(key, "side-old");
    const fixture = {
      failDelete: true,
      rows: [
        {
          id: "side-old",
          title: "Saved side",
          engine: "codex",
          activity: { state: "idle" },
          parentSessionId: "session-main",
          branchKind: "side_chat",
        },
        {
          id: "side-other",
          title: "Other side",
          engine: "codex",
          activity: { state: "idle" },
          parentSessionId: "session-main",
          branchKind: "side_chat",
        },
      ],
    };
    const f = mountChat(false, "queue", [], fixture);
    try {
      await screen.findByRole("combobox", { name: "选择侧聊" });
      fireEvent.click(screen.getByRole("button", { name: "删除侧聊" }));
      await screen.findByRole("alertdialog", { name: "确认删除侧聊" });
      expect(
        f.fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
      ).toBe(false);
      fireEvent.click(
        screen.getByRole("button", { name: "取消", exact: true }),
      );
      expect(screen.getByRole("combobox", { name: "选择侧聊" }).value).toBe(
        "side-old",
      );
      fireEvent.click(screen.getByRole("button", { name: "删除侧聊" }));
      fireEvent.click(
        screen.getByRole("button", { name: "确认删除", exact: true }),
      );
      await screen.findByRole("alert");
      expect(localStorage.getItem(key)).toBe("side-old");
      expect(screen.getByRole("combobox", { name: "选择侧聊" }).value).toBe(
        "side-old",
      );
      fixture.failDelete = false;
      fireEvent.click(
        screen.getByRole("button", { name: "确认删除", exact: true }),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("complementary", { name: "侧聊 BTW" }),
        ).toBeNull(),
      );
      expect(localStorage.getItem(key)).toBeNull();
      expect(fixture.rows.map((row) => row.id)).toEqual(["side-other"]);
      expect(screen.getByText("Main")).toBeTruthy();
      fireEvent.change(screen.getByLabelText("继续对话"), {
        target: { value: "/btw" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "发送", exact: true }),
      );
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "选择侧聊" }).value).toBe(
          "side-new",
        ),
      );
      expect(localStorage.getItem(key)).toBe("side-new");
      expect(
        f.fetchMock.mock.calls
          .filter(([, init]) => init?.method === "DELETE")
          .every(([path]) => path.endsWith("/side-old")),
      ).toBe(true);
    } finally {
      f.done();
    }
  });

  it("edits an earlier message and retains its draft on rejected resend", async () => {
    const f = mountChat();
    try {
      fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
      const editor = screen.getByLabelText("编辑消息");
      expect(editor.value).toBe("original text");
      fireEvent.change(editor, { target: { value: "corrected text" } });
      fireEvent.click(screen.getByRole("button", { name: "保存并重发" }));
      await waitFor(() =>
        expect(f.fetchMock).toHaveBeenCalledWith(
          "/api/runtime/v1/sessions/session-main/fork",
          expect.objectContaining({
            body: JSON.stringify({
              messageId: "m1",
              replacementContent: "corrected text",
            }),
          }),
        ),
      );
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(screen.getByLabelText("编辑消息").value).toBe("corrected text");
      fireEvent.click(screen.getByRole("button", { name: "取消编辑" }));
      expect(screen.queryByLabelText("编辑消息")).toBeNull();
    } finally {
      f.done();
    }
  });
  it("assigns edit to the author and branch to the reply, with copy on both", async () => {
    const f = mountChat();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("isSecureContext", true);
    const priorClipboard = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    try {
      await screen.findByText("agent reply");
      const user = document.querySelector('[data-message-id="m1"]');
      const assistant = document.querySelector('[data-message-id="m2"]');
      expect(user.querySelector('[aria-label="编辑"]')).toBeTruthy();
      expect(user.querySelector('[aria-label="分支"]')).toBeNull();
      expect(assistant.querySelector('[aria-label="编辑"]')).toBeNull();
      expect(assistant.querySelector('[aria-label="分支"]')).toBeTruthy();
      fireEvent.click(user.querySelector('[aria-label="复制"]'));
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith("original text"),
      );
      fireEvent.click(assistant.querySelector('[aria-label="复制"]'));
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith("agent reply"),
      );
      fireEvent.click(assistant.querySelector('[aria-label="分支"]'));
      await waitFor(() =>
        expect(f.fetchMock).toHaveBeenCalledWith(
          "/api/runtime/v1/sessions/session-main/fork",
          expect.objectContaining({
            body: JSON.stringify({ messageId: "m2" }),
          }),
        ),
      );
    } finally {
      f.done();
      if (priorClipboard)
        Object.defineProperty(navigator, "clipboard", priorClipboard);
      else delete navigator.clipboard;
      vi.unstubAllGlobals();
    }
  });
  it("confirms mobile branches before creating a conversation", async () => {
    const f = mountChat();
    window.matchMedia = vi.fn(() => ({ matches: true }));
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    try {
      await screen.findByText("agent reply");
      fireEvent.click(screen.getByRole("button", { name: "分支", exact: true }));
      await screen.findByText("从这里创建分支？");
      const forks = () => f.fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/fork"));
      expect(forks()).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "继续当前对话" }));
      expect(forks()).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "分支", exact: true }));
      fireEvent.click(screen.getByRole("button", { name: "创建分支", exact: true }));
      await waitFor(() => expect(forks()).toHaveLength(1));
    } finally { f.done(); }
  });
  it("sends input through steer while keeping the stop control available", async () => {
    const f = mountChat(true, "steer");
    try {
      await screen.findByText("Main");
      await act(async () => f.streams[0].onopen());
      fireEvent.change(screen.getByLabelText("继续对话"), {
        target: { value: "change direction" },
      });
      fireEvent.click(await screen.findByRole("button", { name: "发送" }));
      await waitFor(() =>
        expect(f.fetchMock).toHaveBeenCalledWith(
          "/api/runtime/v1/sessions/session-main/steer",
          expect.objectContaining({ method: "POST" }),
        ),
      );
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(screen.getByLabelText("继续对话").value).toBe("change direction");
      expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
    } finally {
      f.done();
    }
  });
  it.each(["queue", "steer"])(
    "uses saved %s mode for click and Enter, and reverses the chord",
    async (mode) => {
      const f = mountChat(true, mode);
      try {
        await screen.findByText("Main");
        await act(async () => f.streams[0].onopen());
        const input = screen.getByLabelText("继续对话");
        const send = screen.getByRole("button", { name: "发送" });
        expect(send.textContent).toBe("");
        expect(send.querySelector("svg")).toBeTruthy();
        expect(screen.getByRole("button", { name: "停止" }).textContent).toBe(
          "",
        );
        for (const gesture of ["click", "enter", "ctrl", "meta"]) {
          fireEvent.change(input, { target: { value: gesture } });
          if (gesture === "click") fireEvent.click(send);
          else
            fireEvent.keyDown(input, {
              key: "Enter",
              ctrlKey: gesture === "ctrl",
              metaKey: gesture === "meta",
            });
          const expected = ["ctrl", "meta"].includes(gesture)
            ? mode === "queue"
              ? "steer"
              : "queue"
            : mode;
          await waitFor(() =>
            expect(f.fetchMock).toHaveBeenCalledWith(
              `/api/runtime/v1/sessions/session-main/${expected}`,
              expect.objectContaining({
                body: expect.stringContaining(`"content":"${gesture}"`),
              }),
            ),
          );
          await waitFor(() => expect(send.disabled).toBe(false));
        }
      } finally {
        f.done();
      }
    },
  );
  it("keeps a queued message after rejected steering and offers removal", async () => {
    const f = mountChat(true, "queue", [
      { messageId: "q1", content: "queued direction" },
    ]);
    try {
      await screen.findByText("Main");
      await act(async () => f.streams[0].onopen());
      fireEvent.click(await screen.findByRole("button", { name: "立即追加" }));
      await waitFor(() =>
        expect(f.fetchMock).toHaveBeenCalledWith(
          "/api/runtime/v1/sessions/session-main/queue",
          expect.objectContaining({
            body: JSON.stringify({ messageId: "q1", action: "steer" }),
          }),
        ),
      );
      await screen.findByRole("alert");
      expect(screen.getByText("queued direction")).toBeTruthy();
      expect(screen.getByRole("button", { name: "移除排队消息" })).toBeTruthy();
    } finally {
      f.done();
    }
  });
  it("routes /btw to a separate conversation endpoint", async () => {
    const f = mountChat();
    try {
      await screen.findByText("Main");
      fireEvent.change(screen.getByLabelText("继续对话"), {
        target: { value: "/btw quick question" },
      });
      fireEvent.click(screen.getByRole("button", { name: "发送" }));
      await waitFor(() =>
        expect(f.fetchMock).toHaveBeenCalledWith(
          "/api/runtime/v1/sessions/session-main/side-chat",
          expect.objectContaining({ method: "POST" }),
        ),
      );
      expect(
        f.fetchMock.mock.calls.filter(
          ([path, init]) => path.endsWith("/turns") && init?.method === "POST",
        ),
      ).toHaveLength(0);
      expect(await screen.findByRole("alert")).toBeTruthy();
    } finally {
      f.done();
    }
  });
});

describe("model defaults settings", () => {
  const key = "workagent.model-defaults.v1";
  const model = (id, reasoning = ["high", "max", "low"]) => ({
    id,
    name: id,
    isDefault: false,
    defaultReasoning: "high",
    reasoning: reasoning.map((id) => ({ id })),
  });
  let groups;
  function setup(customPresets = []) {
    groups = [
      {
        engine: "codex",
        state: "ready",
        models: [
          { ...model("old-model"), isDefault: true },
          model("gpt-6-astra"),
          model("no-thinking", []),
        ],
      },
      {
        engine: "kimi",
        state: "ready",
        models: [
          model("kimi-code/kimi-k3"),
          model("kimi-legacy", ["off", "thinking"]),
        ],
      },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (path) =>
        new Response(
          JSON.stringify(
            String(path).endsWith("/model-options")
              ? groups
              : String(path).endsWith("/presets")
                ? [
                    {
                      id: "builtin-codex",
                      name: "Codex",
                      engine: "codex",
                      enabled: true,
                    },
                    {
                      id: "builtin-kimi",
                      name: "Kimi",
                      engine: "kimi",
                      enabled: true,
                    },
                    ...customPresets,
                  ]
                : [],
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    localStorage.setItem("workagent.hero.agent", "builtin-codex");
    const entries = compose();
    return {
      Settings: entries.find((entry) => entry.options.id === "workagent-models")
        .Component,
      General: entries.find((entry) => entry.options.id === "permission")
        .Component,
      Composer: entries.find(
        (entry) => entry.options.id === "workagent-workspace-composer",
      ).Component,
    };
  }
  const change = (label, value) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  const choice = (modelId, effort, permission = "workspace_write") =>
    waitFor(() => {
      expect(screen.getByLabelText("模型").value).toBe(modelId);
      expect(screen.getByLabelText("思考级别").value).toBe(effort);
      expect(screen.getByLabelText("权限").value).toBe(permission);
    });

  it("lists new assistants live and isolates same-engine defaults and draft choices", async () => {
    const presets = [
      {
        id: "writer",
        source: "user",
        name: "写作助手",
        engine: "codex",
        enabled: true,
        modelId: null,
      },
    ];
    const { Settings, Composer } = setup(presets);
    const settings = render(<Settings />);
    let composer = render(<Composer />);
    await screen.findByLabelText("写作助手 默认模型");
    change("写作助手 默认模型", "old-model");
    change("写作助手 默认思考强度", "max");
    change("写作助手 默认权限", "read_only");
    await choice("gpt-6-astra", "low");
    presets.push({
      id: "reviewer",
      source: "user",
      name: "审阅助手",
      engine: "codex",
      enabled: true,
      modelId: null,
    });
    act(() => window.dispatchEvent(new Event("workagent:presets-changed")));
    await screen.findByLabelText("审阅助手 默认模型");
    change("审阅助手 默认权限", "full_access");
    const choose = (id) =>
      act(() =>
        window.dispatchEvent(
          new CustomEvent("workagent:hero-agent", { detail: id }),
        ),
      );
    choose("writer");
    await choice("old-model", "max", "read_only");
    change("模型", "no-thinking");
    await choice("no-thinking", "", "read_only");
    choose("reviewer");
    await choice("gpt-6-astra", "low", "full_access");
    choose("builtin-codex");
    await choice("gpt-6-astra", "low");
    choose("writer");
    await choice("no-thinking", "", "read_only");
    composer.unmount();
    localStorage.setItem("workagent.hero.agent", "writer");
    composer = render(<Composer />);
    await choice("old-model", "max", "read_only");
    settings.unmount();
    render(<Settings />);
    expect((await screen.findByLabelText("写作助手 默认模型")).value).toBe(
      "old-model",
    );
    expect(screen.getByLabelText("审阅助手 默认权限").value).toBe(
      "full_access",
    );
  });

  it("preserves legacy assistant models and does not carry defaults across engine changes", async () => {
    const preset = {
      id: "writer",
      source: "user",
      name: "写作助手",
      engine: "codex",
      enabled: true,
      modelId: "old-model",
    };
    const { Settings, Composer } = setup([preset]);
    render(<Settings />);
    localStorage.setItem("workagent.hero.agent", "writer");
    render(<Composer />);
    await choice("old-model", "low");
    change("写作助手 默认思考强度", "max");
    change("写作助手 默认权限", "full_access");
    await choice("old-model", "max", "full_access");
    preset.engine = "kimi";
    preset.modelId = null;
    act(() => window.dispatchEvent(new Event("workagent:presets-changed")));
    await choice("kimi-code/kimi-k3", "low");
    await waitFor(() =>
      expect(screen.getByLabelText("写作助手 默认模型").value).toBe(
        "kimi-code/kimi-k3",
      ),
    );
    expect(screen.getByLabelText("写作助手 默认权限").value).toBe(
      "workspace_write",
    );
  });

  it("uses GPT-6 low and K3 lowest even when upstream and legacy selections are high", async () => {
    const { Settings, Composer } = setup();
    localStorage.setItem("workagent.hero.model.codex", "old-model");
    localStorage.setItem("workagent.hero.effort.codex.gpt-6-astra", "high");
    render(
      <>
        <Settings />
        <Composer />
      </>,
    );
    await choice("gpt-6-astra", "low");
    expect(screen.getByLabelText("Codex 默认模型").value).toBe("gpt-6-astra");
    expect(screen.getByLabelText("Kimi 默认思考强度").value).toBe("low");
    expect(
      screen.getByLabelText("Kimi 默认思考强度").selectedOptions[0].textContent,
    ).toBe("低");
    window.dispatchEvent(
      new CustomEvent("workagent:hero-agent", { detail: "builtin-kimi" }),
    );
    await choice("kimi-code/kimi-k3", "low");
  });

  it("saves all three defaults, updates the composer and restores them after draft changes and reopening", async () => {
    const { Settings, Composer } = setup();
    const settings = render(<Settings />);
    let composer = render(<Composer />);
    await choice("gpt-6-astra", "low");
    change("Codex 默认模型", "old-model");
    change("Codex 默认思考强度", "max");
    change("Codex 默认权限", "full_access");
    await choice("old-model", "max", "full_access");
    expect(
      screen.getByLabelText("Codex 默认权限").selectedOptions[0].textContent,
    ).toBe("完全访问");
    expect(screen.getByLabelText("Kimi 默认权限").value).toBe(
      "workspace_write",
    );
    const saved = localStorage.getItem(key);
    change("模型", "gpt-6-astra");
    change("思考级别", "high");
    change("权限", "read_only");
    await choice("gpt-6-astra", "high", "read_only");
    expect(localStorage.getItem(key)).toBe(saved);
    composer.unmount();
    composer = render(<Composer />);
    await choice("old-model", "max", "full_access");
    settings.unmount();
    render(<Settings />);
    await waitFor(() =>
      expect(screen.getByLabelText("Codex 默认思考强度").value).toBe("max"),
    );
  });

  it("resets effort when changing the default model to one without thinking", async () => {
    const { Settings, Composer } = setup();
    render(
      <>
        <Settings />
        <Composer />
      </>,
    );
    await choice("gpt-6-astra", "low");
    change("Codex 默认模型", "no-thinking");
    await choice("no-thinking", "");
    expect(screen.getByLabelText("Codex 默认思考强度").disabled).toBe(true);
  });

  it("preserves configured defaults while discovery is unavailable and validates retired options", async () => {
    const { Settings, Composer } = setup();
    localStorage.setItem(
      key,
      JSON.stringify({
        codex: {
          modelId: "old-model",
          thinkingEffort: "max",
          permissionMode: "read_only",
        },
      }),
    );
    const models = groups[0].models;
    groups[0] = { engine: "codex", state: "unavailable", models: [] };
    const view = render(<Settings />);
    await waitFor(() =>
      expect(screen.getByLabelText("Codex 默认模型").disabled).toBe(true),
    );
    change("Codex 默认权限", "full_access");
    expect(JSON.parse(localStorage.getItem(key)).codex).toEqual({
      modelId: "old-model",
      thinkingEffort: "max",
      permissionMode: "full_access",
    });
    view.unmount();
    groups[0] = { engine: "codex", state: "ready", models };
    const composer = render(<Composer />);
    await choice("old-model", "max", "full_access");
    composer.unmount();
    groups[0].models = models.filter((model) => model.id !== "old-model");
    render(<Composer />);
    await choice("gpt-6-astra", "low", "full_access");
  });

  it("reacts to defaults changed in another tab and ignores corrupt preferences", async () => {
    const { Composer } = setup();
    localStorage.setItem(key, "{broken");
    render(<Composer />);
    await choice("gpt-6-astra", "low");
    localStorage.setItem(
      key,
      JSON.stringify({
        codex: {
          modelId: "old-model",
          thinkingEffort: "max",
          permissionMode: "read_only",
        },
      }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key }));
    await choice("old-model", "max", "read_only");
  });

  it("keeps permissions in Models and applies them to new conversations", async () => {
    const { General, Settings, Composer } = setup();
    const general = render(<General />);
    expect(screen.queryByLabelText("Codex 默认权限")).toBeNull();
    general.unmount();
    const settings = render(<Settings />);
    const composer = render(<Composer />);
    await choice("gpt-6-astra", "low");
    change("Codex 默认权限", "full_access");
    await choice("gpt-6-astra", "low", "full_access");
    await waitFor(() =>
      expect(screen.getByLabelText("Codex 默认权限").value).toBe("full_access"),
    );
    change("Codex 默认权限", "read_only");
    settings.unmount();
    render(<General />);
    expect(screen.queryByLabelText("Codex 默认权限")).toBeNull();
    await choice("gpt-6-astra", "low", "read_only");
  });

  it("localizes Full Access in upstream settings controls", async () => {
    setup();
    const button = document.createElement("button");
    button.textContent = "Full Access";
    document.body.append(button);
    await waitFor(() => expect(button.textContent).toBe("完全访问"));
  });
});
