import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexBridge } from "./codex.js";

const rpc = vi.hoisted(() => ({
  notify: (_method: string, _params: unknown) => {},
  exit: () => {},
  transportClose: () => {},
  request: (_id: number, _method: string, _params: unknown) => {},
  responses: [] as unknown[],
  errors: [] as string[],
}));
vi.mock("node:child_process", () => ({
  spawn: () => ({
    stdout: {
      once(_event: string, callback: () => void) {
        rpc.transportClose = callback;
      },
    },
    stdin: {
      write(value: string) {
        rpc.errors.push(value);
      },
    },
    stderr: { resume() {} },
    kill() {},
    once(event: string, callback: () => void) {
      if (event === "exit") rpc.exit = callback;
    },
  }),
}));
vi.mock("./jsonl-rpc.js", () => ({
  JsonLineRpc: class {
    async request(method: string) {
      return method === "turn/start"
        ? { turn: { id: "turn-1" } }
        : { thread: { id: "thread-1" } };
    }
    notify() {}
    onRequest(callback: typeof rpc.request) {
      rpc.request = callback;
    }
    respond(id: number, result: unknown) {
      rpc.responses.push({ id, result });
    }
    close() {}
    onNotification(callback: typeof rpc.notify) {
      rpc.notify = callback;
    }
  },
}));
afterEach(() => vi.unstubAllEnvs());

describe("Codex turn lifecycle", () => {
  it("surfaces provider retries and terminal errors instead of leaving thinking active", async () => {
    vi.stubEnv("CODEX_HOME", "test-codex-home");
    const emit = vi.fn();
    const bridge = new CodexBridge();
    const session = await bridge.create("workspace", emit);
    await session.send("hello");
    rpc.notify("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-1" },
    });
    rpc.notify("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: true,
      error: { message: "high demand" },
    });
    expect(emit).toHaveBeenLastCalledWith({
      type: "turn.retrying",
      turnId: "turn-1",
      message: "high demand",
    });
    rpc.notify("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: { message: "high demand" },
    });
    expect(emit).toHaveBeenLastCalledWith({
      type: "turn.failed",
      turnId: "turn-1",
      code: "codex_failed",
      message: "high demand",
    });
    await bridge.close();
  });
  it("finishes an active turn when the Codex process exits", async () => {
    vi.stubEnv("CODEX_HOME", "test-codex-home");
    const emit = vi.fn();
    const bridge = new CodexBridge();
    const session = await bridge.create("workspace", emit);
    await session.send("hello");
    rpc.exit();
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "turn.failed",
        turnId: "turn-1",
        code: "codex_disconnected",
      }),
    );
    await bridge.close();
  });
});

it("routes approvals by thread identity and rejects unknown server methods", async () => {
  vi.stubEnv("CODEX_HOME", "test-codex-home");
  rpc.responses.length = 0;
  rpc.errors.length = 0;
  const requestApproval = vi.fn(async () => "allow" as const);
  const bridge = new CodexBridge();
  const session = await bridge.create("workspace", () => {}, {
    mcpServers: [],
    requestApproval,
  });
  await session.send("hi");
  rpc.request(91, "item/commandExecution/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
    command: "dir",
  });
  await vi.waitFor(() =>
    expect(rpc.responses).toContainEqual({
      id: 91,
      result: { decision: "accept" },
    }),
  );
  rpc.request(92, "item/fileChange/requestApproval", {
    threadId: "other",
    turnId: "turn-1",
  });
  await vi.waitFor(() =>
    expect(rpc.responses).toContainEqual({
      id: 92,
      result: { decision: "cancel" },
    }),
  );
  rpc.request(93, "item/unknown/requestApproval", {});
  expect(JSON.parse(rpc.errors[0]!)).toEqual({
    id: 93,
    error: { code: -32601, message: "Unsupported server request" },
  });
  expect(requestApproval).toHaveBeenCalledTimes(1);
  await bridge.close();
});
it("aborts approvals when the transport closes before process exit", async () => {
  vi.stubEnv("CODEX_HOME", "test-codex-home");
  let signal!: AbortSignal;
  const bridge = new CodexBridge();
  const session = await bridge.create("workspace", () => {}, {
    mcpServers: [],
    requestApproval: async (request) => {
      signal = request.signal;
      return new Promise(() => {});
    },
  });
  await session.send("hi");
  rpc.request(94, "item/fileChange/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
  });
  await vi.waitFor(() => expect(signal).toBeDefined());
  rpc.transportClose();
  expect(signal.aborted).toBe(true);
  await bridge.close();
});
