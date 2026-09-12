// @vitest-environment jsdom
import React from "react";
import * as primitives from "@deepseek-ai/dsh-client-ui-primitives";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWorkbench } from "./workbench.js";
import { createUploadBatch } from "../files/uploads.js";

const request = vi.fn();
const nativeSessionAction = vi.fn();
const uploadFile = vi.fn();
const features = createWorkbench({
  React,
  primitives,
  request,
  nativeSessionAction,
  uploadFiles: createUploadBatch(uploadFile, (value) => value),
  apiRoot: "/api/runtime/v1",
  fileURL: (id, path) =>
    `/api/runtime/v1/workspaces/${id}/content?path=${encodeURIComponent(path)}`,
});
beforeEach(() => {
  const values = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      clear: () => values.clear(),
    },
  });
  sessionStorage.clear();
  request.mockReset();
  nativeSessionAction.mockReset();
  uploadFile.mockReset();
  uploadFile.mockImplementation(async (_id, path) => path);
  request.mockResolvedValue([]);
});
it("keeps native session approval scopes as separate options", async () => {
  nativeSessionAction.mockResolvedValue({
    current: { provider: "acp", model: "default" },
    groups: [],
  });
  request.mockImplementation(async (path) =>
    path.includes("interactions?")
      ? [
          {
            id: "choice",
            choices: [
              {
                id: "once",
                label: "允许本次",
                outcome: "allow",
                scope: "once",
              },
              {
                id: "session",
                label: "在本会话允许",
                outcome: "allow",
                scope: "session",
              },
            ],
          },
        ]
      : { permissionMode: "manual_approval" },
  );
  render(
    <features.Controls
      ctx={{ sessions: { binding() {} } }}
      session={{ id: "s", engine: "acp" }}
      busy={false}
      cancel={() => {}}
    />,
  );
  const button = await screen.findByRole("button", { name: "在本会话允许" });
  expect(screen.getByRole("button", { name: "允许本次" })).toBeTruthy();
  fireEvent.click(button);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "/api/runtime/v1/interactions/choice/respond",
      expect.objectContaining({
        body: '{"sessionId":"s","optionId":"session"}',
      }),
    ),
  );
});

it("loads native command metadata and inserts the exact slash command", async () => {
  const setInput = vi.fn();
  request.mockImplementation(async (path) =>
    path.endsWith("/commands")
      ? {
          supported: true,
          revision: 1,
          items: [{ id: "review", description: "Review project" }],
        }
      : [],
  );
  render(
    <features.ComposerTools
      session={{ id: "s", workspaceId: "one" }}
      input="/rev"
      setInput={setInput}
      onError={() => {}}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /review.*Review project/ }),
  );
  expect(setInput.mock.calls.at(-1)[0]("/rev")).toBe("/review ");
});

it("continues recursive mention search through empty pages and cancels a superseded query", async () => {
  const setInput = vi.fn();
  const requests = [];
  request.mockImplementation(async (path, options) => {
    if (!path.includes("/search?")) return [];
    requests.push({ path, signal: options.signal });
    if (path.includes("cursor=next"))
      return {
        items: [
          {
            kind: "file",
            name: "report.txt",
            path: "deep/area/report.txt",
            fileId: "stable-file",
          },
        ],
        nextCursor: null,
      };
    return { items: [], nextCursor: "next" };
  });
  const view = render(
    <features.ComposerTools
      session={{ id: "s", workspaceId: "one" }}
      input="@report"
      setInput={setInput}
      onError={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "继续搜索" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /deep\/area\/report.txt/ }),
  );
  expect(setInput.mock.calls.at(-1)[0]("@report")).toContain("stable-file");
  view.rerender(
    <features.ComposerTools
      session={{ id: "s", workspaceId: "one" }}
      input="@other"
      setInput={setInput}
      onError={() => {}}
    />,
  );
  await waitFor(() =>
    expect(requests.some((row) => row.path.includes("q=other"))).toBe(true),
  );
  expect(requests[0].signal.aborted).toBe(true);
});
it("releases abandoned mention cursors, including a late page from the previous workspace", async () => {
  let finishPage;
  request.mockImplementation(async (path, options = {}) => {
    if (options.method === "DELETE") return {};
    if (path.includes("cursor=first"))
      return new Promise((resolve) => {
        finishPage = resolve;
      });
    return {
      items: [],
      nextCursor: path.includes("/one/") ? "first" : "second",
    };
  });
  const props = { input: "@report", setInput() {}, onError() {} };
  const view = render(
    <features.ComposerTools
      {...props}
      session={{ id: "s", workspaceId: "one" }}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "继续搜索" }));
  await waitFor(() => expect(finishPage).toBeTypeOf("function"));
  view.rerender(
    <features.ComposerTools
      {...props}
      session={{ id: "s", workspaceId: "two" }}
    />,
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "/api/runtime/v1/workspaces/one/search?cursor=first",
      { method: "DELETE" },
    ),
  );
  finishPage({ items: [], nextCursor: "late-page" });
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "/api/runtime/v1/workspaces/one/search?cursor=late-page",
      { method: "DELETE" },
    ),
  );
  view.unmount();
  expect(request).toHaveBeenCalledWith(
    "/api/runtime/v1/workspaces/two/search?cursor=second",
    { method: "DELETE" },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shows sent references as preview links with Chinese names, spaces and collision suffixes", async () => {
  const ref = {
    workspaceId: "one",
    path: "资料/三七互娱 (1).docx",
    name: "三七互娱 (1).docx",
  };
  request.mockResolvedValue({ path: ref.path, name: ref.name, kind: "file" });
  const opened = vi.fn();
  window.addEventListener("workagent:file-open", opened);
  render(
    <features.Markdown workspaceId="one">{`请分析 项目文件：${JSON.stringify(ref)}`}</features.Markdown>,
  );
  const link = screen.getByRole("link", { name: "📄 三七互娱 (1).docx" });
  expect(link.title).toBe(ref.path);
  expect(document.body.textContent).not.toContain("项目文件：");
  fireEvent.click(link);
  await waitFor(() => expect(opened).toHaveBeenCalled());
  expect(request).toHaveBeenCalledWith(
    expect.stringContaining(encodeURIComponent(ref.path)),
  );
  window.removeEventListener("workagent:file-open", opened);
});

it("opens an authenticated project file at a Markdown line anchor", async () => {
  request.mockResolvedValue({
    path: "src/main.ts",
    name: "main.ts",
    kind: "file",
  });
  const opened = vi.fn();
  window.addEventListener("workagent:file-open", opened);
  render(
    <features.Markdown workspaceId="project">
      {"[源文件](src/main.ts#L12)"}
    </features.Markdown>,
  );
  fireEvent.click(screen.getByRole("link", { name: "源文件" }));
  await waitFor(() => expect(opened).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledWith(
    "/api/runtime/v1/workspaces/project/locate?path=src%2Fmain.ts&reference=1",
  );
  expect(opened.mock.calls[0][0].detail.entry.line).toBe(12);
  window.removeEventListener("workagent:file-open", opened);
});

const projectFileEndpoint = (workspaceId) =>
  workspaceId.startsWith("shared:")
    ? `/api/portal/shared-workspaces/${encodeURIComponent(workspaceId.slice(7))}`
    : `/api/runtime/v1/workspaces/${encodeURIComponent(workspaceId)}`;
const sharedFeatures = createWorkbench({
  React,
  primitives,
  request,
  apiRoot: "/api/runtime/v1",
  workspaceEndpoint: projectFileEndpoint,
  fileURL: (workspaceId, path, _preview, fileId) =>
    `${projectFileEndpoint(workspaceId)}/content?path=${encodeURIComponent(path)}${fileId ? `&fileId=${encodeURIComponent(fileId)}` : ""}`,
});

it.each([
  [undefined, "shared:current"],
  ["shared:current", "shared:current"],
  ["shared:other", "shared:other"],
  ["personal", "personal"],
])(
  "locates a file reference from a shared task through its authenticated workspace endpoint: %s",
  async (explicitWorkspace, selectedWorkspace) => {
    const reference = {
      path: "资料/报告 (1).docx",
      name: "报告 (1).docx",
      fileId: "file-one",
      ...(explicitWorkspace ? { workspaceId: explicitWorkspace } : {}),
    };
    const entry = { path: reference.path, name: reference.name, kind: "file" };
    request.mockResolvedValue(entry);
    const opened = vi.fn();
    window.addEventListener("workagent:file-open", opened);
    try {
      render(
        <sharedFeatures.Markdown workspaceId="shared:current">
          {`项目文件：${JSON.stringify(reference)}`}
        </sharedFeatures.Markdown>,
      );
      fireEvent.click(screen.getByRole("link", { name: "📄 报告 (1).docx" }));
      await waitFor(() => expect(opened).toHaveBeenCalledOnce());
      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(
        `${projectFileEndpoint(selectedWorkspace)}/locate?path=${encodeURIComponent(reference.path)}&reference=1&fileId=file-one`,
      );
      expect(opened.mock.calls[0][0].detail).toEqual({
        workspaceId: selectedWorkspace,
        entry,
      });
    } finally {
      window.removeEventListener("workagent:file-open", opened);
    }
  },
);

it("opens shared relative Markdown links at their requested line", async () => {
  const entry = { path: "src/main.ts", name: "main.ts", kind: "file" };
  request.mockResolvedValue(entry);
  const opened = vi.fn();
  window.addEventListener("workagent:file-open", opened);
  try {
    render(
      <sharedFeatures.Markdown workspaceId="shared:current">
        {"[源文件](src/main.ts#L12)"}
      </sharedFeatures.Markdown>,
    );
    fireEvent.click(screen.getByRole("link", { name: "源文件" }));
    await waitFor(() => expect(opened).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith(
      "/api/portal/shared-workspaces/current/locate?path=src%2Fmain.ts&reference=1",
    );
    expect(opened.mock.calls[0][0].detail).toEqual({
      workspaceId: "shared:current",
      entry: { ...entry, line: 12 },
    });
  } finally {
    window.removeEventListener("workagent:file-open", opened);
  }
});

it("notifies once for completion without replaying old results", async () => {
  const notices = [];
  class Notice {
    static permission = "granted";
    static async requestPermission() {
      return "granted";
    }
    constructor(title, options) {
      notices.push({ title, options });
    }
    close() {}
  }
  vi.stubGlobal("Notification", Notice);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  const view = render(
    <features.Notifications
      sessions={[
        {
          id: "one",
          title: "first",
          lastTurn: { id: "old", status: "completed" },
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "开启桌面提醒" }));
  await screen.findByRole("button", { name: "关闭桌面提醒" });
  expect(notices).toHaveLength(0);
  const sessions = [
    { id: "one", title: "first", lastTurn: { id: "new", status: "completed" } },
  ];
  view.rerender(<features.Notifications sessions={sessions} />);
  expect(notices).toHaveLength(1);
  view.rerender(<features.Notifications sessions={[...sessions]} />);
  expect(notices).toHaveLength(1);
});

it("deduplicates pending approvals across notification remounts", async () => {
  const notices = [];
  class Notice {
    static permission = "granted";
    static async requestPermission() {
      return "granted";
    }
    constructor(title) {
      notices.push(title);
    }
    close() {}
  }
  vi.stubGlobal("Notification", Notice);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  localStorage.setItem("workagent.browser-notifications", "true");
  request.mockResolvedValue([
    { id: "approval-one", sessionId: "one", summary: "Approve tool" },
  ]);
  const first = render(
    <features.Notifications sessions={[]} settings={false} />,
  );
  await waitFor(() => expect(notices).toEqual(["WorkAgent · 等待确认"]));
  first.unmount();
  render(<features.Notifications sessions={[]} settings={false} />);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(notices).toHaveLength(1);
});

it("transcribes through the managed speech endpoint and stops microphone tracks", async () => {
  request.mockResolvedValue({ enabled: true, maxStreamSeconds: 60 });
  const stop = vi.fn();
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [{ stop }] }),
    },
  });
  class Recorder {
    state = "inactive";
    mimeType = "audio/webm";
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable({ data: new Blob(["audio"]) });
      void this.onstop();
    }
  }
  vi.stubGlobal("MediaRecorder", Recorder);
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ success: true, data: { text: "转写结果" } }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const set = vi.fn();
  render(
    <form>
      <features.ComposerTools
        session={{ id: "one", workspaceId: "project" }}
        input=""
        setInput={set}
        onError={() => {}}
      />
    </form>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "语音输入" }));
  fireEvent.click(await screen.findByRole("button", { name: "停止并转写" }));
  await waitFor(() => expect(set).toHaveBeenCalled());
  expect(fetch).toHaveBeenCalledWith(
    "/api/stt",
    expect.objectContaining({
      credentials: "same-origin",
      method: "POST",
      body: expect.any(FormData),
    }),
  );
  expect(set.mock.calls[0][0]("已有草稿")).toBe("已有草稿\n转写结果");
  expect(stop).toHaveBeenCalled();
});

it("uses real official GFM, math and safe workspace image/link rendering", () => {
  render(
    <features.Markdown workspaceId="project">
      {
        "| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] ready\n\n~~old~~ and $x^2$\n\n![result](image.png)\n\n[report](report.pdf)\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))"
      }
    </features.Markdown>,
  );
  expect(screen.getByRole("table")).toBeTruthy();
  expect(screen.getByRole("checkbox").checked).toBe(true);
  expect(document.querySelector(".katex")).toBeTruthy();
  expect(screen.getByRole("img").src).toContain(
    "/workspaces/project/content?path=image.png",
  );
  expect(screen.getByRole("link", { name: "report" }).href).toContain(
    "path=report.pdf",
  );
  expect(document.querySelector("script")).toBeNull();
  expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(features.workspaceDestination("../other.txt", "project")).toBeNull();
  expect(features.workspaceDestination("C:/secret.txt", "project")).toBeNull();
});

it("keeps file-link examples inside inline and fenced code literal", () => {
  render(
    <features.Markdown workspaceId="one">
      {"`[example](file.txt)`\n\n```markdown\n[example](file.txt)\n```"}
    </features.Markdown>,
  );
  expect(screen.getAllByText("[example](file.txt)").length).toBeGreaterThan(0);
  expect(
    document.querySelector(".workagent-markdown").textContent,
  ).not.toContain("/api/runtime/");
});

it("isolates and restores main/side drafts, including functional inserts", () => {
  function Draft({ id }) {
    const [text, set] = features.useDraft(id);
    return (
      <input
        aria-label={id}
        value={text}
        onChange={(event) => set(event.target.value)}
      />
    );
  }
  const view = render(
    <>
      <Draft id="main" />
      <Draft id="side" />
    </>,
  );
  fireEvent.change(screen.getByLabelText("main"), {
    target: { value: "main draft" },
  });
  fireEvent.change(screen.getByLabelText("side"), {
    target: { value: "side draft" },
  });
  view.unmount();
  render(
    <>
      <Draft id="main" />
      <Draft id="side" />
    </>,
  );
  expect(screen.getByLabelText("main").value).toBe("main draft");
  expect(screen.getByLabelText("side").value).toBe("side draft");
});

it("does not reveal saved drafts before session authorization and clears only drafts on logout", () => {
  sessionStorage.setItem(
    "workagent.draft.other",
    JSON.stringify("private draft"),
  );
  sessionStorage.setItem("unrelated-setting", "keep");
  function Draft({ authorized }) {
    const [text] = features.useDraft("other", authorized);
    return <output>{text}</output>;
  }
  const view = render(<Draft authorized={false} />);
  expect(screen.getByRole("status").textContent).toBe("");
  view.rerender(<Draft authorized={true} />);
  expect(screen.getByRole("status").textContent).toBe("private draft");
  view.rerender(<Draft authorized={false} />);
  expect(screen.getByRole("status").textContent).toBe("");
  features.clearDrafts();
  expect(sessionStorage.getItem("workagent.draft.other")).toBeNull();
  expect(sessionStorage.getItem("unrelated-setting")).toBe("keep");
});

it("keeps the original edit base after background refresh and retains failed edits", async () => {
  request.mockRejectedValue(new Error("file_changed"));
  const saved = vi.fn();
  const view = render(
    <features.TextEditor
      workspaceId="one"
      path="file.txt"
      original="before"
      onSaved={saved}
      onCancel={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("编辑文件内容"), {
    target: { value: "my edit" },
  });
  view.rerender(
    <features.TextEditor
      workspaceId="one"
      path="file.txt"
      original="agent edit"
      onSaved={saved}
      onCancel={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "保存文件" }));
  await screen.findByText("file_changed");
  expect(
    JSON.parse(
      request.mock.calls.find((call) => call[1]?.method === "PATCH")[1].body,
    ),
  ).toEqual({
    original: "before",
    text: "my edit",
  });
  expect(screen.getByLabelText("编辑文件内容").value).toBe("my edit");
  expect(saved).not.toHaveBeenCalled();
});

it("restores file drafts with their original conflict base and clears them on successful save", async () => {
  const saved = vi.fn();
  const props = {
    workspaceId: "one",
    path: "code.js",
    original: "before",
    onSaved: saved,
    onCancel: () => {},
  };
  const first = render(<features.TextEditor {...props} />);
  fireEvent.change(screen.getByLabelText("编辑文件内容"), {
    target: { value: "my draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "查看修改对比" }));
  expect(screen.getByLabelText("编辑文件内容").hidden).toBe(true);
  first.unmount();
  const second = render(
    <features.TextEditor {...props} original="external change" />,
  );
  expect(screen.getByLabelText("编辑文件内容").value).toBe("my draft");
  fireEvent.click(screen.getByRole("button", { name: "保存文件" }));
  await waitFor(() => expect(saved).toHaveBeenCalledWith("my draft"));
  expect(
    JSON.parse(
      request.mock.calls.find((call) => call[1]?.method === "PATCH")[1].body,
    ),
  ).toEqual({
    original: "before",
    text: "my draft",
  });
  expect(sessionStorage.getItem("workagent.file-draft.one.code.js")).toBeNull();
  second.unmount();
});

it("selects native model/effort and responds to the pending approval belonging to this session", async () => {
  const catalog = {
    current: { provider: "kimi", model: "k3" },
    groups: [
      {
        id: "kimi",
        name: "Kimi",
        models: [
          {
            id: "k3",
            name: "K3",
            reasoning: {
              defaultEffort: "low",
              efforts: [
                { id: "low", name: "Low" },
                { id: "high", name: "High" },
              ],
            },
          },
        ],
      },
    ],
  };
  nativeSessionAction.mockResolvedValue(catalog);
  request.mockImplementation(async (path) =>
    path.includes("interactions?")
      ? [{ id: "approval-one", summary: "Read project", tool: "Read" }]
      : { accepted: true },
  );
  render(
    <features.Controls
      ctx={{ sessions: { binding() {} } }}
      session={{ id: "main", permissionMode: "read_only" }}
      busy={false}
      cancel={() => {}}
    />,
  );
  expect((await screen.findByLabelText("当前会话思考强度")).value).toBe("low");
  expect(screen.getByRole("group", { name: "思考强度" })).toBeTruthy();
  expect(screen.getByRole("group", { name: "权限" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /默认/ })).toBeNull();
  fireEvent.change(screen.getByLabelText("当前会话思考强度"), {
    target: { value: "high" },
  });
  await waitFor(() =>
    expect(nativeSessionAction).toHaveBeenCalledWith(
      expect.anything(),
      "main",
      "selectModel",
      { provider: "kimi", model: "k3", reasoningEffort: "high" },
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "拒绝" }).disabled).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "/api/runtime/v1/interactions/approval-one/respond",
      expect.objectContaining({
        body: '{"sessionId":"main","decision":"reject"}',
      }),
    ),
  );
});

it.each(["full_access", "manual_approval"])(
  "reads an old session's %s permission without changing its configuration",
  async (permissionMode) => {
    nativeSessionAction.mockResolvedValue({
      current: { provider: "kimi", model: "k3" },
      groups: [],
    });
    request.mockImplementation(async (path) =>
      path.endsWith("/configuration") ? { permissionMode } : [],
    );
    render(
      <features.Controls
        ctx={{ sessions: { binding() {} } }}
        session={{ id: "old", engine: "kimi" }}
        busy={false}
        cancel={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("当前会话权限").value).toBe(permissionMode),
    );
    expect(request).toHaveBeenCalledWith(
      "/api/runtime/v1/sessions/old/configuration",
    );
    expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(
      true,
    );
  },
);

it("uploads into the selected project without overwriting and only inserts after success", async () => {
  const set = vi.fn();
  request.mockResolvedValue({ enabled: false });
  render(
    <form>
      <features.ComposerTools
        session={{ id: "main", workspaceId: "one" }}
        input=""
        setInput={set}
        onError={() => {}}
        disabled={false}
      />
    </form>,
  );
  fireEvent.change(screen.getByLabelText("选择会话附件"), {
    target: { files: [new File(["hello"], "报告.txt")] },
  });
  await waitFor(() => expect(set).toHaveBeenCalled());
  const call = uploadFile.mock.calls[0];
  expect(call[0]).toBe("one");
  expect(call[1]).toBe("报告.txt");
  expect(call[3].conflict).toBe("rename");
  expect(call[2].name).toBe("报告.txt");
  expect(set.mock.calls[0][0]("draft")).toContain(
    'draft 项目文件：{"workspaceId":"one"',
  );
});

it("persists pins and their explicit ordering", () => {
  function Pins() {
    const state = features.usePins();
    return (
      <>
        <output>{state.pins.join(",")}</output>
        <button onClick={() => state.toggle("one")}>one</button>
        <button onClick={() => state.toggle("two")}>two</button>
        <button onClick={() => state.move("two", "one")}>move</button>
      </>
    );
  }
  render(<Pins />);
  fireEvent.click(screen.getByText("one"));
  fireEvent.click(screen.getByText("two"));
  fireEvent.click(screen.getByText("move"));
  expect(screen.getByRole("status").textContent).toBe("two,one");
});

it("routes ordinary document drags before the image overlay and isolates side-chat drops", async () => {
  request.mockResolvedValue({ enabled: false });
  const main = vi.fn(),
    side = vi.fn();
  const upstream = vi.fn();
  document.addEventListener("dragenter", upstream);
  document.addEventListener("dragover", upstream);
  document.addEventListener("drop", upstream);
  try {
    render(
      <>
        <form data-testid="main-form">
          <features.ComposerTools
            session={{ id: "main", workspaceId: "one" }}
            input=""
            setInput={main}
            onError={() => {}}
            disabled={false}
          />
        </form>
        <form data-testid="side-form">
          <features.ComposerTools
            session={{ id: "side", workspaceId: "two" }}
            input=""
            setInput={side}
            onError={() => {}}
            disabled={false}
          />
        </form>
      </>,
    );
    const dataTransfer = {
      types: ["Files"],
      files: [
        new File(["print(1)"], "脚本.py", { type: "" }),
        new File(["doc"], "报告.docx"),
      ],
      dropEffect: "none",
    };
    fireEvent.dragEnter(document.body, { dataTransfer });
    fireEvent.dragOver(document.body, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("copy");
    fireEvent.drop(screen.getByTestId("side-form"), { dataTransfer });
    await waitFor(() => expect(side).toHaveBeenCalledTimes(2));
    expect(main).not.toHaveBeenCalled();
    expect(uploadFile.mock.calls.every((call) => call[0] === "two")).toBe(true);
    expect(upstream).not.toHaveBeenCalled();
    fireEvent.drop(document.body, {
      dataTransfer: {
        ...dataTransfer,
        files: [new File(["img"], "图片.png", { type: "image/png" })],
      },
    });
    await waitFor(() => expect(main).toHaveBeenCalledTimes(1));
    expect(uploadFile.mock.calls[2][0]).toBe("one");
  } finally {
    document.removeEventListener("dragenter", upstream);
    document.removeEventListener("dragover", upstream);
    document.removeEventListener("drop", upstream);
  }
});

it("uses the shared upload service for attachment size validation", async () => {
  const { createUploads } = await import("../files/uploads.js");
  const set = vi.fn(),
    onError = vi.fn();
  const uploadRequest = vi.fn(async (_url, init = {}) => {
    if (init.body) {
      const row = JSON.parse(init.body);
      return { ...row, id: "boundary", offset: row.size };
    }
    return [];
  });
  const composer = createWorkbench({
    React,
    primitives,
    request,
    apiRoot: "/api",
    uploadFiles: createUploads({
      React,
      request: uploadRequest,
      apiRoot: "/api",
      friendlyError: (value) => value,
    }).uploadFiles,
  });
  render(
    <form>
      <composer.ComposerTools
        session={{ id: "main", workspaceId: "one" }}
        input=""
        setInput={set}
        onError={onError}
        disabled={false}
      />
    </form>,
  );
  const file = new File([], "large.bin");
  Object.defineProperty(file, "size", { value: 5368709120 });
  fireEvent.change(screen.getByLabelText("选择会话附件"), {
    target: { files: [file] },
  });
  await waitFor(() => expect(set).toHaveBeenCalledOnce());
  const oversized = new File([], "oversized.bin");
  Object.defineProperty(oversized, "size", { value: 5368709121 });
  fireEvent.change(screen.getByLabelText("选择会话附件"), {
    target: { files: [oversized] },
  });
  await waitFor(() =>
    expect(onError).toHaveBeenLastCalledWith("oversized.bin：超过 5 GB"),
  );
  expect(
    uploadRequest.mock.calls.filter(([, init]) => init?.body),
  ).toHaveLength(1);
  expect(set).toHaveBeenCalledOnce();
});
