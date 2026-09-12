import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const profile = resolve(
  process.env.WORKAGENT_SMOKE_PROFILE || ".cache/dsh-home/profiles/workagent",
);
const plugin =
  process.env.WORKAGENT_SMOKE_PLUGIN ||
  join(profile, "node_modules/@michengai/dsh-im-connect");
const load = (name) =>
  import(pathToFileURL(join(plugin, "lib/engine", name)).href);
const [{ ImEngine }, { SessionMapStore }, { SeenStore }] = await Promise.all([
  load("gateway.js"),
  load("session-store.js"),
  load("seen-store.js"),
]);
const { ChannelManager } = await import(
  pathToFileURL(join(plugin, "lib/manager.js")).href
);
const home = await mkdtemp(join(tmpdir(), "channel-routing-"));
const sessions = new Map();
const calls = [];
const config = {
  provider: "workagent-codex",
  model: "gpt-test",
  permissionPreset: "read-only",
};
const service = {
  history: () =>
    [...sessions.keys()].map((id) => ({
      id,
      active: false,
      updatedAt: new Date().toISOString(),
    })),
  handles: (provider) =>
    ["workagent-codex", "workagent-kimi"].includes(provider),
  listSessionIds: () => [...sessions.keys()],
  resume: async (_key, id) => service.open(sessions.get(id), id),
  activeChannel: () => undefined,
  open: async (selection, id) => {
    if (id && sessions.get(id)?.provider !== selection.provider)
      return undefined;
    id ||= `session-channel-test-${sessions.size}`;
    sessions.set(id, { ...selection });
    return {
      sessionId: id,
      workagent: true,
      dispose: async () => {},
      followup: async (message, event) => {
        calls.push({
          id,
          selection: { ...selection },
          text: message.content.map((block) => block.text).join("\n"),
        });
        await event({
          type: "assistant/message",
          data: {
            message: { content: [{ type: "text", text: `回复 ${id}` }] },
          },
        });
        await event({
          type: "turn/end",
          data: { reason: { kind: "completed" } },
        });
      },
    };
  },
};
const ctx = {
  get: (name) =>
    name === "workagentChannels"
      ? service
      : name === "sessions"
        ? { list: () => [] }
        : undefined,
  agents: {
    create: () => {
      throw Error("native messages must never create Harness agents");
    },
    get: () => undefined,
  },
};
const storePath = join(home, "sessions.json");
const createEngine = () =>
  new ImEngine(
    ctx,
    new SessionMapStore(storePath),
    new SeenStore(join(home, "seen.json")),
    config,
    () => {},
  );
const delivered = [];
let engine = createEngine();
function register(id) {
  const channel = {
    id,
    label: id,
    skipMerge: true,
    maxMessageLength: 4000,
    status: () => "online",
    setMessageHandler: () => {},
    send: async (chatId, text) => {
      delivered.push({ id, chatId, text });
    },
  };
  engine.register(channel);
  engine.addAllowed(id, "approved");
}
const message = (id, extra = {}) => ({
  messageId: id,
  chatId: "chat",
  userId: "approved",
  kind: "dm",
  text: "你好",
  ...extra,
});
try {
  for (const platform of ["feishu", "wecom", "weixin", "dingtalk"]) {
    register(platform);
    await engine.handleInbound(platform, message(platform));
    assert.equal(calls.at(-1).selection.provider, "workagent-codex");
    assert.equal(delivered.at(-1).text, `回复 ${calls.at(-1).id}`);
  }
  const initialCount = calls.length;
  await engine.handleInbound("feishu", message("feishu"));
  await engine.handleInbound(
    "feishu",
    message("unapproved", { userId: "stranger" }),
  );
  assert.equal(
    calls.length,
    initialCount,
    "duplicate and unauthorized messages must not execute",
  );
  const original = engine.router.lookup("feishu", "dm", "chat").sessionId;
  await engine.dispose();
  engine = createEngine();
  register("feishu");
  await engine.attachMappedSessions();
  assert.equal(
    engine.store.list().length,
    4,
    "native mappings must survive startup pruning",
  );
  await engine.handleInbound("feishu", message("after-restart"));
  assert.equal(calls.at(-1).id, original);
  config.provider = "workagent-kimi";
  config.model = "kimi-test";
  await engine.router.disposeChannel("feishu");
  await engine.handleInbound("feishu", message("switch-engine"));
  assert.equal(calls.at(-1).id, original);
  assert.equal(calls.at(-1).selection.provider, "workagent-codex");
  // A webpage-owned ID also resumes through the same actual router.
  sessions.set("session-web-existing", {
    provider: "workagent-codex",
    model: "original-model",
  });
  const key = "feishu:dm:chat";
  engine.store.upsert(key, {
    ...engine.store.get(key),
    sessionId: "session-web-existing",
  });
  await engine.router.disposeChannel("feishu");
  await engine.handleInbound("feishu", message("web-task-from-im"));
  assert.equal(calls.at(-1).id, "session-web-existing");
  assert.equal(calls.at(-1).selection.model, "original-model");
  const routed = delivered.length;
  await engine.onSessionEvent(
    { id: "session-web-existing" },
    {
      type: "assistant/message",
      data: { message: { content: [{ type: "text", text: "webpage-only" }] } },
    },
  );
  assert.equal(
    delivered.length,
    routed,
    "global webpage output must not leak to an attached chat",
  );
  await engine.handleInbound(
    "feishu",
    message("group-stranger", {
      kind: "group",
      userId: "stranger",
      addressed: true,
    }),
  );
  assert.equal(calls.at(-1).id, "session-web-existing");
  console.log(
    "PASS four channels, webpage task resume, original model after account changes, source replies, access control and restart",
  );
  for (const platform of ["feishu", "wecom", "weixin", "dingtalk"]) {
    const sent = [];
    const adapter = {
      send: async (chat, text) => sent.push({ chat, text, proactive: false }),
      ...(platform === "weixin"
        ? {}
        : {
            sendNotification: async (chat, text, kind) =>
              sent.push({ chat, text, kind, proactive: true }),
          }),
    };
    const manager = Object.assign(Object.create(ChannelManager.prototype), {
      sessions: {
        list: () => [
          {
            channel: platform,
            kind: "dm",
            chatId: "recipient",
            title: "接收聊天",
          },
          {
            channel: platform,
            kind: "dm",
            chatId: "recipient",
            title: "接收聊天",
          },
        ],
      },
      store: { channels: { [platform]: { platform } } },
      running: new Map([[platform, adapter]]),
    });
    const targets = manager.notificationTargets();
    assert.equal(targets.length, 1);
    await manager.sendNotification(
      targets[0].id,
      "任务已完成：报告\nhttps://example.com/result",
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chat, "recipient");
    assert.equal(sent[0].proactive, platform !== "weixin");
    manager.running.clear();
    await assert.rejects(
      manager.sendNotification(targets[0].id, "offline"),
      /未连接/,
    );
    await assert.rejects(
      manager.sendNotification("unselected", "wrong recipient"),
      /未连接/,
    );
  }
  // Completion notifications rebind the chat to the notified session; guards leave the binding unchanged.
  {
    const sent = [];
    const warnings = [];
    const disposed = [];
    let resumeCount = 0;
    const key = "weixin:dm:recipient";
    const records = new Map([
      [
        key,
        {
          channel: "weixin",
          kind: "dm",
          chatId: "recipient",
          sessionId: "session-old",
          title: "旧任务",
        },
      ],
    ]);
    const rebindService = {
      handles: () => true,
      listSessionIds: () => ["session-old", "session-notified"],
      history: () => [
        { id: "session-old", title: "旧任务", active: false },
        { id: "session-notified", title: "新任务", active: false },
      ],
      configuration: (_key, id) => ({ provider: "workagent-codex", for: id }),
      resume: async (_key, id) => {
        resumeCount++;
        return { sessionId: id, workagent: true, dispose: async () => {} };
      },
    };
    const live = new Map([
      [
        key,
        {
          key,
          channelId: "weixin",
          kind: "dm",
          chatId: "recipient",
          sessionId: "session-old",
          handle: {
            workagent: true,
            dispose: async () => {
              disposed.push("session-old");
            },
          },
        },
      ],
    ]);
    const manager = Object.assign(Object.create(ChannelManager.prototype), {
      sessions: {
        list: () => [...records.values()],
        get: (k) => records.get(k),
        upsert: (k, v) => records.set(k, v),
      },
      store: { channels: { weixin: { platform: "weixin" } } },
      running: new Map([
        ["weixin", { send: async (chat, text) => sent.push({ chat, text }) }],
      ]),
      engine: {
        resolveConfig: () => ({ provider: "workagent-codex" }),
        router: { live },
      },
      ctx: {
        get: (name) =>
          name === "workagentChannels" ? rebindService : undefined,
      },
      log: { warn: (...args) => warnings.push(args) },
    });
    const targetId = manager.notificationTargets()[0].id;
    rebindService.collaboration = { access: async () => ({}) };
    records.set(key, {...records.get(key),lastInputAt:'2026-01-01T00:00:00.000Z'});
    await manager.sendNotification(targetId, "协作完成", "collaboration:discussion-1");
    assert.equal(records.get(key).sessionId,"session-old");
    assert.equal(records.get(key).lastInputAt,'2026-01-01T00:00:00.000Z');
    assert.equal(records.get(key).collaboration.conversationId,'discussion-1');
    assert.equal(resumeCount,0);
    assert.equal(live.get(key).sessionId,"session-old");
    await manager.sendNotification(targetId, "任务已完成", "session-notified");
    assert.equal(records.get(key).collaboration,null);
    assert.equal(records.get(key).sessionId, "session-notified");
    assert.equal(records.get(key).title, "新任务");
    assert.ok(records.get(key).lastInputAt);
    assert.equal(live.get(key).sessionId, "session-notified");
    assert.deepEqual(disposed, ["session-old"]);
    assert.equal(resumeCount, 1);
    assert.equal(warnings.length, 0);
    // 重复通知同一会话只刷新时间戳，不再 resume
    await manager.sendNotification(targetId, "again", "session-notified");
    assert.equal(resumeCount, 1);
    // 无 sessionId 的主动消息（message_send）不重绑
    await manager.sendNotification(targetId, "plain message");
    assert.equal(records.get(key).sessionId, "session-notified");
    // 待续接消息待选择时不重绑
    records.set(key, { ...records.get(key), pendingInput: { text: "暂存" } });
    await manager.sendNotification(targetId, "任务已完成", "session-old");
    assert.equal(records.get(key).sessionId, "session-notified");
    assert.equal(records.get(key).pendingInput.text, "暂存");
    records.set(key, { ...records.get(key), pendingInput: null });
    // 当前任务运行中不抢回复对象
    rebindService.history = () => [
      { id: "session-notified", title: "新任务", active: true },
      { id: "session-old", title: "旧任务", active: false },
    ];
    await manager.sendNotification(targetId, "任务已完成", "session-old");
    assert.equal(records.get(key).sessionId, "session-notified");
    // 未知会话不重绑
    await manager.sendNotification(targetId, "任务已完成", "session-unknown");
    assert.equal(records.get(key).sessionId, "session-notified");
    assert.equal(warnings.length, 0);
  }
  // apply() 的通知接线必须把 sessionId 透传给 manager.sendNotification，否则完成通知不会重绑聊天。
  {
    const { apply } = await import(
      pathToFileURL(join(plugin, "lib/index.js")).href
    );
    const sendCalls = [];
    const originalSend = ChannelManager.prototype.sendNotification;
    ChannelManager.prototype.sendNotification = async function (...args) {
      sendCalls.push(args);
    };
    let transport;
    const applyHome = await mkdtemp(join(tmpdir(), "im-apply-"));
    const applyCtx = {
      permissionPresets: { defaultPreset: "read-only", names: ["read-only"] },
      logger: () => ({ info: () => {}, warn: () => {} }),
      effect: (fn) => {
        fn();
      },
      get: (name) =>
        name === "workagentChannels"
          ? {
              attachNotifications: (t) => {
                transport = t;
                return () => {};
              },
            }
          : ctx.get(name),
      agents: ctx.agents,
    };
    try {
      apply(applyCtx, {
        stateDir: applyHome,
        cwd: applyHome,
        provider: "",
        model: "",
        agentPreset: "standard",
        mergeTimeoutSecs: 5,
      });
      for (let i = 0; i < 100 && !transport; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(transport, "notification transport must be attached");
      await transport.send("target", "任务已完成", "session-notified");
      assert.deepEqual(
        sendCalls[0],
        ["target", "任务已完成", "session-notified"],
        "notification wiring must forward sessionId for rebinding",
      );
    } finally {
      ChannelManager.prototype.sendNotification = originalSend;
    }
  }
  console.log(
    "PASS four completion reminder transports, recipient deduplication, unavailable target rejection and notification rebinding",
  );
} finally {
  await engine.dispose();
}
