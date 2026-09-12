import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import {
  Dialog,
  ActionList,
} from "../packages/dsh-client-workagent/src/ui/dialog.js";
import {
  SidebarAction as Action,
  SidebarGroup as Group,
  SidebarHeader as Header,
  SidebarRow as Row,
  SidebarSearch as Search,
  SidebarStatus as Status,
} from "../packages/dsh-client-workagent/src/ui/sidebar.js";

const require = createRequire(
  new URL("../packages/dsh-client-workagent/package.json", import.meta.url),
);
const React = require("react");
const { JSDOM } = require("jsdom");
const source = readFileSync(
  process.env.WORKAGENT_SMOKE_IM_CLIENT ||
    resolve(".cache/sidebar-im-patch/lib/client.js"),
  "utf8",
);

test("channel rows use the app presentation and preserve selection, actions, rename and folding", async () => {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body><div id='test'></div></body></html>",
    { url: "http://localhost/?session=channel-session" },
  );
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    getComputedStyle: globalThis.getComputedStyle,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = require("react-dom/client");
  let plugin, Channel;
  const requests = [];
  const groups = [
    {
      id: "weixin",
      sessions: [
        {
          channel: "weixin",
          kind: "private",
          chatId: "raw-id",
          chatTitle: "raw-id",
          sessionId: "channel-session",
          title: "渠道对话",
          updatedAt: new Date().toISOString(),
          running: true,
        },
      ],
    },
  ];
  dom.window.__ModuleLoader__ = {
    load({ factory }) {
      plugin = factory((name) =>
        name === "@deepseek-ai/dsh-client-ui-primitives" ? {} : require(name),
      );
    },
  };
  runInNewContext(source, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    location: dom.window.location,
    localStorage: dom.window.localStorage,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { json: async () => ({ ok: true, groups }) };
    },
  });
  plugin.apply({
    slots: {
      inject(name, fn) {
        if (name === "sidebar.channels") fn();
      },
      register(_config, component) {
        Channel = component;
        return () => {};
      },
    },
    effect: () => {},
    locale: {
      bind: () => (key) => key,
      register: () => {},
      subscribe: () => () => {},
      getSnapshot: () => 0,
    },
    sessions: {},
    workspaces: {},
  });
  const container = dom.window.document.getElementById("test");
  const root = createRoot(container);
  const click = async (node) => {
    assert.ok(node);
    await React.act(async () => {
      node.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };
  try {
    await React.act(async () => {
      root.render(
        React.createElement(Channel, {
          selectedId: "channel-session",
          sidebarUI: {
            Action,
            Group,
            Header,
            Row,
            Search,
            Status,
            Dialog,
            ActionList,
          },
        }),
      );
    });
    const row = container.querySelector(
      "[data-channel-session='channel-session']",
    );
    assert.ok(row?.classList.contains("workagent-sidebar-session"));
    assert.equal(container.querySelector(".ima-n-sess"), null);
    assert.equal(
      row.querySelector(".is-main").getAttribute("aria-current"),
      "page",
    );
    assert.ok(row.querySelector("[role='img'].is-running"));
    assert.equal(container.textContent.includes("raw-id"), false);
    await click(row.querySelector("[aria-haspopup='dialog']"));
    assert.ok(
      container.querySelector("[data-workagent-dialog] .workagent-action-list"),
    );
    await click(container.querySelector(".workagent-action-list button"));
    const form = container.querySelector("form[data-workagent-dialog]");
    assert.ok(form);
    await React.act(async () => {
      form.dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    assert.ok(
      requests.some(
        ({ url, options }) =>
          url.endsWith("/sessions/rename") &&
          JSON.parse(options.body).sessionId === "channel-session",
      ),
    );
    const group = container.querySelector(
      ".workagent-sidebar-project-row .is-main",
    );
    await click(group);
    assert.equal(container.querySelector(".workagent-sidebar-session"), null);
    assert.equal(group.getAttribute("aria-expanded"), "false");
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.getComputedStyle = previous.getComputedStyle;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
