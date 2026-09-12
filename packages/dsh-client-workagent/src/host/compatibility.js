// Selectors for the pinned DSH shell belong here, not in feature modules.
// Never translate a conversation tree or settings content: both contain user data.
const selectors = {
  sidebar: ".hHd-Xa_root:not(.hHd-Xa_collapsed):not(.hHd-Xa_fading)",
  home: ".hHd-Xa_root .hHd-Xa_brand, .hHd-Xa_root .hHd-Xa_newSession",
  settings:
    ".hHd-Xa_settingsArea .VOzbGW_trigger, .VOzbGW_panel .VOzbGW_navTitle",
  sections: ".VOzbGW_panel .VOzbGW_nav .VOzbGW_navCell",
  actions: ".VOzbGW_panel .VOzbGW_header .VOzbGW_actions button",
  headline: '.wSkVaW_root[data-phase="hero"] .pXSMma_headlineText',
  input: ".wSkVaW_root textarea.uV2eYG_input",
  permission: ".wSkVaW_root .Sh0Q9G_trigger",
};

const userContent = [
  "pre",
  "code",
  "[contenteditable]",
  ".gdEzaW_bubble",
  ".workagent-message",
  ".workagent-message-list",
  ".workagent-file-preview-pane",
  ".workagent-preview",
  '[data-slot="conversation.messages"]',
  "[data-workagent-user-content]",
].join(", ");
const shellLabels = {
  "New Session": "新建会话",
  新会话: "新建会话",
  Settings: "设置",
};
const permissionLabels = {
  "Workspace Write": "项目内读写",
  "Read Only": "只读",
  "Read only": "只读",
  "Full Access": "完全访问",
  "Full access": "完全访问",
};

export function closeSidebar(layout, browser = globalThis.window) {
  if (browser.document.querySelector(selectors.sidebar)) layout.toggleSidebar();
}

export function closeMobileSidebar(layout, browser = globalThis.window) {
  if (
    browser.matchMedia("(max-width: 760px)").matches &&
    browser.document.querySelector(selectors.sidebar)
  )
    layout.toggleSidebar();
}

/** Semantic sidebar state for the pinned DSH shell; detached views are closed. */
export function sidebarState(
  element = document.querySelector(".hHd-Xa_root"),
  browser = globalThis.window,
) {
  return {
    isOpen: () =>
      Boolean(element && !element.classList.contains("hHd-Xa_collapsed")),
    subscribe(listener) {
      if (!element) return () => {};
      const observer = new browser.MutationObserver(listener);
      observer.observe(element, {
        attributes: true,
        attributeFilter: ["class"],
      });
      return () => observer.disconnect();
    },
  };
}

export function isDarkTheme(doc = document) {
  return doc.body.hasAttribute("data-ds-dark-theme");
}

export function watchTheme(listener, browser = globalThis.window) {
  const observer = new browser.MutationObserver(() =>
    listener(isDarkTheme(browser.document)),
  );
  observer.observe(browser.document.body, {
    attributes: true,
    attributeFilter: ["data-ds-dark-theme"],
  });
  return () => observer.disconnect();
}

/** Install once from a Cordis effect; the returned disposer owns every resource. */
export function installHostCompatibility({
  navigate,
  pluginScript,
  applyTypography,
  window: browser = globalThis.window,
  document: doc = browser.document,
}) {
  const title = doc.title;
  const language = doc.documentElement.getAttribute("lang");
  const existingAsset = doc.getElementById("workagent-dsw-tokens");
  const asset = existingAsset ?? doc.createElement("link");
  if (!existingAsset) {
    asset.id = "workagent-dsw-tokens";
    asset.rel = "stylesheet";
    asset.href = pluginScript
      ? new URL("tokens.css", pluginScript).href
      : "/plugins/@workagent/dsh-client/tokens.css";
    doc.head.append(asset);
  }
  doc.documentElement.lang = "zh-CN";
  const releaseTypography = applyTypography?.();
  const changes = new Map();
  let disposed = false;

  // Keep React's text/element identities intact. Restore only changes that the
  // host has not subsequently replaced, including hidden shell controls.
  function patch(node, key, value, read, write) {
    const current = read();
    if (current === value) return;
    let fields = changes.get(node);
    if (!fields) changes.set(node, (fields = new Map()));
    const previous = fields.get(key);
    fields.set(key, {
      original:
        previous && current === previous.value ? previous.original : current,
      value,
      read,
      write,
    });
    write(value);
  }
  function attribute(element, name, value) {
    patch(
      element,
      name,
      value,
      () => element.getAttribute(name),
      (next) => {
        if (next === null) element.removeAttribute(name);
        else element.setAttribute(name, next);
      },
    );
  }
  function restore(fields) {
    for (const change of fields.values())
      if (change.read() === change.value) change.write(change.original);
  }
  function hide(element) {
    attribute(element, "hidden", "");
    // Host button styles set display explicitly, overriding the UA hidden rule.
    patch(
      element,
      "display",
      "none",
      () => element.style.display,
      (value) => {
        element.style.display = value;
      },
    );
  }
  function translate(element, labels) {
    const walker = doc.createTreeWalker(element, 4);
    let node;
    while ((node = walker.nextNode())) {
      const text = node;
      if (text.parentElement.closest(userContent)) continue;
      const label = text.data.trim();
      if (!Object.hasOwn(labels, label)) continue;
      patch(
        text,
        "text",
        text.data.replace(label, labels[label]),
        () => text.data,
        (value) => {
          text.data = value;
        },
      );
    }
  }
  function each(selector, visit) {
    for (const element of doc.querySelectorAll(selector))
      if (!element.closest(userContent)) visit(element);
  }
  function localizeShell() {
    if (disposed) return;
    for (const [node, fields] of changes) {
      if (node.isConnected) continue;
      restore(fields);
      changes.delete(node);
    }
    each(selectors.home, (button) => {
      translate(button, shellLabels);
      if (button.matches(".hHd-Xa_brand")) {
        attribute(button, "aria-label", "返回首页");
        attribute(button, "title", "返回首页");
      }
    });
    each(selectors.settings, (element) => translate(element, shellLabels));
    each(selectors.sections, (button) => {
      translate(button, { General: "通用设置" });
      if (["Plugins", "插件"].includes(button.textContent.trim())) hide(button);
    });
    each(selectors.actions, (button) => {
      if (["Open Config", "打开配置文件"].includes(button.textContent.trim()))
        hide(button);
    });
    each(selectors.headline, (element) =>
      translate(element, {
        探索未至之境: "今天有什么安排？",
        "Into the Unknown": "今天有什么安排？",
      }),
    );
    each(selectors.input, (field) => {
      if (field.placeholder === "选择一个工作区开始")
        attribute(field, "placeholder", "发消息，描述你想完成的任务…");
    });
    each(selectors.permission, (trigger) => {
      translate(trigger, permissionLabels);
      // The pinned PermissionSelect uses Menu's in-place wrapper (portal=false).
      // Its sibling menu belongs to this trigger; unrelated menus are untouched.
      for (const sibling of trigger.parentElement.children)
        if (sibling.matches('[role="menu"]'))
          translate(sibling, permissionLabels);
    });
  }
  function goHome(event) {
    const target =
      event.target.nodeType === 1 ? event.target : event.target.parentElement;
    const button = target?.closest(selectors.home);
    if (!button || button.closest(userContent)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    navigate("/?frontend=dsh");
  }
  const updateTitle = () => {
    if (!disposed && doc.title !== "WorkAgent") doc.title = "WorkAgent";
  };
  localizeShell();
  updateTitle();
  const shellObserver = new browser.MutationObserver(localizeShell);
  shellObserver.observe(doc.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["placeholder", "aria-label"],
  });
  const titleObserver = new browser.MutationObserver(updateTitle);
  titleObserver.observe(doc.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  doc.body.addEventListener("click", goHome, true);

  return () => {
    if (disposed) return;
    disposed = true;
    shellObserver.disconnect();
    titleObserver.disconnect();
    doc.body.removeEventListener("click", goHome, true);
    for (const fields of changes.values()) restore(fields);
    changes.clear();
    releaseTypography?.();
    if (!existingAsset) asset.remove();
    if (doc.title === "WorkAgent") doc.title = title;
    if (doc.documentElement.lang === "zh-CN") {
      if (language === null) doc.documentElement.removeAttribute("lang");
      else doc.documentElement.setAttribute("lang", language);
    }
  };
}
