import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexBridge } from "./codex.js";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:child_process", () => ({
  spawn: () => ({
    stdout: { once() {} },
    stdin: {},
    stderr: { resume() {} },
    once() {},
    kill() {},
  }),
}));
vi.mock("./jsonl-rpc.js", () => ({
  JsonLineRpc: class {
    request = request;
    notify() {}
    onRequest() {}
    onNotification() {}
    close() {}
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  request.mockReset();
});

describe("Codex reasoning policy", () => {
  it("steers the expected active turn without starting another one", async () => {
    vi.stubEnv("CODEX_HOME", "test-codex-home");
    request.mockImplementation(async (method: string) =>
      method === "turn/start"
        ? { turn: { id: "turn-active" } }
        : method === "turn/steer"
          ? { turnId: "turn-active" }
          : { thread: { id: "thread-steer" } },
    );
    const bridge = new CodexBridge();
    const session = await bridge.create("workspace", () => {});
    await expect(session.steer("early")).rejects.toThrow("no_active_turn");
    await session.send("first");
    expect(await session.steer("correction")).toBe("turn-active");
    expect(request).toHaveBeenCalledWith("turn/steer", {
      threadId: "thread-steer",
      expectedTurnId: "turn-active",
      input: [{ type: "text", text: "correction" }],
    });
    expect(
      request.mock.calls.filter(([method]) => method === "turn/start"),
    ).toHaveLength(1);
    await bridge.close();
  });
  it("only advertises GPT-6 and the three GPT-5.6 models across pages", async () => {
    vi.stubEnv("CODEX_HOME", "test-codex-home");
    request.mockImplementation(async (method: string, params) =>
      method === "model/list"
        ? {
            data: (params.cursor
              ? ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.2"]
              : ["gpt-6-astra", "gpt-5.5", "gpt-5.6-sol"]
            ).map((model) => ({
              model,
              displayName: model,
              isDefault: model === "gpt-6-astra",
              supportedReasoningEfforts: [],
            })),
            nextCursor: params.cursor ? null : "page-2",
          }
        : {},
    );
    const bridge = new CodexBridge();
    expect((await bridge.listModels()).map((model) => model.id)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    await bridge.close();
  });

  it("removes ultra from live capabilities and replaces an ultra default", async () => {
    vi.stubEnv("CODEX_HOME", "test-codex-home");
    request.mockImplementation(async (method: string) =>
      method === "model/list"
        ? {
            data: ["medium", "ultra"].map((defaultReasoningEffort, index) => ({
              model: ["gpt-6-astra", "gpt-5.6-sol"][index],
              displayName: defaultReasoningEffort,
              isDefault: defaultReasoningEffort === "medium",
              defaultReasoningEffort,
              supportedReasoningEfforts: [
                "medium",
                "xhigh",
                "max",
                "ultra",
              ].map((reasoningEffort) => ({
                reasoningEffort,
                description: "",
              })),
            })),
            nextCursor: null,
          }
        : {},
    );
    const bridge = new CodexBridge();
    const models = await bridge.listModels();
    expect(models.map((model) => model.defaultReasoning)).toEqual([
      "medium",
      "max",
    ]);
    for (const model of models)
      expect(model.reasoning.map((effort) => effort.id)).toEqual([
        "medium",
        "xhigh",
        "max",
      ]);
    await bridge.close();
  });

  it.each(["create", "resume", "fork"] as const)(
    "caps saved ultra for %s while preserving other effort levels",
    async (operation) => {
      vi.stubEnv("CODEX_HOME", "test-codex-home");
      request.mockImplementation(async (method: string) =>
        method === "turn/start"
          ? { turn: { id: "turn" } }
          : { thread: { id: "thread" } },
      );
      const bridge = new CodexBridge();
      for (const thinkingEffort of ["ultra", "max", "high", undefined]) {
        const options = {
          mcpServers: [],
          ...(thinkingEffort === undefined ? {} : { thinkingEffort }),
        };
        const session =
          operation === "create"
            ? await bridge.create("workspace", () => {}, options)
            : await bridge[operation]("thread", "workspace", () => {}, options);
        await session.send("hello");
        const params = request.mock.calls.at(-1)?.[1];
        expect(params.effort).toBe(
          thinkingEffort === "ultra" ? "max" : thinkingEffort,
        );
      }
      await bridge.close();
    },
  );
});
