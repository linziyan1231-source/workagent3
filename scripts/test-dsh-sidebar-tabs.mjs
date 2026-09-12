import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

// Exercise the actual profile plugin, before or after applying its package patch.
// WORKAGENT_SMOKE_IM_CLIENT can also point at an immutable release's client.
const require = createRequire(
  new URL("../packages/dsh-client-workagent/package.json", import.meta.url),
);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { JSDOM } = require("jsdom");
const source = readFileSync(
  process.env.WORKAGENT_SMOKE_IM_CLIENT ||
    resolve(
      ".cache/dsh-home/profiles/workagent/node_modules/@michengai/dsh-im-connect/lib/client.js",
    ),
  "utf8",
);
const h = React.createElement;
const Stock = () => h("span", null, "stock-tree");
const WorkAgent = () => h("span", null, "workagent-tree");
const entry = (id, component) => ({ options: { id }, component });

function setup(initial) {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body></body></html>",
    {
      url: "http://localhost/",
    },
  );
  let plugin,
    active = initial[0],
    rows = initial;
  const listeners = new Set(),
    localeListeners = new Set(),
    disposers = [];
  const slots = {
    entries: (key) => (key === "sidebar.workspaces" ? rows : []),
    entriesOfSlot: (key) =>
      key === "sidebar.workspaces" && active ? [active] : [],
    inject: (key, callback) => {
      if (key === "sidebar.workspaces") disposers.push(callback());
    },
    subscribe: (_key, fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const ctx = {
    slots,
    sessions: {},
    effect: (fn) => {
      const dispose = fn();
      if (dispose) disposers.push(dispose);
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
      subscribe: (fn) => {
        localeListeners.add(fn);
        return () => localeListeners.delete(fn);
      },
      getSnapshot: () => 0,
    },
  };
  runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load: ({ factory }) => {
          plugin = factory((name) =>
            name === "@deepseek-ai/dsh-client-ui-primitives"
              ? {}
              : require(name),
          );
        },
      },
    },
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    console,
    setTimeout,
    clearTimeout,
  });
  plugin.apply(ctx);
  return {
    choose(next, entries = rows) {
      rows = entries;
      active = next;
      for (const fn of listeners) fn();
    },
    html: () => renderToStaticMarkup(h(active.component, { wide: true })),
    dispose() {
      for (const fn of disposers.reverse()) fn();
      assert.equal(listeners.size, 0);
      assert.equal(localeListeners.size, 0);
      dom.window.close();
    },
  };
}

function assertTabs(env, tree) {
  const html = env.html();
  assert.equal((html.match(/role="tab"/g) || []).length, 2);
  assert.match(html, /rail.tasks/);
  assert.match(html, /rail.channels/);
  assert.ok(html.includes(tree));
}

test("late WorkAgent registration gets both tabs and restores the shadowed tree", () => {
  const stock = entry("stock", Stock),
    app = entry("workagent", WorkAgent);
  const env = setup([stock]);
  try {
    assertTabs(env, "stock-tree");
    env.choose(app, [app, stock]);
    assertTabs(env, "workagent-tree");
    assert.equal(stock.component, Stock);
    assert.equal(stock.__dshNativeTabs, undefined);
  } finally {
    env.dispose();
  }
});

test("WorkAgent registered first keeps one stable tab shell across notifications", () => {
  const app = entry("workagent", WorkAgent),
    stock = entry("stock", Stock);
  const env = setup([app, stock]);
  try {
    const shell = app.component;
    for (let i = 0; i < 4; i++) {
      env.choose(app);
      assertTabs(env, "workagent-tree");
    }
    assert.equal(app.component, shell);
    assert.equal(stock.component, Stock);
  } finally {
    env.dispose();
  }
  assert.equal(app.component, WorkAgent);
  assert.equal(app.__dshNativeTabs, undefined);
});

test("unload and re-registration follow the fallback without stale registry metadata", () => {
  const stock = entry("stock", Stock),
    app = entry("workagent", WorkAgent);
  const env = setup([stock]);
  try {
    env.choose(app, [app, stock]);
    env.choose(stock, [stock]);
    assertTabs(env, "stock-tree");
    assert.equal(app.component, WorkAgent);
    assert.equal(app.__dshNativeTabs, undefined);
    env.choose(app, [app, stock]);
    assertTabs(env, "workagent-tree");
    env.choose(undefined, []);
    assert.equal(app.component, WorkAgent);
  } finally {
    env.dispose();
  }
});

test("an abdicated first entry cannot retain tabs intended for the elected fallback", () => {
  const app = entry("workagent", WorkAgent),
    stock = entry("stock", Stock);
  const env = setup([app, stock]);
  try {
    env.choose(stock); // Raw inspection still includes the failed higher-priority entry.
    assertTabs(env, "stock-tree");
    assert.equal(app.component, WorkAgent);
  } finally {
    env.dispose();
  }
});

test("an outgoing mounted shell retains its own tree until React replaces it", () => {
  const stock = entry("stock", Stock),
    app = entry("workagent", WorkAgent);
  const env = setup([stock]);
  try {
    const outgoing = stock.component;
    env.choose(app, [app, stock]);
    assert.match(
      renderToStaticMarkup(h(outgoing, { wide: true })),
      /stock-tree/,
    );
    assertTabs(env, "workagent-tree");
  } finally {
    env.dispose();
  }
});

test("existing tab hosts receive only the channel contribution and retain their own tabs", () => {
  const tabs = new Map([["schedule", { id: "schedule" }]]);
  const registry = {
    getTabs: () => [...tabs.values()],
    insert: (tab) => {
      tabs.set(tab.id, tab);
      return () => tabs.delete(tab.id);
    },
  };
  const native = entry(
    "native",
    Object.assign(() => null, { __dshNativeTabs: registry }),
  );
  const app = entry("workagent", WorkAgent),
    stock = entry("stock", Stock);
  const env = setup([stock]);
  try {
    env.choose(native, [native, stock]);
    assert.deepEqual([...tabs.keys()], ["schedule", "channels"]);
    assert.equal(stock.component, Stock);
    env.choose(app, [app, native, stock]);
    assertTabs(env, "workagent-tree");
    assert.deepEqual([...tabs.keys()], ["schedule"]);
    env.choose(native, [native, stock]);
    assert.deepEqual([...tabs.keys()], ["schedule", "channels"]);
  } finally {
    env.dispose();
  }
  assert.deepEqual([...tabs.keys()], ["schedule"]);
});
