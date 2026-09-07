import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { RuntimeController } from "./runtime.js";
import { WorkspaceStore } from "./workspace-store.js";
import { PresetStore } from "./preset-store.js";
import {
  ModelAccessStore,
  type CredentialStatusStore,
} from "./model-access-store.js";
import { McpCatalogStore, SkillCatalogStore } from "./capability-store.js";
import { SessionIndex } from "./session-index.js";
import { MessageStore } from "./message-store.js";

const native = vi.hoisted(() => ({
  create: vi.fn(),
  resume: vi.fn(),
  send: vi.fn(),
  cancel: vi.fn(),
  close: vi.fn(),
  events: undefined as undefined | ((event: any) => void),
}));
vi.mock("./engines/codex.js", () => ({
  CodexBridge: class {
    create = native.create;
    resume = native.resume;
    async listModels() {
      return [
        {
          id: "gpt-test",
          name: "GPT Test",
          isDefault: true,
          reasoning: [{ id: "high", name: "高" }],
        },
      ];
    }
  },
}));
vi.mock("./engines/kimi.js", () => ({
  KimiBridge: class {
    create = native.create;
    resume = native.resume;
    async listModels() {
      return [
        { id: "kimi-test", name: "Kimi Test", isDefault: true, reasoning: [] },
      ];
    }
  },
}));

const config = {
  provider: "workagent-codex",
  model: "gpt-test",
  reasoningEffort: "high",
  permissionPreset: "read-only",
};
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "channel-runtime-"));
  vi.stubEnv("DSH_HOME", home);
  const workspaces = new WorkspaceStore(join(home, "workspaces"), home);
  const presets = new PresetStore(home, new ModelAccessStore(home));
  const quota = {
    reserve: vi.fn().mockResolvedValue({ status: "reserved" }),
    settle: vi.fn().mockResolvedValue(undefined),
  };
  const routes = new Map<string, any>();
  const ctx = {
    effect: (callback: () => unknown) => callback(),
    on: () => () => {},
    webServer: {
      register: (route: any) => {
        routes.set(route.path, route.handler);
        return () => {};
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: "p" }) },
    llm: { listModels: async () => [] },
  } as unknown as Context;
  const credentials = {
    statusFor: () => ({ state: "ready" }),
  } as unknown as CredentialStatusStore;
  const createRuntime = () =>
    new RuntimeController(
      ctx,
      "test",
      workspaces,
      presets,
      new McpCatalogStore(),
      new SkillCatalogStore(),
      credentials,
      quota,
    );
  const runtime = createRuntime();
  runtime.mount();
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    token = "test",
  ) => {
    const req = Object.assign(
      Readable.from(body === undefined ? [] : [JSON.stringify(body)]),
      { url: path, method, headers: { authorization: `Bearer ${token}` } },
    );
    let status = 0;
    let result: any;
    const res = {
      writeHead: (value: number) => {
        status = value;
      },
      end: (value: string) => {
        result = value ? JSON.parse(value) : undefined;
      },
    };
    const route = [...routes.keys()]
      .sort((a, b) => b.length - a.length)
      .find((base) => path.startsWith(base))!;
    await routes.get(route)(req, res);
    return { status, result };
  };
  return {
    home,
    workspaces,
    call,
    quota,
    createRuntime,
    service: runtime.channelService(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const open = async (...args: any[]) => {
    native.events = args.find((arg) => typeof arg === "function");
    return {
      nativeId: "native-thread",
      send: native.send,
      cancel: native.cancel,
      close: native.close,
    };
  };
  native.create.mockImplementation(open);
  native.resume.mockImplementation(open);
  native.send.mockImplementation(async () => {
    native.events!({ type: "turn.started", turnId: "turn-1" });
    native.events!({
      type: "assistant.delta",
      turnId: "turn-1",
      delta: "你好",
    });
    native.events!({
      type: "assistant.completed",
      turnId: "turn-1",
      content: "你好",
    });
    native.events!({ type: "turn.completed", turnId: "turn-1" });
    return "turn-1";
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("native IM sessions", () => {
  it("pushes a successful webpage turn through the connected IM transport with a downloadable artifact", async () => {
    const a = fixture();
    const endpoint = "/v1/completion-notifications";
    expect((await a.call(endpoint, "GET", undefined, "wrong")).status).toBe(
      401,
    );
    const send = vi.fn().mockResolvedValue(undefined);
    a.service.attachNotifications({
      targets: () => [
        {
          id: "chat",
          label: "飞书接收者",
          connected: true,
          channelId: "feishu",
          chatId: "chat",
          kind: "dm",
        },
      ],
      send,
    });
    expect(
      (
        await a.call(endpoint, "PUT", {
          enabled: true,
          targetId: "chat",
          baseURL: "https://workagent.example.com",
        })
      ).status,
    ).toBe(200);
    const created = await a.call("/v1/sessions", "POST", {
      engine: "codex",
      modelId: "gpt-test",
      title: "网页任务",
      workspace: "default",
      permissionMode: "read_only",
    });
    expect(created.status).toBe(201);
    a.workspaces.write("default", "result.txt", Buffer.from("artifact"));
    native.send.mockImplementationOnce(async () => {
      native.events!({ type: "turn.started", turnId: "notify-turn" });
      native.events!({
        type: "assistant.completed",
        turnId: "notify-turn",
        content: "已完成：[下载](result.txt)",
      });
      expect(send).not.toHaveBeenCalled();
      native.events!({ type: "turn.completed", turnId: "notify-turn" });
      return "notify-turn";
    });
    await a.call(`/v1/sessions/${created.result.id}/turns`, "POST", {
      content: "生成报告",
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls.map(([, text]) => text).join("\n")).toContain(
      "/content?path=result.txt",
    );
    await vi.waitFor(async () =>
      expect((await a.call(endpoint)).result.deliveries[0].status).toBe("sent"),
    );
    const count = send.mock.calls.length;
    native.events!({
      type: "turn.failed",
      turnId: "failed",
      message: "failure",
    });
    expect(send).toHaveBeenCalledTimes(count);
  });

  it("uses the selected engine/model/permission, enforces quota, and delivers the final reply once", async () => {
    const { home, service, quota } = fixture();
    const handle = (await service.open(config, undefined, "飞书会话"))!;
    expect(native.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({
        modelId: "gpt-test",
        thinkingEffort: "high",
        permissionMode: "read_only",
      }),
    );
    const reply = vi.fn().mockResolvedValue(undefined);
    await handle.followup(
      { id: "msg-1", content: [{ type: "text", text: "你好" }] },
      reply,
    );
    expect(quota.reserve).toHaveBeenCalledOnce();
    expect(reply.mock.calls.map(([event]) => event.type)).toEqual([
      "assistant/chunk",
      "assistant/message",
      "turn/end",
    ]);
    expect(new SessionIndex(home).list()[0]).toMatchObject({
      engine: "codex",
      modelId: "gpt-test",
      title: "飞书会话",
      nativeId: "native-thread",
    });
    expect(
      new MessageStore(home)
        .list(handle.sessionId)
        .map((row) => row.role)
        .sort(),
    ).toEqual(["assistant", "user"]);
  });

  it("resumes the persisted native thread after restart, and rotates when selection changes", async () => {
    const { service, createRuntime } = fixture();
    const first = (await service.open(config))!;
    await first.dispose();
    const restarted = createRuntime().channelService();
    expect(restarted.listSessionIds()).toContain(first.sessionId);
    const resumed = await restarted.open(config, first.sessionId);
    expect(resumed?.sessionId).toBe(first.sessionId);
    expect(native.resume).toHaveBeenCalledWith(
      "native-thread",
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ modelId: "gpt-test" }),
    );
    expect(
      await restarted.open(
        { ...config, provider: "workagent-kimi", model: "kimi-test" },
        first.sessionId,
      ),
    ).toBeUndefined();
    expect(
      await restarted.open(
        { ...config, permissionPreset: "workspace-write" },
        first.sessionId,
      ),
    ).toBeUndefined();
  });

  it("rejects quota failures before sending, then accepts a retry without leaked listeners", async () => {
    const { service, quota } = fixture();
    const handle = (await service.open(config))!;
    quota.reserve.mockRejectedValueOnce(new Error("quota_exceeded"));
    const failedReply = vi.fn();
    await expect(
      handle.followup(
        { id: "failed", content: [{ type: "text", text: "hello" }] },
        failedReply,
      ),
    ).rejects.toThrow("quota_exceeded");
    expect(native.send).not.toHaveBeenCalled();
    await handle.followup(
      { id: "retry", content: [{ type: "text", text: "hello" }] },
      vi.fn(),
    );
    expect(failedReply).not.toHaveBeenCalled();
  });

  it("exposes real native catalogs and rejects unavailable selections and custom permission presets", async () => {
    const { service } = fixture();
    expect(await service.models()).toMatchObject([
      { id: "workagent-codex", models: [{ id: "gpt-test" }] },
      { id: "workagent-kimi", models: [{ id: "kimi-test" }] },
    ]);
    await expect(
      service.open({ ...config, model: "invented" }),
    ).rejects.toThrow("channel_model_unavailable");
    await expect(
      service.open({ ...config, permissionPreset: "custom" }),
    ).rejects.toThrow("消息渠道请选择");
    const kimi = await service.open({
      provider: "workagent-kimi",
      model: "kimi-test",
      permissionPreset: "workspace-write",
    });
    expect(kimi?.sessionId).toMatch(/^session-channel-/);
    expect(native.create).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({
        modelId: "kimi-test",
        permissionMode: "workspace_write",
      }),
    );
  });
});
