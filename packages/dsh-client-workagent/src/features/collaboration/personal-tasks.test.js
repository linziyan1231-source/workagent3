// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { request } from "../../platform/api.js";
import {
  createPersonalTask,
  deletePersonalTask,
  personalTaskRoute,
  sharedTaskProject,
} from "./personal-tasks.js";
vi.mock("../../platform/api.js", () => ({ request: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const project = { id: "shared-project" };
const options = {
  title: "整理项目资料",
  engine: "kimi",
  presetId: "research-agent",
  modelId: "kimi-selected",
  thinkingEffort: "high",
  permissionMode: "workspace_write",
};
const session = { id: "session-1", workspaceId: "shared:shared-project" };
it("submits one server operation and shares the result between simultaneous clicks", async () => {
  request.mockResolvedValue({ operation: { state: "ready" }, session });
  const a = createPersonalTask(project, options);
  const b = createPersonalTask(project, options);
  expect(a).toBe(b);
  await expect(a).resolves.toEqual(session);
  expect(request).toHaveBeenCalledOnce();
  const [path, init] = request.mock.calls[0];
  expect(path).toBe("/api/portal/shared-personal-tasks");
  expect(JSON.parse(init.body)).toEqual({
    project_id: project.id,
    operation_id: expect.any(String),
    options,
  });
});
it("reuses its persisted operation ID after a lost response and never guesses that the runtime should be removed", async () => {
  request.mockRejectedValueOnce(new Error("network lost"));
  await expect(createPersonalTask(project, options)).rejects.toThrow(
    "network lost",
  );
  const first = JSON.parse(request.mock.calls[0][1].body);
  request.mockResolvedValueOnce({ operation: { state: "ready" }, session });
  await expect(createPersonalTask(project, options)).resolves.toEqual(session);
  expect(JSON.parse(request.mock.calls[1][1].body).operation_id).toBe(
    first.operation_id,
  );
  expect(
    request.mock.calls.every(
      ([path, init]) =>
        path === "/api/portal/shared-personal-tasks" && init.method === "POST",
    ),
  ).toBe(true);
});
it("queries durable progress without resubmitting creation", async () => {
  vi.useFakeTimers();
  request
    .mockResolvedValueOnce({ operation: { id: "op/one", state: "creating" } })
    .mockResolvedValueOnce({ operation: { state: "ready" }, session });
  const promise = createPersonalTask(project, options);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(promise).resolves.toEqual(session);
  expect(request).toHaveBeenNthCalledWith(
    2,
    "/api/portal/shared-personal-tasks?id=op%2Fone",
  );
  expect(
    request.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
});
it("submits a durable deletion and leaves offline cleanup to the server", async () => {
  request.mockResolvedValueOnce({ operation: { state: "deleting" } });
  await deletePersonalTask("row-1");
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith("/api/portal/shared-personal-tasks", {
    method: "DELETE",
    body: JSON.stringify({ conversation_id: "row-1" }),
  });
});

it("keeps distinct pending configurations independent when their responses finish out of order", async () => {
  let completeFirst;
  let failSecond;
  request
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeFirst = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failSecond = reject;
        }),
    );
  const first = createPersonalTask(project, options);
  const secondOptions = { ...options, modelId: "another-model" };
  const second = createPersonalTask(project, secondOptions);
  const secondId = JSON.parse(request.mock.calls[1][1].body).operation_id;
  completeFirst({ session, operation: { state: "ready" } });
  await first;
  failSecond(new Error("lost response"));
  await expect(second).rejects.toThrow("lost response");
  request.mockResolvedValueOnce({ session, operation: { state: "ready" } });
  await createPersonalTask(project, secondOptions);
  expect(JSON.parse(request.mock.calls[2][1].body).operation_id).toBe(secondId);
});

it.each([422, 410])(
  "uses a new operation only on the next explicit submit after terminal status %s",
  async (status) => {
    request.mockRejectedValueOnce(
      Object.assign(new Error("terminal"), { status }),
    );
    await expect(createPersonalTask(project, options)).rejects.toThrow(
      "terminal",
    );
    const original = JSON.parse(request.mock.calls[0][1].body).operation_id;
    request.mockResolvedValueOnce({ session, operation: { state: "ready" } });
    await createPersonalTask(project, options);
    expect(JSON.parse(request.mock.calls[1][1].body).operation_id).not.toBe(
      original,
    );
  },
);
it("preserves collaboration and safely encodes project and session routes", () => {
  expect(personalTaskRoute("项目 & one")).toBe(
    "/?workagent=shared&project=%E9%A1%B9%E7%9B%AE%20%26%20one&personal=new",
  );
  expect(personalTaskRoute("project", "session/one?next=two")).toBe(
    "/?workagent=shared&project=project&session=session%2Fone%3Fnext%3Dtwo",
  );
});

it("recognizes only a shared personal task draft with no selected session", () => {
  const parse = (query) => sharedTaskProject(new URLSearchParams(query));
  expect(parse("workagent=shared&project=one&personal=new")).toBe("one");
  expect(
    parse("workagent=shared&project=one&personal=new&session=task"),
  ).toBeNull();
  expect(parse("workagent=shared&project=one&discussion=thread")).toBeNull();
  expect(parse("project=one&personal=new")).toBeNull();
  expect(parse("workagent=shared&personal=new")).toBeNull();
});
