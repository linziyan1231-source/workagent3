import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const patch = readFileSync(
  new URL(
    "../../patches/@michengai__dsh-im-connect@0.1.30.patch",
    import.meta.url,
  ),
  "utf8",
).replaceAll("\r\n", "\n");
const directory = mkdtempSync(join(tmpdir(), "workagent-im-port-"));
const source = (name: string) => {
  const section = patch
    .split(`+++ b/lib/engine/${name}\n`)[1]
    ?.split("\ndiff --git ")[0];
  if (!section?.startsWith("@@ -0,0 "))
    throw new Error(`Expected complete owned IM module: ${name}`);
  return (
    section
      .split("\n")
      .filter((line) => line.startsWith("+"))
      .map((line) => line.slice(1))
      .join("\n") + "\n"
  );
};
beforeAll(() => {
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  for (const name of [
    "workagent-host.js",
    "workagent-notifications.js",
    "workagent-commands.js",
  ])
    writeFileSync(join(directory, name), source(name));
  // The two pure upstream ID operations form this fixture's dependency seam.
  // Full patch application and the real upstream router are separately exercised
  // by smoke-dsh-channel-routing against an isolated installed plugin.
  writeFileSync(
    join(directory, "session-id.js"),
    `
    export const sessionKeyOf = (channel, kind, chat) => [channel, kind, chat].join(':');
    export const isImSessionId = id => id.startsWith('im:') || id.startsWith('session-channel-');
  `,
  );
});
afterAll(() => rmSync(directory, { recursive: true }));
const load = (name: string) =>
  import(pathToFileURL(join(directory, name)).href);

async function fixture() {
  const { createWorkagentHost } = await load("workagent-host.js");
  const key = "weixin:dm:recipient";
  const dispose = vi.fn(async () => {});
  const old = {
    key,
    sessionId: "old",
    handle: { workagent: true, dispose, followup: vi.fn(async () => {}) },
  };
  const live = new Map([[key, old]]);
  const records = new Map<string, Record<string, unknown>>([
    [
      key,
      {
        sessionId: "old",
        title: "Previous",
        lastInputAt: "2026-01-01T00:00:00Z",
      },
    ],
  ]);
  const rows = [
    { id: "old", title: "Previous", active: false },
    { id: "new", title: "Next", active: false },
    { id: "archived", title: "Archived", active: false },
  ];
  const service = {
    handles: () => true,
    listSessionIds: () => ["old", "new"],
    activeChannel: () => key,
    history: () => rows,
    configuration: () => ({ provider: "workagent-codex" }),
    collaboration: { access: vi.fn(async () => {}) },
    resume: vi.fn(async (_key: string, sessionId: string) => ({
      sessionId,
      workagent: true,
      dispose: async () => {},
    })),
  };
  const engine = {
    ctx: { get: () => service },
    store: {
      get: (id: string) => records.get(id),
      upsert: (id: string, value: Record<string, unknown>) =>
        records.set(id, value),
    },
    resolveConfig: () => ({ provider: "workagent-codex" }),
    router: {
      live,
      isArchived: (id: string) => id === "archived",
      getOrCreate: async () => old,
      bindingForSession: vi.fn(() => old),
      followup: vi.fn(),
      rename: vi.fn(),
    },
    questions: new Set<string>(),
    broker: new Set<string>(),
    onSessionEvent: vi.fn(),
    inject: vi.fn(),
  };
  return {
    key,
    dispose,
    old,
    live,
    records,
    rows,
    service,
    engine,
    host: createWorkagentHost(engine),
  };
}

it("keeps business modules independent of private engine, context, store and handle layout", () => {
  for (const name of ["workagent-commands.js", "workagent-notifications.js"])
    expect(source(name)).not.toMatch(
      /\bengine\b|\.router\b|\.store\b|\.ctx\b|binding\.handle|live\.handle/,
    );
});

it("replaces one live handle after resume, preserving unrelated persistent fields", async () => {
  const f = await fixture();
  const { rebindNotificationTarget } = await load("workagent-notifications.js");
  await rebindNotificationTarget(
    f.host,
    { channelId: "weixin", kind: "dm", chatId: "recipient" },
    "new",
  );
  expect(f.live.get(f.key)?.sessionId).toBe("new");
  expect(f.records.get(f.key)).toMatchObject({
    sessionId: "new",
    title: "Next",
    pendingSelection: null,
    collaboration: null,
  });
  expect(f.dispose).toHaveBeenCalledTimes(1);
  expect(f.service.resume).toHaveBeenCalledTimes(1);
  await rebindNotificationTarget(
    f.host,
    { channelId: "weixin", kind: "dm", chatId: "recipient" },
    "new",
  );
  expect(f.dispose).toHaveBeenCalledTimes(1);
});

it("leaves the previous binding intact if resuming the notified session fails", async () => {
  const f = await fixture();
  const { rebindNotificationTarget } = await load("workagent-notifications.js");
  f.service.resume.mockRejectedValueOnce(new Error("runtime offline"));
  await expect(
    rebindNotificationTarget(
      f.host,
      { channelId: "weixin", kind: "dm", chatId: "recipient" },
      "new",
    ),
  ).rejects.toThrow("runtime offline");
  expect(f.live.get(f.key)).toBe(f.old);
  expect(f.records.get(f.key)?.sessionId).toBe("old");
  expect(f.dispose).not.toHaveBeenCalled();
});

it("does not take over pending input or an active task, and shared notifications retain the ordinary task", async () => {
  const f = await fixture();
  const { rebindNotificationTarget } = await load("workagent-notifications.js");
  const target = { channelId: "weixin", kind: "dm", chatId: "recipient" };
  f.host.update(f.key, { pendingInput: { text: "Keep my message" } });
  await rebindNotificationTarget(f.host, target, "new");
  expect(f.service.resume).not.toHaveBeenCalled();
  f.host.update(f.key, { pendingInput: null });
  f.rows[0]!.active = true;
  await rebindNotificationTarget(f.host, target, "new");
  expect(f.service.resume).not.toHaveBeenCalled();
  f.rows[0]!.active = false;
  await rebindNotificationTarget(f.host, target, "collaboration:discussion");
  expect(f.records.get(f.key)).toMatchObject({
    sessionId: "old",
    lastInputAt: "2026-01-01T00:00:00Z",
    collaboration: { conversationId: "discussion" },
  });
  expect(f.live.get(f.key)).toBe(f.old);
  expect(f.dispose).not.toHaveBeenCalled();
});

it("routes interactions and archived history through the adapter's pinned upstream operations", async () => {
  const f = await fixture();
  expect(f.host.history(f.key).map((row: { id: string }) => row.id)).toEqual([
    "old",
    "new",
  ]);
  expect(f.host.interactionBinding("old")).toBe(f.old);
  expect(f.host.interactionBinding("im:weixin:dm:legacy")).toBe(f.old);
  expect(f.host.interactionBinding("other-web-task")).toBeUndefined();
  f.engine.questions.add("old");
  expect(f.host.awaitingInteraction("old")).toBe(true);
  expect(f.host.awaitingInteraction("new")).toBe(false);
});
