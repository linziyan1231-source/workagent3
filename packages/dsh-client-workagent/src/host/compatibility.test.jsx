// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  closeMobileSidebar,
  installHostCompatibility,
} from "./compatibility.js";

const disposers = [];
function install(options = {}) {
  const navigate = vi.fn();
  const dispose = installHostCompatibility({ navigate, ...options });
  disposers.push(dispose);
  return { navigate, dispose };
}
beforeEach(() => {
  document.head.innerHTML = "<title>Harness</title>";
  document.body.innerHTML = "";
  document.documentElement.lang = "en";
  window.matchMedia = vi.fn(() => ({ matches: false }));
});
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  cleanup();
  vi.restoreAllMocks();
});

it("localizes only known host chrome and leaves messages, code, previews, titles and user controls unchanged", () => {
  document.body.innerHTML = `
    <aside class="hHd-Xa_root">
      <button class="hHd-Xa_brand" aria-label="新建会话"><svg></svg></button>
      <button class="hHd-Xa_newSession"><svg></svg><span>New Session</span></button>
      <div class="hHd-Xa_settingsArea"><button class="VOzbGW_trigger">Settings</button></div>
      <div class="hHd-Xa_regionArea"><button>New Session</button><span>Settings</span></div>
    </aside>
    <div class="VOzbGW_panel">
      <nav class="VOzbGW_nav"><div class="VOzbGW_navTitle">Settings</div>
        <button class="VOzbGW_navCell"><svg></svg><span>General</span></button>
        <button class="VOzbGW_navCell">Plugins</button>
      </nav>
      <div class="VOzbGW_header"><div class="VOzbGW_actions"><button>Open Config</button></div></div>
      <section class="VOzbGW_options"><button>Open Config</button><input placeholder="选择一个工作区开始"></section>
    </div>
    <main class="wSkVaW_root" data-phase="hero">
      <span class="pXSMma_headlineText">Into the Unknown</span>
      <textarea class="uV2eYG_input" placeholder="选择一个工作区开始">Settings</textarea>
      <span><button class="Sh0Q9G_trigger"><svg></svg><span>Workspace Write</span></button>
        <div role="menu"><button role="menuitem"><span>Read Only</span></button></div>
      </span>
      <div class="workagent-message"><p>Settings</p><p>Read Only</p><p>Into the Unknown</p><button>Open Config</button></div>
      <div class="gdEzaW_bubble"><span class="pXSMma_headlineText">Into the Unknown</span></div>
      <pre><code>Settings</code><span class="pXSMma_headlineText">Into the Unknown</span></pre>
      <div class="workagent-file-preview-pane"><span class="pXSMma_headlineText">Into the Unknown</span><button>Open Config</button></div>
      <div contenteditable="true"><span class="pXSMma_headlineText">Into the Unknown</span></div>
      <div role="menu"><button role="menuitem">Read Only</button></div>
    </main>`;
  const untouched = [
    ".hHd-Xa_regionArea",
    ".VOzbGW_options",
    ".workagent-message",
    ".gdEzaW_bubble",
    "pre",
    ".workagent-file-preview-pane",
    "[contenteditable]",
  ].map((selector) => [
    document.querySelector(selector),
    document.querySelector(selector).innerHTML,
  ]);
  const nav = document.querySelector(".VOzbGW_navCell");
  const icon = nav.querySelector("svg");
  const label = nav.querySelector("span");
  install();
  expect(document.querySelector(".hHd-Xa_newSession span").textContent).toBe(
    "新建会话",
  );
  expect(document.querySelector(".VOzbGW_trigger").textContent).toBe("设置");
  expect(label.textContent).toBe("通用设置");
  expect(nav.querySelector("svg")).toBe(icon);
  expect(nav.querySelector("span")).toBe(label);
  expect(document.querySelectorAll(".VOzbGW_navCell")[1].hidden).toBe(true);
  expect(document.querySelector(".VOzbGW_actions button").hidden).toBe(true);
  expect(
    document.querySelector("main > .pXSMma_headlineText").textContent,
  ).toBe("今天有什么安排？");
  expect(document.querySelector("textarea").placeholder).toBe(
    "发消息，描述你想完成的任务…",
  );
  expect(document.querySelector("textarea").value).toBe("Settings");
  expect(document.querySelector(".Sh0Q9G_trigger").textContent).toBe(
    "项目内读写",
  );
  expect(
    document.querySelector(".Sh0Q9G_trigger + [role=menu]").textContent,
  ).toBe("只读");
  expect(document.querySelector("main > [role=menu]").textContent).toBe(
    "Read Only",
  );
  for (const [element, html] of untouched) expect(element.innerHTML).toBe(html);
});

it("hides host config actions despite button display rules and restores their styles", () => {
  document.body.innerHTML = `
    <div class="VOzbGW_panel"><div class="VOzbGW_header"><div class="VOzbGW_actions">
      <button style="display: inline-flex">Open Config</button>
      <button>Other action</button>
    </div></div></div>`;
  const config = document.querySelector("button");
  const { dispose } = install();
  expect(config.style.display).toBe("none");
  expect(config.hidden).toBe(true);
  expect(document.querySelector("button:last-child").hidden).toBe(false);
  dispose();
  expect(config.style.display).toBe("inline-flex");
  expect(config.hidden).toBe(false);
});

it("keeps React controls mounted and their handlers intact across host rerenders", async () => {
  const selected = vi.fn();
  function Shell({ label, show = true }) {
    return (
      <div className="VOzbGW_panel">
        <nav className="VOzbGW_nav">
          {show && (
            <button className="VOzbGW_navCell" onClick={selected}>
              <svg />
              <span>{label}</span>
            </button>
          )}
        </nav>
      </div>
    );
  }
  const view = render(<Shell label="General" />);
  const button = view.container.querySelector("button");
  const span = button.querySelector("span");
  const { dispose } = install();
  fireEvent.click(button);
  expect(selected).toHaveBeenCalledOnce();
  view.rerender(<Shell label="Changed by host" />);
  await waitFor(() => expect(span.textContent).toBe("Changed by host"));
  view.rerender(<Shell label="General" />);
  await waitFor(() => expect(span.textContent).toBe("通用设置"));
  expect(view.container.querySelector("button")).toBe(button);
  view.rerender(<Shell label="General" show={false} />);
  await act(async () => {});
  view.rerender(<Shell label="General" />);
  await waitFor(() =>
    expect(view.container.querySelector("span").textContent).toBe("通用设置"),
  );
  dispose();
  expect(view.container.querySelector("span").textContent).toBe("General");
});

it("intercepts only host home controls, survives replacement, and removes its listener on disposal", async () => {
  const hostClick = vi.fn();
  function Shell({ label }) {
    return (
      <aside className="hHd-Xa_root">
        <button className="hHd-Xa_brand" onClick={hostClick}>
          <span>{label}</span>
        </button>
        <button className="hHd-Xa_newSession" onClick={hostClick}>
          New Session
        </button>
        <button onClick={hostClick}>Ordinary action</button>
      </aside>
    );
  }
  const view = render(<Shell label="Logo" />);
  const { navigate, dispose } = install();
  fireEvent.click(view.container.querySelector(".hHd-Xa_brand span"));
  fireEvent.click(view.container.querySelector(".hHd-Xa_newSession"));
  expect(navigate.mock.calls).toEqual([["/?frontend=dsh"], ["/?frontend=dsh"]]);
  expect(hostClick).not.toHaveBeenCalled();
  fireEvent.click(view.container.querySelector("button:last-child"));
  expect(hostClick).toHaveBeenCalledOnce();
  view.rerender(<Shell key="replacement" label="New logo" />);
  await act(async () => {});
  fireEvent.click(view.container.querySelector(".hHd-Xa_brand span"));
  expect(navigate).toHaveBeenCalledTimes(3);
  dispose();
  fireEvent.click(view.container.querySelector(".hHd-Xa_brand"));
  expect(navigate).toHaveBeenCalledTimes(3);
  expect(hostClick).toHaveBeenCalledTimes(2);
});

it("owns assets, observers and typography cleanup and supports a clean remount", async () => {
  const typography = vi.fn();
  const applyTypography = vi.fn(() => typography);
  const disconnect = vi.spyOn(window.MutationObserver.prototype, "disconnect");
  const { dispose } = install({
    pluginScript: "https://example.test/plugins/client.js?v=1",
    applyTypography,
  });
  expect(document.getElementById("workagent-dsw-tokens").href).toBe(
    "https://example.test/plugins/tokens.css",
  );
  expect(document.title).toBe("WorkAgent");
  expect(document.documentElement.lang).toBe("zh-CN");
  document.title = "Session title";
  await act(async () => {});
  expect(document.title).toBe("WorkAgent");
  dispose();
  dispose();
  expect(disconnect).toHaveBeenCalledTimes(2);
  expect(typography).toHaveBeenCalledOnce();
  expect(document.getElementById("workagent-dsw-tokens")).toBeNull();
  expect(document.title).toBe("Harness");
  expect(document.documentElement.lang).toBe("en");
  document.title = "After disposal";
  document.body.innerHTML =
    '<aside class="hHd-Xa_root"><button class="hHd-Xa_newSession">New Session</button></aside>';
  await act(async () => {});
  expect(document.title).toBe("After disposal");
  expect(document.querySelector("button").textContent).toBe("New Session");
  const remounted = install();
  fireEvent.click(document.querySelector("button"));
  expect(remounted.navigate).toHaveBeenCalledOnce();
  expect(document.querySelectorAll("#workagent-dsw-tokens")).toHaveLength(1);
});

it("does not remove an existing stylesheet or overwrite later host changes on disposal", () => {
  const asset = document.createElement("link");
  asset.id = "workagent-dsw-tokens";
  document.head.append(asset);
  document.body.innerHTML =
    '<aside class="hHd-Xa_root"><button class="hHd-Xa_brand" aria-label="New Session"></button></aside>';
  const { dispose } = install();
  document.title = "New host title";
  document.documentElement.lang = "fr";
  document.querySelector("button").setAttribute("aria-label", "New host label");
  dispose();
  expect(document.getElementById("workagent-dsw-tokens")).toBe(asset);
  expect(document.title).toBe("New host title");
  expect(document.documentElement.lang).toBe("fr");
  expect(document.querySelector("button").getAttribute("aria-label")).toBe(
    "New host label",
  );
});

it("closes only an open, non-transitioning mobile sidebar through the host layout API", () => {
  const layout = { toggleSidebar: vi.fn() };
  document.body.innerHTML = '<aside class="hHd-Xa_root"></aside>';
  closeMobileSidebar(layout);
  expect(layout.toggleSidebar).not.toHaveBeenCalled();
  window.matchMedia.mockReturnValue({ matches: true });
  closeMobileSidebar(layout);
  expect(layout.toggleSidebar).toHaveBeenCalledOnce();
  document.querySelector("aside").classList.add("hHd-Xa_collapsed");
  closeMobileSidebar(layout);
  document.querySelector("aside").className = "hHd-Xa_root hHd-Xa_fading";
  closeMobileSidebar(layout);
  expect(layout.toggleSidebar).toHaveBeenCalledOnce();
});
