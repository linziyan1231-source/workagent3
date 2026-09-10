import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const plugin = resolve(
  process.env.WORKAGENT_SMOKE_IM_PLUGIN ||
    ".cache/dsh-home/profiles/workagent/node_modules/@michengai/dsh-im-connect",
);
const load = (file) => import(pathToFileURL(join(plugin, "lib", file)).href);
const { normalizeAssistantModel } = await load("engine/assistant-settings.js");
const { ChannelManager } = await load("manager.js");
const { SessionRouter } = await load("engine/router.js");
const original = {
  provider: "workagent-codex",
  model: "gpt-test",
  presetId: "custom-one",
  reasoningEffort: "high",
};
assert.deepEqual(normalizeAssistantModel(original), original);
const records = new Map([
  [
    "weixin:dm:chat",
    {
      channel: "weixin",
      kind: "dm",
      chatId: "chat",
      sessionId: "session-channel-old",
      workagentConfig: original,
    },
  ],
]);
const state = {
  name: "测试账号",
  platform: "weixin",
  assistant: original,
  cwd: process.cwd(),
  permission: "read-only",
  privateAccess: "approved",
};
let reloads = 0;
const service = {
  handles: (provider) => provider === "workagent-codex",
  validateAssistant: (config) => {
    if (config.presetId === "disabled") throw Error("preset_disabled");
  },
  open: async (config, id) =>
    config.presetId === "custom-one" ? { sessionId: id } : undefined,
};
const manager = Object.assign(Object.create(ChannelManager.prototype), {
  ctx: { get: () => service },
  store: { channels: { weixin: state } },
  engineConfig: original,
  sessions: {
    list: () => [...records.values()],
    upsert: (key, record) => records.set(key, record),
  },
  permissionPresets: () => ({
    names: ["read-only"],
    defaultPreset: "read-only",
  }),
  flush: () => {},
  engine: { reloadChannel: () => reloads++ },
  accountView: () => state,
});
assert.equal(
  manager.updateAccount("weixin", { presetId: "custom-two" }).ok,
  true,
);
assert.equal(manager.accountEngineConfig("weixin").presetId, "custom-two");
assert.equal(records.get("weixin:dm:chat").workagentConfig, undefined);
assert.equal(reloads, 1);
const router = new SessionRouter(
  { get: () => service },
  {},
  manager.engineConfig,
  () => {},
);
router.resolveConfig = () => manager.accountEngineConfig("weixin");
assert.equal(
  await router.resume(records.get("weixin:dm:chat")),
  undefined,
  "assistant switch must reject old native thread",
);
assert.equal(
  manager.updateAccount("weixin", { presetId: "disabled" }).ok,
  false,
);
assert.equal(
  state.assistant.presetId,
  "custom-two",
  "invalid selection must preserve saved assistant",
);
const disk = JSON.parse(JSON.stringify(state));
assert.equal(normalizeAssistantModel(disk.assistant).presetId, "custom-two");
console.log(
  "PASS assistant normalization, account save, persisted selection, command override invalidation and native thread rotation",
);
