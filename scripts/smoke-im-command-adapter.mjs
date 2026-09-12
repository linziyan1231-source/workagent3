import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const plugin = process.argv[2];
if (!plugin)
  throw new Error("Pass the installed dsh-im-connect plugin directory");
const { handleWorkagentCommand, checkWorkagentIdle } = await import(
  pathToFileURL(resolve(plugin, "lib/engine/workagent-commands.js"))
);
const { createWorkagentHost } = await import(pathToFileURL(resolve(plugin, 'lib/engine/workagent-host.js')));
const key = "weixin:dm:chat";
const records = new Map([
  [
    key,
    {
      sessionId: "session-channel-one",
      lastInputAt: new Date(Date.now() - 3 * 3600000).toISOString(),
    },
  ],
]);
let current = {
  key,
  sessionId: "session-channel-one",
  handle: { workagent: true, dispose: async () => {} },
};
const sessions = [
  {
    id: current.sessionId,
    title: "Original",
    workspaceId: "project",
    workspaceName: "Project",
    updatedAt: new Date(Date.now() - 3 * 3600000).toISOString(),
    active: false,
  },
  {
    id: "session-web-two",
    title: "History",
    workspaceId: "project",
    workspaceName: "Project",
    active: false,
  },
];
const inputs = [],
  replies = [],
  opened = [];
const service = {
  handles: () => true,
  history: (scope) => {
    assert.equal(scope, key);
    return sessions;
  },
  projects: () => [
    { id: "default", name: "默认项目", cwd: "C:/default-fixture" },
    { id: "project", name: "Project", cwd: "C:/fixture" },
  ],
  configuration: () => ({ provider: "workagent-codex", model: "fixture" }),
  resume: async (scope, id) => {
    assert.equal(scope, key);
    return { sessionId: id, workagent: true, dispose: async () => {} };
  },
  open: async (config, _id, _title, scope) => {
    assert.equal(scope, key);
    opened.push(config.cwd);
    sessions.push({ id: "session-channel-new", title: "New" });
    return {
      sessionId: "session-channel-new",
      workagent: true,
      dispose: async () => {},
    };
  },
  rename: async () => {
    throw new Error("rename rejected");
  },
};
const accountConfig = { provider: "workagent-codex", model: "fixture" };
const engine = {
  ctx: { get: () => service },
  resolveConfig: () => accountConfig,
  store: { get: (k) => records.get(k), upsert: (k, v) => records.set(k, v) },
  questions: new Set(),
  broker: new Set(),
  router: {
    getOrCreate: async () => current,
    live: {
      set: (_k, v) => {
        current = v;
      },
    },
    rename: () => {
      throw new Error("must not rename after rejection");
    },
  },
  inject: async (_channel, msg) => inputs.push(msg),
};
const channel = { id: "weixin", send: async (_id, text) => replies.push(text) };
const msg = {
  chatId: "chat",
  userId: "owner",
  text: "continue my task",
  kind: "dm",
};
const command = (text, userId = "owner") =>
  handleWorkagentCommand(createWorkagentHost(engine), channel, { ...msg, text, userId });
assert.match(await command("/历史"), /Original/);
assert.match(await command("/切换 missing-task"), /没有找到/);
assert.equal(await checkWorkagentIdle(createWorkagentHost(engine), channel, msg, current), false);
assert.equal(records.get(key).pendingInput.text, msg.text);
assert.match(
  await command("/继续", "different-person"),
  /发送待续接消息的用户/,
);
assert.equal(inputs.length, 0);
engine.inject = async () => {
  throw new Error("temporary failure");
};
await assert.rejects(command("/继续"), /temporary failure/);
assert.equal(records.get(key).pendingInput.text, msg.text);
engine.inject = async (_channel, value) => inputs.push(value);
await command("/继续");
assert.equal(inputs[0].text, msg.text);
assert.equal(records.get(key).pendingInput, null);
await assert.rejects(command("/重命名 New"), /rename rejected/);
assert.match(await command("/切换 2"), /已切换/);
assert.equal(current.sessionId, "session-web-two");
assert.match(await command("/新对话"), /请选择/);
assert.match(await command("1", "different-person"), /发起选择的用户/);
assert.match(await command("/取消"), /已取消/);
assert.match(await command("/新对话 2"), /已新建/);
assert.equal(opened.at(-1), "C:/fixture");
assert.equal(current.sessionId, "session-channel-new");
// 首字前缀匹配：/新、/新对 等同 /新对话；命中多个命令时提示补全
assert.match(await command("/h"), /命令不明确/);
for (let index = 1; index <= 20; index += 1)
  sessions.push({
    id: `fill-${index}`,
    title: `Fill ${index}`,
    workspaceId: "project",
    workspaceName: "Project",
    active: false,
  });
// /新对话 分页：首页 10 个最近任务 + 11.默认对话 + 12.更多，之后每页 11 个，拉完不显示更多
const pageOne = await command("/新");
assert.match(pageOne, /1\. Project \/ Original/);
assert.match(pageOne, /11\. 默认对话/);
assert.match(pageOne, /12\. 更多/);
const pageTwo = await command("12");
assert.match(pageTwo, /1\. Project \/ Fill 8/);
assert.match(pageTwo, /11\. Project \/ Fill 18/);
assert.match(pageTwo, /12\. 更多/);
assert.doesNotMatch(pageTwo, /默认对话/);
const pageThree = await command("12");
assert.match(pageThree, /1\. Project \/ Fill 19/);
assert.match(pageThree, /2\. Project \/ Fill 20/);
assert.doesNotMatch(pageThree, /更多/);
assert.match(await command("2"), /已切换/);
assert.equal(current.sessionId, "fill-20");
// 默认对话在默认项目新建
assert.match(await command("/新对"), /默认对话/);
assert.match(await command("11"), /已新建/);
assert.equal(opened.at(-1), "C:/default-fixture");
// 31 分钟空闲在默认 30 分钟窗口下触发询问；回复 2 直接在默认项目新建并投递暂存消息
records.set(key, {
  ...records.get(key),
  lastInputAt: new Date(Date.now() - 31 * 60000).toISOString(),
});
assert.equal(await checkWorkagentIdle(createWorkagentHost(engine), channel, msg, current), false);
assert.match(replies.at(-1), /已空闲超过 30 分钟/);
assert.equal(await command("2"), "");
assert.equal(opened.at(-1), "C:/default-fixture");
assert.match(replies.at(-1), /已新建/);
assert.equal(inputs.at(-1).text, msg.text);
assert.equal(records.get(key).pendingInput, null);
// /策略 新建 超时后自动在默认项目新建
records.set(key, {
  ...records.get(key),
  idlePolicy: "新建",
  lastInputAt: new Date(Date.now() - 31 * 60000).toISOString(),
});
assert.equal(await checkWorkagentIdle(createWorkagentHost(engine), channel, msg, current), false);
assert.equal(opened.at(-1), "C:/default-fixture");
assert.match(replies.at(-1), /已新建/);
records.set(key, { ...records.get(key), idlePolicy: undefined });
// 账号默认空闲配置：聊天无覆盖时跟随账号设置
accountConfig.idleMinutes = 45;
records.set(key, {
  ...records.get(key),
  lastInputAt: new Date(Date.now() - 31 * 60000).toISOString(),
});
assert.equal(await checkWorkagentIdle(createWorkagentHost(engine), channel, msg, current), true);
records.set(key, {
  ...records.get(key),
  lastInputAt: new Date(Date.now() - 46 * 60000).toISOString(),
});
assert.equal(await checkWorkagentIdle(createWorkagentHost(engine), channel, msg, current), false);
assert.match(replies.at(-1), /已空闲超过 45 分钟/);
records.set(key, { ...records.get(key), pendingInput: null });
accountConfig.idleMinutes = undefined;
accountConfig.idlePolicy = "继续";
assert.equal(await checkWorkagentIdle(createWorkagentHost(engine), channel, msg, current), true);
accountConfig.idlePolicy = undefined;
await command("/空闲 0");
assert.equal(await checkWorkagentIdle(createWorkagentHost(engine), channel, msg, current), true);
console.log(
  JSON.stringify({
    passed: true,
    checks: [
      "unified task history",
      "unknown task rejected",
      "idle pending message",
      "pending owner",
      "retry preserves input",
      "native rename failure",
      "web task resume",
      "project picker",
      "idle default 30 minutes",
      "idle choice creates in default project",
      "idle auto-create uses default project",
      "account idle defaults apply without chat override",
      "idle disabled",
      "command prefix matching",
      "ambiguous prefix rejected",
      "new dialog session pager",
      "pager more until exhausted",
      "default dialog creates in default project",
    ],
  }),
);
