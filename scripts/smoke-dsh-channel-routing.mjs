import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const profile = resolve(
  process.env.WORKAGENT_SMOKE_PROFILE || ".cache/dsh-home/profiles/workagent",
);
const load = (name) =>
  import(
    pathToFileURL(
      join(profile, "node_modules/@michengai/dsh-im-connect/lib/engine", name),
    ).href
  );
const [{ ImEngine }, { SessionMapStore }, { SeenStore }] = await Promise.all([
  load("gateway.js"),
  load("session-store.js"),
  load("seen-store.js"),
]);
const { ChannelManager } = await import(
  pathToFileURL(
    join(profile, "node_modules/@michengai/dsh-im-connect/lib/manager.js"),
  ).href
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
  assert.notEqual(calls.at(-1).id, original);
  assert.equal(calls.at(-1).selection.provider, "workagent-kimi");
  console.log(
    "PASS four native channel routes, replies, authorization, deduplication, persisted mapping and engine switch",
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
  console.log(
    "PASS four completion reminder transports, recipient deduplication and unavailable target rejection",
  );
} finally {
  await engine.dispose();
}
