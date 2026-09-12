// HTTP installations expose getRandomValues but may lack randomUUID. DSH RPC
// bindings need this API as well as our attachment uploader.
if (typeof globalThis.crypto.randomUUID !== "function") {
  globalThis.crypto.randomUUID = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  };
}

window.__ModuleLoader__.load({
  id: "@workagent/dsh-client",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    var __create = Object.create;
    var __defProp = Object.defineProperty;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames = Object.getOwnPropertyNames;
    var __getProtoOf = Object.getPrototypeOf;
    var __hasOwnProp = Object.prototype.hasOwnProperty;
    var __export = (target, all) => {
      for (var name in all)
        __defProp(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps = (to, from, except, desc) => {
      if ((from && typeof from === "object") || typeof from === "function") {
        for (let key of __getOwnPropNames(from))
          if (!__hasOwnProp.call(to, key) && key !== except)
            __defProp(to, key, {
              get: () => from[key],
              enumerable:
                !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
            });
      }
      return to;
    };
    var __toESM = (mod, isNodeMode, target) => (
      (target = mod != null ? __create(__getProtoOf(mod)) : {}),
      __copyProps(
        // If the importer is in node compatibility mode or this is not an ESM
        // file that has been converted to a CommonJS file using a Babel-
        // compatible transform (i.e. "__esModule" has not been set), then set
        // "default" to the CommonJS "module.exports" for node compatibility.
        isNodeMode || !mod || !mod.__esModule
          ? __defProp(target, "default", { value: mod, enumerable: true })
          : target,
        mod,
      )
    );
    var __toCommonJS = (mod) =>
      __copyProps(__defProp({}, "__esModule", { value: true }), mod);

    // src/client.js
    var client_exports = {};
    __export(client_exports, {
      apply: () => apply,
      inject: () => inject,
    });
    module.exports = __toCommonJS(client_exports);

    // src/platform/api.js
    var apiRoot = "/api/runtime/v1";
    async function request(path, init) {
      const response = await fetch(path, {
        credentials: "same-origin",
        ...init,
        headers:
          init?.body === void 0
            ? init?.headers
            : { "Content-Type": "application/json", ...init.headers },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const error = new Error(body.error || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      if (response.status === 204) return void 0;
      const type = response.headers.get("content-type") || "";
      return type.includes("json") ? response.json() : response.text();
    }
    async function mutate(refresh, setError, path, method, value) {
      try {
        setError("");
        await request(path, {
          method,
          body: value === void 0 ? void 0 : JSON.stringify(value),
        });
        await refresh();
        return true;
      } catch (error) {
        setError(error.message);
        return false;
      }
    }

    // src/features/collaboration/personal-tasks.js
    function sharedTaskProject(params) {
      return params.get("workagent") === "shared" &&
        params.get("personal") === "new" &&
        !params.has("session")
        ? params.get("project")
        : null;
    }
    function personalTaskRoute(project, session) {
      return `/?workagent=shared&project=${encodeURIComponent(project)}&${session ? `session=${encodeURIComponent(session)}` : "personal=new"}`;
    }
    var endpoint = "/api/portal/shared-personal-tasks";
    var creating = /* @__PURE__ */ new Map();
    function createPersonalTask(project, options) {
      const configuration = JSON.stringify(options);
      const key = `workagent.personal-task.pending:${project.id}:${configuration}`;
      const activeKey = key;
      if (creating.has(activeKey)) return creating.get(activeKey);
      const run = (async () => {
        let pending;
        try {
          pending = JSON.parse(sessionStorage.getItem(key));
        } catch {}
        if (!pending || pending.configuration !== configuration)
          pending = { id: crypto.randomUUID(), configuration };
        sessionStorage.setItem(key, JSON.stringify(pending));
        let result = await request(endpoint, {
          method: "POST",
          body: JSON.stringify({
            operation_id: pending.id,
            project_id: project.id,
            options,
          }),
        });
        for (let attempt = 0; !result.session && attempt < 30; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1e3));
          result = await request(
            `${endpoint}?id=${encodeURIComponent(result.operation.id)}`,
          );
        }
        if (!result.session)
          throw new Error("个人任务正在后台创建，请稍后在协作中查看");
        sessionStorage.removeItem(key);
        window.dispatchEvent(new CustomEvent("workagent:shared-changed"));
        return result.session;
      })()
        .catch((error) => {
          if (error.status === 422 || error.status === 410)
            sessionStorage.removeItem(key);
          throw error;
        })
        .finally(() => creating.delete(activeKey));
      creating.set(activeKey, run);
      return run;
    }
    async function deletePersonalTask(conversationId, send = request) {
      await send(endpoint, {
        method: "DELETE",
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      window.dispatchEvent(new CustomEvent("workagent:shared-changed"));
    }

    // src/features/agents/api.js
    var import_react2 = __toESM(require("react"), 1);

    // src/platform/resources.js
    var import_react = __toESM(require("react"), 1);
    function useResource(endpoint2, select = (value) => value, cache2) {
      const cached = () => cache2?.get(endpoint2);
      const [state, setState] = import_react.default.useState(
        () =>
          cached() || {
            loading: true,
            rows: [],
            error: "",
          },
      );
      const resourceGeneration = import_react.default.useRef(0);
      const load = import_react.default.useCallback(
        async (signal, quiet = false) => {
          if (!endpoint2) return;
          const generation = ++resourceGeneration.current;
          if (!quiet && !cached())
            setState((value) => ({ ...value, loading: true, error: "" }));
          try {
            const value = await request(endpoint2, { signal });
            if (signal?.aborted || generation !== resourceGeneration.current)
              return;
            const selected = select(value);
            const next = {
              loading: false,
              rows: Array.isArray(selected)
                ? selected
                : selected == null
                  ? []
                  : [selected],
              error: "",
            };
            cache2?.set(endpoint2, next);
            setState(next);
          } catch (error) {
            if (signal?.aborted || generation !== resourceGeneration.current)
              return;
            if ([401, 403, 404].includes(error.status))
              cache2?.remove(endpoint2);
            if (error.name !== "AbortError")
              setState((value) => ({
                loading: false,
                rows:
                  quiet && ![401, 403, 404].includes(error.status)
                    ? value.rows
                    : [],
                error: error.message,
              }));
          }
        },
        [endpoint2],
      );
      import_react.default.useEffect(() => {
        const controller = new AbortController();
        setState(cached() || { loading: true, rows: [], error: "" });
        void load(controller.signal);
        return () => {
          resourceGeneration.current += 1;
          controller.abort();
        };
      }, [load]);
      const refresh = import_react.default.useCallback(
        () => load(void 0, true),
        [load],
      );
      return [state, refresh];
    }

    // src/features/agents/api.js
    var PRESETS_CHANGED_EVENT = "workagent:presets-changed";
    function usePresets(select) {
      const resource = useResource(`${apiRoot}/presets`, select);
      const refresh = resource[1];
      import_react2.default.useEffect(() => {
        const reload = () => void refresh();
        window.addEventListener(PRESETS_CHANGED_EVENT, reload);
        return () => window.removeEventListener(PRESETS_CHANGED_EVENT, reload);
      }, [refresh]);
      return resource;
    }
    async function mutatePreset(...args) {
      const saved = await mutate(...args);
      if (saved) window.dispatchEvent(new CustomEvent(PRESETS_CHANGED_EVENT));
      return saved;
    }

    // src/host/navigation-controller.js
    function createNavigation(React37, onNavigate = () => {}) {
      let notificationReturn = "/?frontend=dsh";
      const subscribe = (notify) => {
        window.addEventListener("popstate", notify);
        return () => window.removeEventListener("popstate", notify);
      };
      const snapshot = () => location.search;
      const useSearch = () => React37.useSyncExternalStore(subscribe, snapshot);
      function isAppURL(url) {
        return (
          url.origin === location.origin &&
          url.pathname === "/" &&
          (!url.searchParams.has("frontend") ||
            url.searchParams.get("frontend") === "dsh")
        );
      }
      function navigate(href) {
        const url = new URL(href, location.href);
        if (!isAppURL(url)) return location.assign(url.href);
        url.searchParams.set("frontend", "dsh");
        const tabSwitch =
          (url.searchParams.has("sidebar") &&
            !url.searchParams.has("session") &&
            !url.searchParams.has("project")) ||
          (url.searchParams.get("workagent") === "shared" &&
            !url.searchParams.has("discussion") &&
            !url.searchParams.has("session"));
        if (!tabSwitch) onNavigate();
        if (url.href === location.href) return;
        history.pushState(null, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
      function toggleNotifications() {
        if (
          new URLSearchParams(location.search).get("workagent") ===
          "notifications"
        ) {
          navigate(notificationReturn);
        } else {
          notificationReturn = location.pathname + location.search;
          navigate("/?workagent=notifications");
        }
      }
      function install() {
        const onClick = (event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          const anchor = event.target.closest?.("a[href]");
          if (
            !anchor ||
            anchor.hasAttribute("download") ||
            (anchor.target && anchor.target !== "_self")
          )
            return;
          const url = new URL(anchor.href, location.href);
          if (
            !isAppURL(url) ||
            (!url.searchParams.has("session") &&
              !url.searchParams.has("workagent") &&
              !url.searchParams.has("project"))
          )
            return;
          event.preventDefault();
          navigate(url.href);
        };
        document.addEventListener("click", onClick);
        return () => document.removeEventListener("click", onClick);
      }
      return { navigate, toggleNotifications, useSearch, install };
    }

    // src/host/navigation.js
    var import_react3 = __toESM(require("react"), 1);

    // src/host/compatibility.js
    var selectors = {
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
    var userContent = [
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
    var shellLabels = {
      "New Session": "新建会话",
      新会话: "新建会话",
      Settings: "设置",
    };
    var permissionLabels = {
      "Workspace Write": "项目内读写",
      "Read Only": "只读",
      "Read only": "只读",
      "Full Access": "完全访问",
      "Full access": "完全访问",
    };
    function closeSidebar(layout2, browser = globalThis.window) {
      if (browser.document.querySelector(selectors.sidebar))
        layout2.toggleSidebar();
    }
    function closeMobileSidebar(layout2, browser = globalThis.window) {
      if (
        browser.matchMedia("(max-width: 760px)").matches &&
        browser.document.querySelector(selectors.sidebar)
      )
        layout2.toggleSidebar();
    }
    function sidebarState(
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
    function isDarkTheme(doc = document) {
      return doc.body.hasAttribute("data-ds-dark-theme");
    }
    function watchTheme(listener, browser = globalThis.window) {
      const observer = new browser.MutationObserver(() =>
        listener(isDarkTheme(browser.document)),
      );
      observer.observe(browser.document.body, {
        attributes: true,
        attributeFilter: ["data-ds-dark-theme"],
      });
      return () => observer.disconnect();
    }
    function installHostCompatibility({
      navigate,
      pluginScript: pluginScript2,
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
        asset.href = pluginScript2
          ? new URL("tokens.css", pluginScript2).href
          : "/plugins/@workagent/dsh-client/tokens.css";
        doc.head.append(asset);
      }
      doc.documentElement.lang = "zh-CN";
      const releaseTypography = applyTypography?.();
      const changes = /* @__PURE__ */ new Map();
      let disposed = false;
      function patch(node, key, value, read, write) {
        const current = read();
        if (current === value) return;
        let fields = changes.get(node);
        if (!fields) changes.set(node, (fields = /* @__PURE__ */ new Map()));
        const previous = fields.get(key);
        fields.set(key, {
          original:
            previous && current === previous.value
              ? previous.original
              : current,
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
          if (["Plugins", "插件"].includes(button.textContent.trim()))
            hide(button);
        });
        each(selectors.actions, (button) => {
          if (
            ["Open Config", "打开配置文件"].includes(button.textContent.trim())
          )
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
          for (const sibling of trigger.parentElement.children)
            if (sibling.matches('[role="menu"]'))
              translate(sibling, permissionLabels);
        });
      }
      function goHome(event) {
        const target =
          event.target.nodeType === 1
            ? event.target
            : event.target.parentElement;
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

    // src/host/navigation.js
    var layout;
    function closeMobileSidebar2() {
      closeMobileSidebar(layout);
    }
    var navigation = createNavigation(
      import_react3.default,
      closeMobileSidebar2,
    );
    function closeSidebar2() {
      closeSidebar(layout);
    }
    function bindLayout(value) {
      layout = value;
    }

    // src/features/agents/avatars.js
    async function readAssistantAvatar(file) {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type))
        throw new Error("请选择 PNG、JPG、WebP 或 GIF 图片");
      if (file.size > 5 * 1024 * 1024)
        throw new Error("请选择不超过 5 MB 的图片");
      const url = URL.createObjectURL(file);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 128;
        const edge = Math.min(image.naturalWidth, image.naturalHeight);
        canvas
          .getContext("2d")
          .drawImage(
            image,
            (image.naturalWidth - edge) / 2,
            (image.naturalHeight - edge) / 2,
            edge,
            edge,
            0,
            0,
            128,
            128,
          );
        const result = canvas.toDataURL("image/webp", 0.85);
        if (result.length > 65536)
          throw new Error("图片内容过于复杂，请换一张图片");
        return result;
      } catch (error) {
        throw new Error(
          error.message?.startsWith("图片内容")
            ? error.message
            : "无法读取图片，请换一张图片",
        );
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    function createAssistantAvatars({
      React: React37,
      EngineMark: EngineMark2,
      request: request2,
      apiRoot: apiRoot2,
    }) {
      const h33 = React37.createElement;
      const choices = [
        "✨",
        "🤖",
        "🦊",
        "🐼",
        "🐱",
        "🦉",
        "🎨",
        "💡",
        "🌿",
        "🚀",
        "📚",
        "💻",
      ];
      const colors = [
        "var(--workagent-avatar-lilac)",
        "var(--workagent-avatar-mint)",
        "var(--workagent-avatar-peach)",
        "var(--workagent-avatar-sky)",
        "var(--workagent-avatar-rose)",
        "var(--workagent-avatar-cream)",
      ];
      let presets = /* @__PURE__ */ new Map();
      let loading;
      let loaded = false;
      const listeners = /* @__PURE__ */ new Set();
      const refresh = () => {
        if (loading) return loading;
        loading = request2(`${apiRoot2}/presets`)
          .then((rows) => {
            presets = new Map(rows.map((row) => [row.id, row]));
            loaded = true;
            for (const listener of listeners) listener();
          })
          .catch(() => {})
          .finally(() => {
            loading = null;
          });
        return loading;
      };
      const subscribe = (listener) => {
        if (!listeners.size)
          window.addEventListener("workagent:presets-changed", refresh);
        listeners.add(listener);
        if (!loaded) void refresh();
        return () => {
          listeners.delete(listener);
          if (!listeners.size) {
            window.removeEventListener("workagent:presets-changed", refresh);
            loaded = false;
          }
        };
      };
      function AssistantAvatar2({ preset, size }) {
        const avatar = preset?.avatar;
        const [failed, setFailed] = React37.useState(null);
        const style = {
          ...(size ? { width: size, height: size } : {}),
          overflow: "hidden",
          fontSize: size ? size * 0.48 : "0.85em",
        };
        const image =
          avatar &&
          /^(https?:\/\/|\/(?!\/)|data:image\/(png|jpeg|webp|gif);base64,)/i.test(
            avatar,
          );
        if (image && failed !== avatar)
          return h33("img", {
            className: "workagent-engine-mark workagent-assistant-avatar",
            style: { ...style, objectFit: "cover", background: "transparent" },
            src: avatar,
            alt: "",
            referrerPolicy: "no-referrer",
            onError: () => setFailed(avatar),
          });
        const builtinEngine = [
          "builtin-codex",
          "builtin-kimi",
          "builtin-general",
        ].includes(preset?.id);
        if (!avatar && (builtinEngine || !preset?.name))
          return h33(EngineMark2, { engine: preset?.engine || "harness" });
        const name = preset?.name || "助手";
        const text = avatar?.startsWith("emoji:")
          ? avatar.slice(6, 22)
          : preset?.id === "builtin-puxin-butler"
            ? "✨"
            : Array.from(name.trim())[0];
        const color = colors[(name.codePointAt(0) || 0) % colors.length];
        return h33(
          "span",
          {
            className: "workagent-engine-mark workagent-assistant-avatar",
            "aria-hidden": true,
            style: {
              ...style,
              background: color,
              color: "var(--workagent-avatar-ink)",
              fontWeight: 600,
            },
          },
          text,
        );
      }
      function SessionAvatar2({ session }) {
        const rows = React37.useSyncExternalStore(subscribe, () => presets);
        const snapshot = session?.preset?.resolvedSnapshot;
        const id = session?.preset?.presetId;
        const preset =
          rows.get(id) ||
          snapshot ||
          rows.get(
            `builtin-${session?.engine === "harness" ? "general" : session?.engine}`,
          );
        return h33(AssistantAvatar2, {
          preset: preset || { engine: session?.engine },
        });
      }
      function AvatarPicker2({
        preset,
        value,
        onChange,
        disabled = false,
        onBusyChange,
      }) {
        const [busy, setBusy] = React37.useState(false);
        React37.useEffect(() => {
          onBusyChange?.(busy);
        }, [busy, onBusyChange]);
        const [error, setError] = React37.useState("");
        const input = React37.useRef();
        const change = async (next) => {
          setBusy(true);
          setError("");
          try {
            await onChange(next);
          } catch (error2) {
            setError(error2.message);
          } finally {
            setBusy(false);
          }
        };
        return h33(
          "div",
          {
            className: "workagent-avatar-picker",
            style: { display: "grid", gap: 10 },
          },
          h33(
            "div",
            {
              style: {
                display: "flex",
                gap: 12,
                alignItems: "center",
                flexWrap: "wrap",
              },
            },
            h33(AssistantAvatar2, {
              preset: { ...preset, avatar: value },
              size: 48,
            }),
            h33(
              "button",
              {
                type: "button",
                className: "workagent-button",
                disabled: busy || disabled,
                onClick: () => input.current.click(),
              },
              busy ? "正在处理…" : "上传头像",
            ),
            h33(
              "button",
              {
                type: "button",
                className: "workagent-button",
                disabled: busy || disabled || !value,
                onClick: () => change(null),
              },
              "恢复默认",
            ),
            h33("input", {
              ref: input,
              type: "file",
              accept: "image/png,image/jpeg,image/webp,image/gif",
              "aria-label": "上传助手头像",
              hidden: true,
              onChange: async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setBusy(true);
                setError("");
                try {
                  await onChange(await readAssistantAvatar(file));
                } catch (error2) {
                  setError(error2.message);
                } finally {
                  setBusy(false);
                }
              },
            }),
          ),
          h33(
            "div",
            {
              role: "group",
              "aria-label": "预设头像",
              style: { display: "flex", gap: 6, flexWrap: "wrap" },
            },
            ...choices.map((emoji) =>
              h33(
                "button",
                {
                  key: emoji,
                  type: "button",
                  className: "workagent-button",
                  "aria-label": `使用${emoji}头像`,
                  "aria-pressed": value === `emoji:${emoji}`,
                  disabled: busy || disabled,
                  onClick: () => change(`emoji:${emoji}`),
                  style: {
                    padding: 8,
                    background:
                      value === `emoji:${emoji}`
                        ? "var(--workagent-avatar-selected)"
                        : void 0,
                  },
                },
                emoji,
              ),
            ),
          ),
          h33(
            "small",
            { className: "workagent-muted" },
            "支持 5 MB 以内的图片，自动居中裁为方形；GIF 使用静态画面。",
          ),
          error
            ? h33("p", { role: "alert", className: "workagent-error" }, error)
            : null,
        );
      }
      function AvatarField2({ preset, onBusyChange }) {
        const [value, setValue] = React37.useState(preset?.avatar || null);
        return h33(
          "div",
          null,
          h33("div", null, "头像"),
          h33("input", { type: "hidden", name: "avatar", value: value || "" }),
          h33(AvatarPicker2, {
            preset: preset || { name: "新助手", source: "user" },
            value,
            onChange: setValue,
            onBusyChange,
          }),
        );
      }
      return {
        AssistantAvatar: AssistantAvatar2,
        SessionAvatar: SessionAvatar2,
        AvatarPicker: AvatarPicker2,
        AvatarField: AvatarField2,
      };
    }

    // src/ui/icons.js
    var import_react4 = require("react");
    var iconPaths = {
      settings: [
        "M8 12h10m8 0h14M8 24h22m8 0h2M8 36h4m8 0h20M18 7v10m12 2v10M12 31v10",
      ],
      assistants: [
        "M15 14H33A7 7 0 0 1 40 21V33A7 7 0 0 1 33 40H15A7 7 0 0 1 8 33V21A7 7 0 0 1 15 14Z",
        "M24 14V6H29",
        "M17 23V25M31 23V25",
        "M18 32Q24 37 30 32",
        "M3 23V31M45 23V31",
      ],
      tasks: [
        "M23.9998 44.3332C34.1251 44.3332 42.3332 36.1251 42.3332 25.9999C42.3332 15.8747 34.1251 7.66656 23.9998 7.66656C13.8746 7.66656 5.6665 15.8747 5.6665 25.9999C5.6665 36.1251 13.8746 44.3332 23.9998 44.3332Z",
        "M23.76 15.35V26.36L31.53 34.13",
        "M4 9L11 4",
        "M44 9L37 4",
      ],
      chatgpt: [
        "M4 6H44V36H29L24 41L19 36H4V6Z",
        "M13 21H15",
        "M23 21H25",
        "M33 21H35",
      ],
      chat: ["M8 8H40V32H26L16 42V32H8V8Z", "M17 20H31", "M17 26H27"],
      teams: [
        "M18 26C23.5228 26 28 21.5228 28 16C28 10.4772 23.5228 6 18 6C12.4772 6 8 10.4772 8 16C8 21.5228 12.4772 26 18 26Z",
        "M30 10C34.4183 10 38 13.5817 38 18C38 22.4183 34.4183 26 30 26",
        "M2 42C2 34.268 8.26801 28 16 28H20C27.732 28 34 34.268 34 42",
        "M32 29C39.732 29 46 35.268 46 43",
      ],
      notifications: [
        "M8 19C8 10.1634 15.1634 3 24 3C32.8366 3 40 10.1634 40 19V31L44 38H4L8 31V19Z",
        "M18 42H30",
      ],
      workspace: [
        "M4 9V41L9 21H39.5V15C39.5 13.8954 38.6046 13 37.5 13H24L19 7H6C4.89543 7 4 7.89543 4 9Z",
        "M40 41L44 21H8.8125L4 41H40Z",
      ],
      theme: [
        "M42 29.5C39.5 39 30.9 44 21.5 42C10.9 39.8 4.1 29.4 6.3 18.8C8 10.7 14.6 4.5 22.6 3C17 9.8 17.9 19.8 24.8 25.5C29.7 29.5 36.2 30.7 42 29.5Z",
      ],
      logout: [
        "M24 44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44Z",
        "M29.6567 18.3432L18.343 29.6569",
        "M18.3433 18.3432L29.657 29.6569",
      ],
      harness: [
        "M12 18H36V34H12V18Z",
        "M18 25H20",
        "M28 25H30",
        "M24 18V11",
        "M20 39H28",
      ],
      back: ["M30 10L16 24L30 38"],
      close: ["M13 13L35 35", "M35 13L13 35"],
      trash: [
        "M8 12H40M18 12V6H30V12",
        "M12 12L15 42H33L36 12",
        "M20 20V33M28 20V33",
      ],
      search: [
        "M21 8C13.8203 8 8 13.8203 8 21C8 28.1797 13.8203 34 21 34C28.1797 34 34 28.1797 34 21C34 13.8203 28.1797 8 21 8Z",
        "M31 31L41 41",
      ],
      pin: ["M17 7H31L29 20L36 28H12L19 20Z", "M24 28V42"],
      shared: ["M5 14H20L25 20H43L39 40H5Z", "M25 8H41M33 3V13"],
      plus: ["M24 10V38", "M10 24H38"],
      chevronDown: ["M14 19L24 29L34 19"],
      chevronRight: ["M19 14L29 24L19 34"],
      check: ["M9 25L19 35L39 14"],
      list: ["M8 12H10M18 12H40", "M8 24H10M18 24H40", "M8 36H10M18 36H40"],
      edit: ["M30 8L40 18L19 39L7 41L9 29Z", "M25 13L35 23"],
      copy: ["M17 17H40V41H17Z", "M30 17V7H7V30H17"],
      branch: [
        "M12 16V32M12 26C12 20 36 28 36 16",
        "M12 6A5 5 0 1 0 12 16A5 5 0 1 0 12 6",
        "M12 32A5 5 0 1 0 12 42A5 5 0 1 0 12 32",
        "M36 6A5 5 0 1 0 36 16A5 5 0 1 0 36 6",
      ],
      refresh: ["M39 17A17 17 0 1 0 40 30", "M39 6V18H27"],
      file: ["M12 5H28L38 15V43H12Z", "M28 5V15H38", "M19 25H31M19 33H29"],
      upload: ["M24 32V6M14 16L24 6L34 16", "M8 31V42H40V31"],
      download: ["M24 6V32M14 22L24 32L34 22", "M8 35V42H40V35"],
      more: ["M10 24H11M23 24H24M36 24H37"],
      send: ["M24 39V9M10 23L24 9L38 23"],
      stop: ["M13 13H35V35H13Z"],
      steer: ["M10 39V29Q10 19 24 19H38M28 9L38 19L28 29"],
      expand: ["M7 19V7H19M29 7H41V19M41 29V41H29M19 41H7V29"],
    };
    function Icon({ name, size = 18, className = "" }) {
      return (0, import_react4.createElement)(
        "svg",
        {
          className: ["workagent-icon", className].filter(Boolean).join(" "),
          width: size,
          height: size,
          viewBox: "0 0 48 48",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 3,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": true,
        },
        ...(iconPaths[name] || iconPaths.harness).map((d, index) =>
          (0, import_react4.createElement)("path", { d, key: index }),
        ),
      );
    }
    function EngineMark({ engine }) {
      return (0, import_react4.createElement)(
        "span",
        {
          className: `workagent-engine-mark is-${engine}`,
          "aria-hidden": true,
        },
        engine === "codex"
          ? (0, import_react4.createElement)(
              "svg",
              { viewBox: "0 0 24 24", "aria-hidden": true },
              (0, import_react4.createElement)("circle", {
                cx: 12,
                cy: 12,
                r: 9,
              }),
              (0, import_react4.createElement)("path", {
                d: "M8 9l3 3-3 3M13 15h3",
              }),
            )
          : engine === "kimi"
            ? (0, import_react4.createElement)(
                "svg",
                { viewBox: "0 0 24 24", "aria-hidden": true },
                (0, import_react4.createElement)("path", {
                  d: "M6 4v16M18 4l-8 8 8 8M11 4l7 7",
                }),
              )
            : (0, import_react4.createElement)(
                "svg",
                {
                  className: "workagent-deepseek-mark",
                  viewBox: "0 0 50 50",
                  "aria-hidden": true,
                },
                // DeepSeek mark from the bundled DSH frontend favicon.
                (0, import_react4.createElement)("path", {
                  d: "M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z",
                }),
              ),
      );
    }

    // src/features/agents/avatar-components.js
    var import_react5 = __toESM(require("react"), 1);
    var { AssistantAvatar, SessionAvatar, AvatarPicker, AvatarField } =
      createAssistantAvatars({
        React: import_react5.default,
        EngineMark,
        request,
        apiRoot,
      });

    // ../contracts/dist/upload-policy.js
    var MAX_UPLOAD_BYTES = 5 * 1024 ** 3;
    var UPLOAD_SIZE_LABEL = `${MAX_UPLOAD_BYTES / 1024 ** 3} GB`;
    var UPLOAD_TOO_LARGE_MESSAGE = `超过 ${UPLOAD_SIZE_LABEL}`;

    // src/ui/labels.js
    var valueLabels = {
      builtin: "系统内置",
      user: "用户添加",
      market: "技能市场",
      ready: "可用",
      healthy: "运行正常",
      unknown: "未知状态",
      disabled: "已停用",
      unavailable: "不可用",
      none: "无需授权",
      needs_auth: "需要授权",
      needs_review: "需要确认",
      pending: "等待中",
      queued: "排队中",
      running: "运行中",
      completed: "已完成",
      failed: "失败",
      cancelled: "已取消",
      independent_sessions: "独立会话",
      harness: "通用引擎",
      codex: "Codex",
      kimi: "Kimi",
      "codex-native": "Codex 原生模型",
      "harness-default": "通用默认模型",
      "kimi-native": "Kimi 原生模型",
      "team.updated": "团队已更新",
      "member.added": "已添加成员",
      "task.queued": "任务已排队",
      "task.started": "任务已开始",
      "task.completed": "任务已完成",
      "task.failed": "任务失败",
      "task.cancelled": "任务已取消",
      "mail.received": "收到团队消息",
    };
    var displayValue = (value, fallback = "") =>
      valueLabels[value] || value || fallback;
    var displayPresetName = (name) => (name === "General" ? "DSH" : name);
    var displayWorkspaceName = (name) => {
      if (name === "Personal workspace") return "个人项目";
      const qa = /^QA wa3acc-([a-z])$/i.exec(name);
      return qa ? `测试项目 ${qa[1].toUpperCase()}` : name;
    };
    var displaySessionTitle = (title) =>
      title === "General" ? "通用会话" : title;
    var plainSessionTitle = (value) =>
      String(value).replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
    var friendlyError = (value) => {
      const message = String(value || "");
      if (/high demand|overloaded|server.*busy/i.test(message))
        return "模型服务当前繁忙，请稍后重试，或在模型设置中选择其他模型。";
      if (message.startsWith("credential_needs_auth:codex"))
        return "Codex 尚未完成登录，请先在设置中连接 Codex。";
      if (message.startsWith("credential_needs_auth:kimi"))
        return "Kimi 尚未完成登录，请先在设置中连接 Kimi。";
      if (message.startsWith("unsupported_preset_approval_policy:"))
        return "此引擎无法执行助手要求的审批策略，请调整助手配置或选择明确支持的权限。";
      const labels = {
        session_close_failed: "对话暂时无法删除，请稍后重试。",
        engine_unavailable: "所选助手当前不可用，请检查引擎设置。",
        engine_start_failed: "助手启动失败，请检查引擎状态后重试。",
        engine_turn_rejected: "助手没有接受这条消息，请稍后重试。",
        quota_exceeded: "使用额度不足，请联系管理员调整额度，或等待下一周期。",
        quota_usage_stale: "用量统计服务暂不可用，请稍后重试。",
        quota_usage_pending: "上一轮用量正在结算，请稍后重试。",
        quota_not_configured: "此模型尚未配置使用额度，请联系管理员。",
        platform_quota_unconfigured: "额度服务尚未配置，请联系管理员。",
        engine_steer_rejected:
          "追加指令未被接受；任务可能已结束，请检查状态后重新发送。",
        no_active_turn: "当前任务已结束，请直接发送消息。",
        queued_message_not_found: "这条排队消息已发送或移除，请刷新列表。",
        session_input_pending: "当前会话正在处理另一条指令，请稍候。",
        edit_stop_timeout: "原任务仍在停止中，请等它结束后重试编辑。",
        fork_message_not_found: "找不到这条消息，请刷新会话后重试。",
        session_resume_failed: "恢复会话失败，请重新开始一个会话。",
        workspace_not_found: "所选项目不存在，请重新选择。",
        invalid_session: "会话参数无效，请重新选择助手和项目。",
        unsupported_preset_tool_allowlist:
          "此引擎无法执行助手的工具限制，任务尚未启动，请调整助手配置。",
        preset_workspace_required: "此助手要求指定项目，请先选择一个项目。",
        engine_permission_unavailable:
          "此引擎无法提供所选权限，任务尚未启动，请调整权限或更换引擎。",
        personal_task_already_deleted:
          "此个人任务已删除，请重新提交以创建新任务。",
        personal_task_retry_pending: "任务操作已记录，服务恢复后会继续处理。",
        content_required: "请输入要发送的内容。",
        invalid_move: "不能移入自身或子文件夹，也不能移动系统目录。",
        ambiguous_file_reference:
          "此旧路径对应多份历史文件，请从项目文件中选择所需文件。",
        move_not_pending: "此移动已处理，请刷新查看。",
        move_not_completed: "此移动尚未完成，暂时不能撤销。",
        destination_exists: "同名文件已存在，请换一个名称。",
        workspace_directory_exists:
          "工作区中已存在同名文件夹，请换一个项目名称。",
        invalid_workspace_name:
          "项目名称不能包含路径或特殊字符，也不能使用系统保留名称。",
        file_changed: "文件已被其他操作修改。请重新打开文件，确认后再编辑。",
        unsupported_text_encoding:
          "在线编辑仅支持 UTF-8 文本，请下载后使用对应编码的编辑器修改。",
        file_not_found: "文件已不存在，请刷新列表。",
        invalid_relative_path: "文件名或路径无效。",
        workspace_operation_failed: "文件操作失败，请刷新后重试。",
        request_too_large: UPLOAD_TOO_LARGE_MESSAGE,
        path_outside_workspace: "文件路径必须位于当前项目内。",
        reparse_point_rejected: "无法操作链接到项目外的文件。",
        im_gateway_unavailable: "消息渠道服务暂未启用。",
        market_unavailable: "市场暂时不可用，请稍后重试。",
        market_version_exists: "这个名称和版本已经发布，请填写新的版本号。",
        market_credentials_required: "请填写所需的连接凭据。",
        market_source_not_found: "所选内容已不存在，请重新选择。",
        market_builtin_dependency_unavailable:
          "当前账号缺少内置依赖，请联系管理员配置后重试。",
        market_skill_dependency_missing: "助手引用的技能不存在，请先修复绑定。",
        market_mcp_dependency_missing: "引用的 MCP 服务不存在，请先修复绑定。",
        market_mcp_url_contains_credentials:
          "服务地址含有密钥或密码，请先改为使用独立连接凭据。",
        market_mcp_command_not_portable:
          "MCP 使用了本机绝对路径，请先改成可在其他成员环境中运行的命令。",
        market_publish_own_assistant_only: "请发布自己创建的助手。",
        market_publish_own_skill_only:
          "内置技能无需重复发布，可以作为助手依赖共享。",
        market_skill_snapshot_unavailable:
          "此技能的原发布包不可用，请重新获取后再发布。",
        market_bundle_too_large: "包含的技能文件超过 50 MB，请缩小发布包。",
        invalid_market_publish:
          "请完整填写发布内容和三段式版本号，例如 1.0.0。",
      };
      if (message?.startsWith("market_runtime_"))
        return "安装或发布未完成，请检查依赖配置后重试；已经完成的安装步骤会保留。";
      if (message?.startsWith("invalid_mcp_binding:"))
        return "绑定的 MCP 尚未就绪，请先测试连接或完成授权。";
      if (message?.startsWith("invalid_skill_binding:"))
        return "绑定的技能尚未就绪，请先启用技能并检查依赖。";
      return labels[message] || message || "操作失败，请稍后重试。";
    };
    var reasoningLabel = (option) =>
      ({
        none: "无",
        minimal: "最低",
        low: "低",
        medium: "中",
        high: "高",
        xhigh: "极高",
        max: "最高",
        ultra: "极高",
        off: "关闭",
        thinking: "开启",
        on: "开启",
      })[option.id] ||
      option.name ||
      option.id;

    // src/ui/elements.js
    var import_react6 = require("react");
    function Field({ label, children, className, ...props }) {
      return (0, import_react6.createElement)(
        "label",
        {
          ...props,
          className: ["workagent-field", className].filter(Boolean).join(" "),
        },
        label,
        children,
      );
    }
    function Input({ className, ...props }) {
      return (0, import_react6.createElement)("input", {
        ...props,
        "data-dialog-autofocus": props.autoFocus ? "" : void 0,
        className: ["workagent-control", className].filter(Boolean).join(" "),
      });
    }
    function Select({ options, heading, className, ...props }) {
      const choices = options.map(([value, label]) =>
        (0, import_react6.createElement)(
          "option",
          { value, key: value },
          label,
        ),
      );
      return (0, import_react6.createElement)(
        "select",
        {
          ...props,
          className: ["workagent-control", className].filter(Boolean).join(" "),
        },
        ...(heading
          ? [
              (0, import_react6.createElement)(
                "optgroup",
                { label: heading },
                choices,
              ),
            ]
          : choices),
      );
    }
    function Button({ children, className, variant, ...props }) {
      return (0, import_react6.createElement)(
        "button",
        {
          type: "button",
          ...props,
          "data-dialog-autofocus": props.autoFocus ? "" : void 0,
          className: ["workagent-button", variant && `is-${variant}`, className]
            .filter(Boolean)
            .join(" "),
        },
        children,
      );
    }
    function Switch({ checked, onChange, className, ...props }) {
      return (0, import_react6.createElement)("button", {
        type: "button",
        ...props,
        role: "switch",
        "aria-checked": checked,
        className: ["workagent-switch", className].filter(Boolean).join(" "),
        onClick: () => onChange(!checked),
      });
    }
    function Status({ state }) {
      if (state.loading)
        return (0, import_react6.createElement)(
          "p",
          { className: "workagent-muted" },
          "加载中…",
        );
      if (state.error)
        return (0, import_react6.createElement)(
          "p",
          { role: "alert", className: "workagent-error" },
          friendlyError(state.error),
        );
      if (state.rows.length === 0)
        return (0, import_react6.createElement)(
          "p",
          { className: "workagent-muted" },
          "暂无数据",
        );
      return null;
    }
    function Card({ title, detail, children, ...props }) {
      return (0, import_react6.createElement)(
        "article",
        {
          ...props,
          className: ["workagent-card", props.className]
            .filter(Boolean)
            .join(" "),
        },
        (0, import_react6.createElement)("strong", null, title),
        detail
          ? (0, import_react6.createElement)(
              "div",
              { className: "workagent-muted" },
              detail,
            )
          : null,
        children
          ? (0, import_react6.createElement)(
              "div",
              { className: "workagent-actions" },
              children,
            )
          : null,
      );
    }
    function Section({ title, children }) {
      return (0, import_react6.createElement)(
        "section",
        { className: "workagent-section", "data-workagent-section": title },
        (0, import_react6.createElement)("h2", null, title),
        children,
      );
    }

    // src/ui/dialog.js
    var import_react7 = __toESM(require("react"), 1);
    var import_react8 = require("react");
    var focusable =
      'button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),a[href],summary,[contenteditable]:not([contenteditable="false"]),[tabindex]:not([tabindex="-1"])';
    var openDialogs = [];
    function Dialog({
      title,
      children,
      onClose,
      size = "default",
      className = "",
      closeDisabled = false,
      as = "section",
      role = "dialog",
      ...props
    }) {
      const ref = import_react7.default.useRef(null);
      const hostRef = import_react7.default.useRef(null);
      const previousFocus = import_react7.default.useRef(
        typeof document === "undefined" ? null : document.activeElement,
      );
      const close = import_react7.default.useRef({ onClose, closeDisabled });
      close.current = { onClose, closeDisabled };
      const titleId = import_react7.default.useId();
      import_react7.default.useEffect(() => {
        const previous = previousFocus.current;
        const surface = ref.current;
        const host = hostRef.current;
        openDialogs.push(surface);
        surface.parentElement.style.zIndex = String(4e3 + openDialogs.length);
        const controls = () =>
          [...surface.querySelectorAll(focusable)].filter((node) => {
            if (
              node.tabIndex < 0 ||
              node.matches(":disabled") ||
              node.closest("[hidden],[inert]")
            )
              return false;
            for (
              let parent = node;
              parent && parent !== surface;
              parent = parent.parentElement
            ) {
              const style = getComputedStyle(parent);
              if (
                style.display === "none" ||
                style.visibility === "hidden" ||
                style.visibility === "collapse"
              )
                return false;
              if (
                parent.matches("details:not([open])") &&
                !parent.querySelector(":scope > summary")?.contains(node)
              )
                return false;
            }
            return true;
          });
        if (host.showModal) host.showModal();
        else host.setAttribute("open", "");
        {
          const nodes = controls();
          (
            nodes.find(
              (node) =>
                node.hasAttribute("data-dialog-autofocus") ||
                node.hasAttribute("autofocus"),
            ) ||
            nodes.find((node) =>
              node.matches('input,textarea,[contenteditable="true"],select'),
            ) ||
            nodes[0] ||
            surface
          ).focus();
        }
        const key = (event) => {
          if (openDialogs.at(-1) !== surface) return;
          if (event.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!close.current.closeDisabled) close.current.onClose();
          } else if (event.key === "Tab") {
            const nodes = controls();
            const first = nodes[0];
            const last = nodes.at(-1);
            if (!first) {
              event.preventDefault();
              surface.focus();
            } else if (
              event.shiftKey &&
              (document.activeElement === first ||
                !surface.contains(document.activeElement))
            ) {
              event.preventDefault();
              last.focus();
            } else if (
              !event.shiftKey &&
              (document.activeElement === last ||
                !surface.contains(document.activeElement))
            ) {
              event.preventDefault();
              first.focus();
            }
          }
        };
        document.addEventListener("keydown", key, true);
        return () => {
          document.removeEventListener("keydown", key, true);
          openDialogs.splice(openDialogs.indexOf(surface), 1);
          if (host.close && host.open) host.close();
          if (previous?.isConnected) previous.focus();
        };
      }, []);
      return (0, import_react8.createElement)(
        "dialog",
        {
          ref: hostRef,
          role: "presentation",
          className: "workagent-dialog-backdrop",
          onCancel: (event) => event.preventDefault(),
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !closeDisabled) {
              event.preventDefault();
              onClose();
            }
          },
        },
        (0, import_react8.createElement)(
          as,
          {
            ...props,
            ref,
            role,
            "aria-modal": true,
            "aria-labelledby": props["aria-label"] ? void 0 : titleId,
            "data-workagent-dialog": "",
            "data-size": size,
            tabIndex: -1,
            className: [
              "workagent-dialog",
              "workagent-dialog-surface",
              className,
            ]
              .filter(Boolean)
              .join(" "),
          },
          (0, import_react8.createElement)(
            "header",
            { className: "workagent-dialog-header" },
            (0, import_react8.createElement)("h2", { id: titleId }, title),
            (0, import_react8.createElement)(
              Button,
              {
                className: "workagent-dialog-close",
                "aria-label": "关闭",
                disabled: closeDisabled,
                onClick: onClose,
              },
              (0, import_react8.createElement)(Icon, {
                name: "close",
                size: 18,
              }),
            ),
          ),
          children,
        ),
      );
    }
    function ActionList({ children, className = "" }) {
      return (0, import_react8.createElement)(
        "div",
        {
          className: ["workagent-action-list", className]
            .filter(Boolean)
            .join(" "),
        },
        children,
      );
    }
    function useConfirm() {
      const [request2, setRequest] = import_react7.default.useState(null);
      const pending = import_react7.default.useRef(null);
      import_react7.default.useEffect(() => () => pending.current?.(false), []);
      const finish = import_react7.default.useCallback((value) => {
        pending.current?.(value);
        pending.current = null;
        setRequest(null);
      }, []);
      const confirm = import_react7.default.useCallback(
        (options) =>
          new Promise((resolve) => {
            pending.current?.(false);
            pending.current = resolve;
            setRequest(
              typeof options === "string" ? { description: options } : options,
            );
          }),
        [],
      );
      const confirmation = request2
        ? (0, import_react8.createElement)(
            Dialog,
            {
              title: request2.title || "确认操作",
              role: "alertdialog",
              onClose: () => finish(false),
            },
            (0, import_react8.createElement)("p", null, request2.description),
            (0, import_react8.createElement)(
              "div",
              { className: "workagent-dialog-actions" },
              (0, import_react8.createElement)(
                Button,
                { autoFocus: true, onClick: () => finish(false) },
                request2.cancelLabel || "取消",
              ),
              (0, import_react8.createElement)(
                Button,
                {
                  variant: request2.danger ? "danger" : "primary",
                  onClick: () => finish(true),
                },
                request2.confirmLabel || "确认",
              ),
            ),
          )
        : null;
      return { confirm, confirmation };
    }

    // src/features/agents/state.js
    var AGENT_PICK_KEY = "workagent.hero.agent";
    var HERO_AGENT_EVENT = "workagent:hero-agent";

    // src/features/agents/picker.js
    var import_react9 = __toESM(require("react"), 1);
    var import_react10 = require("react");
    function useAgentOrder(presets) {
      const key = "workagent.agent-order.v1";
      const eventName = "workagent:agent-order-changed";
      const read = () => {
        try {
          const value = JSON.parse(localStorage.getItem(key) || "[]");
          return Array.isArray(value)
            ? value.filter((id) => typeof id === "string")
            : [];
        } catch {
          return [];
        }
      };
      const [order, setOrder] = import_react9.default.useState(read);
      import_react9.default.useEffect(() => {
        const update = () => setOrder(read());
        window.addEventListener(eventName, update);
        window.addEventListener("storage", update);
        return () => {
          window.removeEventListener(eventName, update);
          window.removeEventListener("storage", update);
        };
      }, []);
      const rows = [...presets].sort((a, b) => {
        const left = order.indexOf(a.id),
          right = order.indexOf(b.id);
        return (
          (left < 0 ? order.length : left) - (right < 0 ? order.length : right)
        );
      });
      const save = (ids) => {
        localStorage.setItem(key, JSON.stringify(ids));
        setOrder(ids);
        window.dispatchEvent(new Event(eventName));
      };
      return { rows, save };
    }
    function AgentDisplaySettings({ presets }) {
      const { rows, save } = useAgentOrder(
        presets.filter((row) => row.enabled),
      );
      const [notice, setNotice] = import_react9.default.useState("");
      const [error, setError] = import_react9.default.useState("");
      const move = (index, delta) => {
        const ids = rows.map((row) => row.id);
        [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
        try {
          save(ids);
          setError("");
          setNotice("显示顺序已保存");
        } catch {
          setError("浏览器未能保存显示顺序，请检查存储空间后重试。");
        }
      };
      return (0, import_react10.createElement)(
        "section",
        { className: "workagent-agent-order", "aria-label": "Agent 显示顺序" },
        (0, import_react10.createElement)("h3", null, "主页 Agent 顺序"),
        (0, import_react10.createElement)(
          "p",
          { className: "workagent-muted" },
          "前 3 个优先显示，其余收进「更多」。调整后立即生效，保存在当前浏览器。",
        ),
        (0, import_react10.createElement)(
          "ol",
          null,
          ...rows.map((preset, index) =>
            (0, import_react10.createElement)(
              "li",
              { key: preset.id },
              (0, import_react10.createElement)(
                "span",
                {
                  className: "workagent-agent-order-index",
                  "aria-hidden": true,
                },
                index + 1,
              ),
              (0, import_react10.createElement)(AssistantAvatar, { preset }),
              (0, import_react10.createElement)(
                "span",
                { className: "workagent-agent-order-name" },
                displayPresetName(preset.name),
              ),
              (0, import_react10.createElement)(
                "button",
                {
                  type: "button",
                  disabled: index === 0,
                  "aria-label": `上移 ${displayPresetName(preset.name)}`,
                  onClick: () => move(index, -1),
                },
                "↑",
              ),
              (0, import_react10.createElement)(
                "button",
                {
                  type: "button",
                  disabled: index === rows.length - 1,
                  "aria-label": `下移 ${displayPresetName(preset.name)}`,
                  onClick: () => move(index, 1),
                },
                "↓",
              ),
            ),
          ),
        ),
        error
          ? (0, import_react10.createElement)("p", { role: "alert" }, error)
          : notice
            ? (0, import_react10.createElement)("p", { role: "status" }, notice)
            : null,
      );
    }
    function AgentPicker() {
      const [state] = usePresets((value) =>
        (Array.isArray(value) ? value : []).filter((preset) => preset.enabled),
      );
      const { rows } = useAgentOrder(state.rows);
      const [selected, setSelected] = import_react9.default.useState(
        () => localStorage.getItem(AGENT_PICK_KEY) || "builtin-general",
      );
      const [open, setOpen] = import_react9.default.useState(false);
      const root = import_react9.default.useRef(null),
        more = import_react9.default.useRef(null);
      import_react9.default.useEffect(() => {
        const update = (event) => setSelected(event.detail);
        window.addEventListener(HERO_AGENT_EVENT, update);
        return () => window.removeEventListener(HERO_AGENT_EVENT, update);
      }, []);
      import_react9.default.useEffect(() => {
        if (!open) return;
        const outside = (event) => {
          if (!root.current?.contains(event.target)) setOpen(false);
        };
        const escape = (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setOpen(false);
            more.current?.focus();
          }
        };
        document.addEventListener("pointerdown", outside);
        root.current?.addEventListener("keydown", escape);
        const node = root.current;
        return () => {
          document.removeEventListener("pointerdown", outside);
          node?.removeEventListener("keydown", escape);
        };
      }, [open]);
      import_react9.default.useEffect(() => {
        if (state.loading || rows.length === 0) return;
        if (rows.some((preset) => preset.id === selected)) return;
        const fallback =
          rows.find((preset) => preset.id === "builtin-general") || rows[0];
        setSelected(fallback.id);
        localStorage.setItem(AGENT_PICK_KEY, fallback.id);
      }, [selected, state.loading, state.rows]);
      const choose = (preset) => {
        setSelected(preset.id);
        setOpen(false);
        localStorage.setItem(AGENT_PICK_KEY, preset.id);
        window.dispatchEvent(
          new window.CustomEvent(HERO_AGENT_EVENT, { detail: preset.id }),
        );
      };
      if (state.loading || rows.length === 0) return null;
      const visible = rows.slice(0, 3);
      const active = rows.find((row) => row.id === selected);
      if (active && !visible.includes(active))
        visible[visible.length - 1] = active;
      const hidden = rows.filter((row) => !visible.includes(row));
      const option = (preset, inMenu = false) =>
        (0, import_react10.createElement)(
          "button",
          {
            key: preset.id,
            type: "button",
            role: "radio",
            "aria-checked": selected === preset.id,
            "data-agent-id": preset.id,
            tabIndex: inMenu || selected === preset.id ? 0 : -1,
            className: `workagent-agent${selected === preset.id ? " is-active" : ""}`,
            title: `切换到${displayPresetName(preset.name)}`,
            onClick: () => {
              choose(preset);
              requestAnimationFrame(() =>
                [...(root.current?.querySelectorAll("[data-agent-id]") || [])]
                  .find((node) => node.dataset.agentId === preset.id)
                  ?.focus(),
              );
            },
            onKeyDown: (event) => {
              if (
                ![
                  "ArrowLeft",
                  "ArrowRight",
                  "ArrowUp",
                  "ArrowDown",
                  "Home",
                  "End",
                ].includes(event.key)
              )
                return;
              event.preventDefault();
              const index = rows.indexOf(preset);
              const direction = ["ArrowRight", "ArrowDown"].includes(event.key)
                ? 1
                : -1;
              const next =
                rows[
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? rows.length - 1
                      : (index + direction + rows.length) % rows.length
                ];
              choose(next);
              requestAnimationFrame(() =>
                [...(root.current?.querySelectorAll("[data-agent-id]") || [])]
                  .find((node) => node.dataset.agentId === next.id)
                  ?.focus(),
              );
            },
          },
          (0, import_react10.createElement)(AssistantAvatar, { preset }),
          (0, import_react10.createElement)(
            "span",
            { className: "workagent-agent-name" },
            displayPresetName(preset.name),
          ),
        );
      return (0, import_react10.createElement)(
        "div",
        {
          className: "workagent-agents",
          role: "radiogroup",
          "aria-label": "选择 Agent",
          ref: root,
        },
        (0, import_react10.createElement)(
          "div",
          { className: "workagent-agent-strip" },
          ...visible.map((preset) => option(preset)),
          hidden.length
            ? (0, import_react10.createElement)(
                "button",
                {
                  ref: more,
                  type: "button",
                  className: "workagent-agent-more",
                  "aria-label": `更多 Agent，${hidden.length} 个`,
                  "aria-expanded": open,
                  onClick: () => setOpen((value) => !value),
                },
                "更多",
                (0, import_react10.createElement)(Icon, {
                  name: "chevronDown",
                  size: 14,
                }),
              )
            : null,
        ),
        open && hidden.length
          ? (0, import_react10.createElement)(
              "div",
              {
                className: "workagent-agent-overflow",
                role: "group",
                "aria-label": "更多 Agent",
              },
              ...hidden.map((preset) => option(preset, true)),
            )
          : null,
      );
    }

    // src/features/agents/settings.js
    var import_react11 = __toESM(require("react"), 1);
    var import_react12 = require("react");
    var defaultPreset = {
      enabled: true,
      description: "",
      avatar: null,
      modelId: null,
      systemPrompt: "",
      workspacePolicy: "optional",
      skillIds: [],
      mcpServerIds: [],
      toolAllowlist: [],
      approvalPolicy: "on_risk",
    };
    function CapabilityPicker({ name, label, state, selected = [] }) {
      const [ids, setIds] = import_react11.default.useState(selected);
      const [query, setQuery] = import_react11.default.useState("");
      const visible = state.rows.filter((row) =>
        `${row.name} ${row.id}`.toLowerCase().includes(query.toLowerCase()),
      );
      return (0, import_react12.createElement)(
        "fieldset",
        { className: "workagent-capability-picker" },
        (0, import_react12.createElement)("legend", null, label),
        (0, import_react12.createElement)("input", {
          type: "hidden",
          name,
          value: ids.join(","),
        }),
        (0, import_react12.createElement)(
          "details",
          null,
          (0, import_react12.createElement)(
            "summary",
            null,
            ids.length ? `已选择 ${ids.length} 项` : `选择${label}`,
          ),
          (0, import_react12.createElement)("input", {
            type: "search",
            "aria-label": `搜索${label}`,
            placeholder: "按名称搜索",
            value: query,
            onChange: (e) => setQuery(e.target.value),
          }),
          state.loading
            ? (0, import_react12.createElement)("p", null, "正在加载…")
            : state.error
              ? (0, import_react12.createElement)(
                  "p",
                  { role: "alert" },
                  state.error,
                )
              : (0, import_react12.createElement)(
                  "div",
                  { className: "workagent-capability-options" },
                  ...visible.map((row) =>
                    (0, import_react12.createElement)(
                      "label",
                      { key: row.id },
                      (0, import_react12.createElement)("input", {
                        type: "checkbox",
                        checked: ids.includes(row.id),
                        onChange: (e) =>
                          setIds(
                            e.target.checked
                              ? [...ids, row.id]
                              : ids.filter((id) => id !== row.id),
                          ),
                      }),
                      (0, import_react12.createElement)("span", null, row.name),
                    ),
                  ),
                  !visible.length
                    ? (0, import_react12.createElement)(
                        "p",
                        null,
                        "没有匹配项，可先从市场获取。",
                      )
                    : null,
                ),
        ),
        ids.length
          ? (0, import_react12.createElement)(
              "div",
              { className: "workagent-capability-selected" },
              ...ids.map((id) =>
                (0, import_react12.createElement)(
                  "button",
                  {
                    type: "button",
                    key: id,
                    "aria-label": `移除${state.rows.find((row) => row.id === id)?.name || id}`,
                    onClick: () => setIds(ids.filter((value) => value !== id)),
                  },
                  `${state.rows.find((row) => row.id === id)?.name || id} ×`,
                ),
              ),
            )
          : null,
      );
    }
    function PresetsSection() {
      const { confirm, confirmation } = useConfirm();
      const endpoint2 = `${apiRoot}/presets`;
      const [state, refresh] = usePresets();
      const [skills] = useResource(`${apiRoot}/skills`);
      const [servers] = useResource(`${apiRoot}/mcp-servers`);
      const [editing, setEditing] = import_react11.default.useState(null);
      const [formVersion, setFormVersion] = import_react11.default.useState(0);
      const [avatarEditing, setAvatarEditing] =
        import_react11.default.useState(null);
      const [avatarBusy, setAvatarBusy] =
        import_react11.default.useState(false);
      const [error, setError] = import_react11.default.useState("");
      const [pendingId, setPendingId] = import_react11.default.useState(null);
      const toggle = async (row, enabled) => {
        setPendingId(row.id);
        await mutatePreset(
          refresh,
          setError,
          `${endpoint2}/${encodeURIComponent(row.id)}`,
          "PATCH",
          { enabled },
        );
        setPendingId(null);
      };
      const submit = async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const values = new FormData(form);
        const csv = (name) =>
          String(values.get(name) || "")
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
        const body = {
          ...defaultPreset,
          ...(editing
            ? {
                description: editing.description,
                enabled: editing.enabled,
                workspacePolicy: editing.workspacePolicy,
                toolAllowlist: editing.toolAllowlist,
                approvalPolicy: editing.approvalPolicy,
              }
            : {}),
          name: String(values.get("name")),
          avatar: String(values.get("avatar") || "") || null,
          engine: String(values.get("engine")),
          modelId:
            editing?.engine === values.get("engine") ? editing.modelId : null,
          systemPrompt: String(values.get("systemPrompt") || ""),
          skillIds: csv("skillIds"),
          mcpServerIds: csv("mcpServerIds"),
        };
        const saved = await mutatePreset(
          refresh,
          setError,
          editing
            ? `${endpoint2}/${encodeURIComponent(editing.id)}`
            : endpoint2,
          editing ? "PATCH" : "POST",
          body,
        );
        if (!saved) return;
        setEditing(null);
        setFormVersion((version) => version + 1);
      };
      return (0, import_react12.createElement)(
        Section,
        { title: "助手" },
        (0, import_react12.createElement)(AgentDisplaySettings, {
          presets: state.rows,
        }),
        (0, import_react12.createElement)(
          Button,
          { onClick: () => navigation.navigate("/?workagent=teams") },
          "AI 团队",
        ),
        (0, import_react12.createElement)(
          "p",
          { className: "workagent-muted" },
          "在这里配置助手的引擎与能力；默认模型、思考强度和权限在「设置 → 模型」中调整。关闭助手后，已有对话仍可继续。",
        ),
        (0, import_react12.createElement)(
          "form",
          {
            className: "workagent-form",
            onSubmit: submit,
            key: `preset-form-${editing?.id || "new"}-${formVersion}`,
          },
          (0, import_react12.createElement)(
            Field,
            { label: "名称" },
            (0, import_react12.createElement)(Input, {
              name: "name",
              required: true,
              defaultValue: editing?.name || "",
            }),
          ),
          (0, import_react12.createElement)(AvatarField, {
            preset: editing,
            onBusyChange: setAvatarBusy,
          }),
          (0, import_react12.createElement)(
            Field,
            { label: "引擎" },
            (0, import_react12.createElement)(Select, {
              name: "engine",
              defaultValue: editing?.engine || "harness",
              options: [
                ["harness", "通用引擎"],
                ["codex", "Codex"],
                ["kimi", "Kimi"],
              ],
            }),
          ),
          (0, import_react12.createElement)(CapabilityPicker, {
            name: "skillIds",
            label: "技能",
            state: skills,
            selected: editing?.skillIds,
          }),
          (0, import_react12.createElement)(CapabilityPicker, {
            name: "mcpServerIds",
            label: "MCP 服务",
            state: servers,
            selected: editing?.mcpServerIds,
          }),
          (0, import_react12.createElement)(
            Field,
            { label: "系统提示词" },
            (0, import_react12.createElement)("textarea", {
              name: "systemPrompt",
              defaultValue: editing?.systemPrompt || "",
            }),
          ),
          (0, import_react12.createElement)(
            "button",
            {
              className: "workagent-button",
              type: "submit",
              disabled: avatarBusy,
            },
            editing ? "保存助手" : "创建助手",
          ),
          editing
            ? (0, import_react12.createElement)(
                Button,
                { onClick: () => setEditing(null) },
                "取消编辑",
              )
            : null,
        ),
        error
          ? (0, import_react12.createElement)(
              "p",
              { role: "alert", className: "workagent-error" },
              error,
            )
          : null,
        (0, import_react12.createElement)(Status, { state }),
        ...state.rows.map((row) =>
          (0, import_react12.createElement)(
            "article",
            {
              key: row.id,
              className: "workagent-card workagent-assistant-card",
            },
            (0, import_react12.createElement)(
              "div",
              { className: "workagent-assistant-info" },
              (0, import_react12.createElement)(AssistantAvatar, {
                preset: row,
                size: 36,
              }),
              (0, import_react12.createElement)(
                "strong",
                null,
                displayPresetName(row.name),
              ),
              (0, import_react12.createElement)(
                "div",
                { className: "workagent-muted" },
                displayValue(row.engine),
              ),
            ),
            (0, import_react12.createElement)(Switch, {
              "aria-label": `${displayPresetName(row.name)} 开关`,
              checked: row.enabled,
              disabled: pendingId !== null,
              title: row.enabled ? "关闭助手" : "开启助手",
              onChange: (enabled) => toggle(row, enabled),
            }),
            (0, import_react12.createElement)(
              Button,
              {
                onClick: () =>
                  setAvatarEditing(avatarEditing === row.id ? null : row.id),
                "aria-label": `更换${displayPresetName(row.name)}头像`,
              },
              "更换头像",
            ),
            avatarEditing === row.id
              ? (0, import_react12.createElement)(
                  "div",
                  { style: { gridColumn: "1 / -1", width: "100%" } },
                  (0, import_react12.createElement)(AvatarPicker, {
                    preset: row,
                    value: row.avatar,
                    onChange: async (avatar) => {
                      await request(
                        `${endpoint2}/${encodeURIComponent(row.id)}`,
                        {
                          method: "PATCH",
                          body: JSON.stringify({ avatar }),
                        },
                      );
                      await refresh();
                      window.dispatchEvent(
                        new window.CustomEvent("workagent:presets-changed"),
                      );
                    },
                  }),
                )
              : null,
            row.source === "user"
              ? (0, import_react12.createElement)(
                  "div",
                  {
                    className: "workagent-actions workagent-assistant-actions",
                  },
                  (0, import_react12.createElement)(
                    Button,
                    { onClick: () => setEditing(row) },
                    "编辑",
                  ),
                  (0, import_react12.createElement)(
                    Button,
                    {
                      disabled: pendingId !== null,
                      onClick: async () => {
                        if (
                          !(await confirm({
                            title: "删除助手",
                            description: `确定删除助手“${displayPresetName(row.name)}”？此操作无法撤销。`,
                            danger: true,
                            confirmLabel: "删除助手",
                          }))
                        )
                          return;
                        setPendingId(row.id);
                        const deleted = await mutatePreset(
                          refresh,
                          setError,
                          `${endpoint2}/${encodeURIComponent(row.id)}`,
                          "DELETE",
                        );
                        setPendingId(null);
                        if (deleted && editing?.id === row.id) setEditing(null);
                      },
                    },
                    "删除",
                  ),
                )
              : null,
          ),
        ),
        confirmation,
      );
    }

    // src/features/automations/automations.js
    function createAutomations({
      React: React37,
      request: request2,
      apiRoot: apiRoot2,
      useResource: useResource2,
      usePresets: usePresets2,
      Section: Section2,
      Field: Field2,
      Input: Input2,
      Select: Select2,
      Button: Button2,
      Card: Card2,
      Status: Status2,
      friendlyError: friendlyError2,
    }) {
      const h33 = React37.createElement;
      const endpoint2 = `${apiRoot2}/automations`;
      const runLabels = {
        pending: "等待",
        running: "运行中",
        succeeded: "成功",
        failed: "失败",
        cancelled: "已取消",
      };
      function SkillSuggestion({ row, run, saved }) {
        const [text, setText] = React37.useState(null);
        const [name, setName] = React37.useState(`${row.name}执行流程`);
        const [busy, setBusy] = React37.useState(false);
        const [error, setError] = React37.useState("");
        const [ignored, setIgnored] = React37.useState(false);
        const [installedId, setInstalledId] = React37.useState(null);
        if (ignored || row.skillId) return null;
        return h33(
          "section",
          {
            className: "workagent-skill-suggestion",
            "aria-label": "可复用技能建议",
          },
          h33("strong", null, "本次执行生成了技能建议"),
          h33(
            Button2,
            {
              disabled: busy,
              onClick: async () => {
                setBusy(true);
                setError("");
                try {
                  setText(
                    await request2(
                      `${apiRoot2}/workspaces/${encodeURIComponent(run.definitionSnapshot.workspaceId)}/content?path=${encodeURIComponent(run.skillSuggestionPath)}`,
                    ),
                  );
                } catch (reason) {
                  setError(friendlyError2(reason.message));
                } finally {
                  setBusy(false);
                }
              },
            },
            "预览技能建议",
          ),
          h33(
            Button2,
            { disabled: busy, onClick: () => setIgnored(true) },
            "忽略建议",
          ),
          text !== null
            ? h33(
                "form",
                {
                  className: "workagent-form",
                  onSubmit: async (event) => {
                    event.preventDefault();
                    setBusy(true);
                    setError("");
                    try {
                      let skillId = installedId;
                      if (!skillId) {
                        const data = new FormData();
                        data.set("name", name);
                        data.set(
                          "description",
                          `来自定时任务 ${row.name} 的执行流程`,
                        );
                        data.set("format", "directory");
                        data.set("paths", JSON.stringify(["SKILL.md"]));
                        data.append(
                          "files",
                          new File([text], "SKILL.md", {
                            type: "text/markdown",
                          }),
                        );
                        const response = await fetch(
                          `${apiRoot2}/imports/skill`,
                          {
                            method: "POST",
                            credentials: "same-origin",
                            body: data,
                          },
                        );
                        const result = await response.json();
                        if (!response.ok || result.error || !result.resourceId)
                          throw new Error(result.error || "技能导入失败");
                        skillId = result.resourceId;
                        setInstalledId(skillId);
                      }
                      await request2(
                        `${endpoint2}/${encodeURIComponent(row.id)}`,
                        {
                          method: "PATCH",
                          body: JSON.stringify({
                            version: row.version,
                            skillId,
                          }),
                        },
                      );
                      saved();
                    } catch (reason) {
                      setError(friendlyError2(reason.message));
                    } finally {
                      setBusy(false);
                    }
                  },
                },
                h33(
                  "label",
                  null,
                  "建议技能名称",
                  h33(Input2, {
                    "aria-label": "建议技能名称",
                    value: name,
                    onChange: (event) => setName(event.target.value),
                    required: true,
                    maxLength: 120,
                  }),
                ),
                h33(
                  "label",
                  null,
                  "建议技能内容",
                  h33("textarea", {
                    "aria-label": "建议技能内容",
                    value: text,
                    onChange: (event) => setText(event.target.value),
                    rows: 16,
                    maxLength: 128 * 1024,
                  }),
                ),
                h33(
                  "p",
                  null,
                  installedId
                    ? "技能已保存；若任务版本冲突，请刷新任务后重新绑定。"
                    : "请检查适用范围和执行步骤。保存后，下次运行会使用此技能。",
                ),
                h33(
                  Button2,
                  { type: "submit", disabled: busy },
                  "保存技能并绑定任务",
                ),
              )
            : null,
          error ? h33("p", { role: "alert" }, error) : null,
        );
      }
      function Editor({
        row,
        presets,
        skills,
        workspaces,
        sessions,
        notifications,
        saved,
        cancel,
      }) {
        const [kind, setKind] = React37.useState(
          row?.schedule.kind || "interval",
        );
        const [mode, setMode] = React37.useState(
          row?.executionMode || "new_conversation",
        );
        const [presetId, setPresetId] = React37.useState(row?.presetId || "");
        const [workspaceId, setWorkspaceId] = React37.useState(
          row?.workspaceId || "",
        );
        const [messageNotificationEnabled, setMessageNotificationEnabled] =
          React37.useState(row?.messageNotificationEnabled === true);
        const [error, setError] = React37.useState("");
        const [busy, setBusy] = React37.useState(false);
        const engine = presets.find((p) => p.id === presetId)?.engine;
        async function submit(event) {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const [hour, minute] = String(form.get("time") || "09:00")
            .split(":")
            .map(Number);
          const timezone = String(form.get("timezone") || "UTC");
          const schedule =
            kind === "interval"
              ? { kind, everyMinutes: Number(form.get("minutes")) }
              : kind === "weekly"
                ? {
                    kind,
                    daysOfWeek: form.getAll("days").map(Number),
                    hour,
                    minute,
                    timezone,
                  }
                : {
                    kind,
                    expression: String(form.get("expression")).trim(),
                    timezone,
                  };
          if (kind === "weekly" && !schedule.daysOfWeek.length)
            return setError("请选择至少一个执行日");
          const messageNotificationTargetId = String(
            form.get("messageNotificationTargetId") || "",
          );
          if (messageNotificationEnabled && !messageNotificationTargetId)
            return setError("请选择消息提醒的接收聊天");
          setBusy(true);
          setError("");
          try {
            await request2(
              row ? `${endpoint2}/${encodeURIComponent(row.id)}` : endpoint2,
              {
                method: row ? "PATCH" : "POST",
                body: JSON.stringify({
                  ...(row ? { version: row.version } : {}),
                  name: String(form.get("name")).trim(),
                  enabled: form.get("enabled") === "on",
                  schedule,
                  presetId,
                  engine,
                  workspaceId,
                  input: String(form.get("input")),
                  notificationPolicy: String(form.get("notificationPolicy")),
                  messageNotificationEnabled,
                  messageNotificationTargetId: messageNotificationEnabled
                    ? messageNotificationTargetId
                    : null,
                  skillId: String(form.get("skillId") || "") || null,
                  executionMode: mode,
                  conversationId:
                    mode === "existing"
                      ? String(form.get("conversationId"))
                      : null,
                }),
              },
            );
            saved();
          } catch (reason) {
            setError(friendlyError2(reason.message));
          } finally {
            setBusy(false);
          }
        }
        const field = (label, child) => h33(Field2, { label }, child);
        return h33(
          "form",
          {
            className: "workagent-form workagent-automation-form",
            onSubmit: submit,
          },
          h33(
            "h3",
            { className: "workagent-automation-wide" },
            row ? "编辑定时任务" : "新建定时任务",
          ),
          field(
            "任务名称",
            h33(Input2, {
              name: "name",
              required: true,
              maxLength: 200,
              defaultValue: row?.name || "",
            }),
          ),
          field(
            "执行助手",
            h33(Select2, {
              name: "presetId",
              required: true,
              value: presetId,
              onChange: (e) => setPresetId(e.target.value),
              options: [
                ["", "选择一个助手"],
                ...presets
                  .filter((p) => p.enabled || p.id === presetId)
                  .map((p) => [p.id, p.name]),
              ],
            }),
          ),
          field(
            "所属项目",
            h33(Select2, {
              name: "workspaceId",
              required: true,
              value: workspaceId,
              onChange: (e) => setWorkspaceId(e.target.value),
              options: [
                ["", "选择一个项目"],
                ...workspaces.map((w) => [w.id, w.name]),
              ],
            }),
          ),
          field(
            "绑定技能",
            h33(Select2, {
              name: "skillId",
              defaultValue: row?.skillId || "",
              options: [
                ["", "不绑定，执行后可生成建议"],
                ...skills
                  .filter((skill) => skill.enabled || skill.id === row?.skillId)
                  .map((skill) => [skill.id, skill.name]),
              ],
            }),
          ),
          field(
            "任务内容",
            h33("textarea", {
              name: "input",
              required: true,
              rows: 4,
              maxLength: 64e3,
              defaultValue: row?.input || "",
            }),
          ),
          field(
            "执行频率",
            h33(Select2, {
              value: kind,
              onChange: (e) => setKind(e.target.value),
              options: [
                ["interval", "固定间隔"],
                ["weekly", "每周"],
                ["cron", "Cron 表达式"],
              ],
            }),
          ),
          kind === "interval"
            ? field(
                "执行间隔（分钟）",
                h33(Input2, {
                  name: "minutes",
                  type: "number",
                  min: 1,
                  max: 525600,
                  required: true,
                  defaultValue: row?.schedule.everyMinutes || 60,
                }),
              )
            : h33(
                React37.Fragment,
                null,
                field(
                  "时区",
                  h33(Input2, {
                    name: "timezone",
                    required: true,
                    defaultValue:
                      row?.schedule.timezone ||
                      Intl.DateTimeFormat().resolvedOptions().timeZone ||
                      "UTC",
                  }),
                ),
                kind === "cron"
                  ? field(
                      "Cron 表达式",
                      h33(Input2, {
                        name: "expression",
                        required: true,
                        placeholder: "0 9 * * 1-5",
                        defaultValue: row?.schedule.expression || "",
                      }),
                    )
                  : h33(
                      React37.Fragment,
                      null,
                      h33(
                        "fieldset",
                        null,
                        h33("legend", null, "执行日"),
                        ...["日", "一", "二", "三", "四", "五", "六"].map(
                          (day, index) =>
                            h33(
                              "label",
                              { key: day },
                              h33("input", {
                                type: "checkbox",
                                name: "days",
                                value: index,
                                defaultChecked: (
                                  row?.schedule.daysOfWeek || [1]
                                ).includes(index),
                              }),
                              `周${day}`,
                            ),
                        ),
                      ),
                      field(
                        "执行时间",
                        h33(Input2, {
                          type: "time",
                          name: "time",
                          required: true,
                          defaultValue: `${String(row?.schedule.hour ?? 9).padStart(2, "0")}:${String(row?.schedule.minute ?? 0).padStart(2, "0")}`,
                        }),
                      ),
                    ),
              ),
          field(
            "执行方式",
            h33(Select2, {
              value: mode,
              onChange: (e) => setMode(e.target.value),
              options: [
                ["new_conversation", "每次新建对话"],
                ["existing", "继续已有对话"],
              ],
            }),
          ),
          mode === "existing"
            ? field(
                "继续的对话",
                h33(Select2, {
                  name: "conversationId",
                  required: true,
                  defaultValue: row?.conversationId || "",
                  options: [
                    ["", "选择同项目、同引擎的对话"],
                    ...sessions
                      .filter(
                        (s) =>
                          s.workspaceId === workspaceId &&
                          s.engine === engine &&
                          !s.parentSessionId,
                      )
                      .map((s) => [s.id, s.title || s.id]),
                  ],
                }),
              )
            : null,
          field(
            "结果通知",
            h33(Select2, {
              name: "notificationPolicy",
              defaultValue: row?.notificationPolicy || "always",
              options: [
                ["always", "每次通知"],
                ["on_failure", "仅失败时通知"],
                ["none", "不通知"],
              ],
            }),
          ),
          h33(
            "label",
            { className: "workagent-inline" },
            h33("input", {
              name: "messageNotificationEnabled",
              type: "checkbox",
              checked: messageNotificationEnabled,
              onChange: (event) =>
                setMessageNotificationEnabled(event.target.checked),
            }),
            "开启消息提醒",
          ),
          messageNotificationEnabled
            ? field(
                "消息提醒到",
                h33(Select2, {
                  name: "messageNotificationTargetId",
                  required: true,
                  defaultValue:
                    row?.messageNotificationTargetId ||
                    notifications?.targetId ||
                    "",
                  options: [
                    ["", "选择接收聊天"],
                    ...(notifications?.targets || [])
                      .filter((target) => target.connected)
                      .map((target) => [target.id, target.label]),
                  ],
                }),
              )
            : null,
          messageNotificationEnabled && !(notifications?.targets || []).length
            ? h33(
                "p",
                { className: "workagent-muted workagent-automation-wide" },
                "暂无可选聊天。请先到“消息渠道”连接账号，并在目标聊天中给机器人发送一条消息。",
              )
            : null,
          h33(
            "label",
            null,
            h33("input", {
              name: "enabled",
              type: "checkbox",
              defaultChecked: row?.enabled ?? true,
            }),
            "启用任务",
          ),
          error
            ? h33("p", { role: "alert", className: "workagent-error" }, error)
            : null,
          h33(
            "footer",
            { className: "workagent-automation-form-footer" },
            h33(
              Button2,
              { type: "button", onClick: cancel, disabled: busy },
              "取消",
            ),
            h33(
              Button2,
              {
                type: "submit",
                disabled: busy,
                className: "workagent-button workagent-automation-create",
              },
              busy ? "保存中…" : row ? "保存任务" : "创建任务",
            ),
          ),
        );
      }
      function Page() {
        const { confirm, confirmation } = useConfirm();
        const [state, refresh] = useResource2(endpoint2);
        const [presets] = usePresets2();
        const [skills] = useResource2(`${apiRoot2}/skills`);
        const [workspaces] = useResource2(`${apiRoot2}/workspaces`);
        const [sessions] = useResource2(`${apiRoot2}/sessions`);
        const [notifications] = useResource2(
          `${apiRoot2}/completion-notifications`,
        );
        const [editing, setEditing] = React37.useState(void 0);
        const [editorRevision, setEditorRevision] = React37.useState(0);
        const [history2, setHistory] = React37.useState({});
        const [error, setError] = React37.useState("");
        const [busy, setBusy] = React37.useState(false);
        async function action(path, method, body) {
          setBusy(true);
          setError("");
          try {
            await request2(path, {
              method,
              ...(body ? { body: JSON.stringify(body) } : {}),
            });
            refresh();
          } catch (reason) {
            setError(friendlyError2(reason.message));
          } finally {
            setBusy(false);
          }
        }
        async function loadHistory(id) {
          try {
            const rows = await request2(
              `${endpoint2}/${encodeURIComponent(id)}/runs`,
            );
            setHistory((current) => ({ ...current, [id]: rows }));
          } catch (reason) {
            setError(friendlyError2(reason.message));
          }
        }
        return h33(
          Section2,
          { title: "定时任务" },
          confirmation,
          h33(
            "header",
            { className: "workagent-automation-intro" },
            h33(
              "div",
              null,
              h33("h3", null, "让日常工作，自动进行"),
              h33("p", null, "按间隔、每周或 Cron 执行，可持续使用同一对话。"),
            ),
          ),
          editing !== null
            ? h33(Editor, {
                key: editing?.id || `new-${editorRevision}`,
                row: editing,
                presets: presets.rows,
                skills: skills.rows,
                workspaces: workspaces.rows,
                sessions: sessions.rows,
                notifications: notifications.rows[0],
                saved: () => {
                  refresh();
                  setEditing(editing ? null : void 0);
                  setEditorRevision((value) => value + 1);
                },
                cancel: () => setEditing(null),
              })
            : h33(
                Button2,
                {
                  className:
                    "workagent-button workagent-automation-create workagent-automation-new",
                  onClick: () => setEditing(void 0),
                },
                "新建定时任务",
              ),
          h33(Status2, { state }),
          error
            ? h33("p", { role: "alert", className: "workagent-error" }, error)
            : null,
          ...state.rows.map((row) =>
            h33(
              Card2,
              {
                key: row.id,
                className: "workagent-automation-card",
                "data-enabled": row.enabled,
                title: row.name,
                detail: h33(
                  React37.Fragment,
                  null,
                  h33(
                    "span",
                    { className: "workagent-automation-state" },
                    row.enabled ? "已启用" : "已暂停",
                  ),
                  h33(
                    "span",
                    null,
                    row.nextRunAt
                      ? `下次运行 ${new Date(row.nextRunAt).toLocaleString()}`
                      : "暂无下次运行时间",
                  ),
                ),
              },
              h33(
                Button2,
                { disabled: busy, onClick: () => setEditing(row) },
                "编辑任务",
              ),
              h33(
                Button2,
                {
                  disabled: busy,
                  className: "workagent-button workagent-automation-toggle",
                  onClick: () =>
                    action(
                      `${endpoint2}/${encodeURIComponent(row.id)}`,
                      "PATCH",
                      {
                        version: row.version,
                        enabled: !row.enabled,
                      },
                    ),
                },
                row.enabled ? "暂停" : "启用",
              ),
              h33(
                Button2,
                {
                  disabled: busy,
                  className: "workagent-button workagent-automation-run",
                  onClick: async () => {
                    await action(
                      `${endpoint2}/${encodeURIComponent(row.id)}/run`,
                      "POST",
                    );
                    await loadHistory(row.id);
                  },
                },
                "立即运行",
              ),
              h33(
                Button2,
                {
                  className: "workagent-button workagent-automation-history",
                  onClick: () => loadHistory(row.id),
                },
                "运行记录",
              ),
              h33(
                Button2,
                {
                  disabled: busy,
                  className: "workagent-button workagent-automation-delete",
                  onClick: async () => {
                    if (
                      await confirm({
                        description: `删除定时任务“${row.name}”？`,
                        danger: true,
                        confirmLabel: "删除任务",
                      })
                    )
                      action(
                        `${endpoint2}/${encodeURIComponent(row.id)}`,
                        "DELETE",
                      );
                  },
                },
                "删除",
              ),
              history2[row.id]
                ? h33(
                    "div",
                    { className: "workagent-run-history" },
                    history2[row.id].length
                      ? history2[row.id].map((run) =>
                          h33(
                            "article",
                            { key: run.id },
                            h33(
                              "strong",
                              null,
                              runLabels[run.status] || run.status,
                            ),
                            " · ",
                            new Date(run.createdAt).toLocaleString(),
                            run.sessionId
                              ? h33(
                                  "a",
                                  {
                                    href: `/?frontend=dsh&session=${encodeURIComponent(run.sessionId)}`,
                                  },
                                  "打开执行对话",
                                )
                              : null,
                            run.error
                              ? h33(
                                  "p",
                                  { className: "workagent-error" },
                                  friendlyError2(run.error),
                                )
                              : null,
                            run.result
                              ? h33(
                                  "details",
                                  null,
                                  h33("summary", null, "执行结果"),
                                  h33("pre", null, run.result),
                                )
                              : null,
                            run.skillSuggestionPath
                              ? h33(SkillSuggestion, {
                                  row,
                                  run,
                                  saved: refresh,
                                })
                              : null,
                            ["pending", "running"].includes(run.status)
                              ? h33(
                                  Button2,
                                  {
                                    disabled: busy,
                                    onClick: async () => {
                                      await action(
                                        `${endpoint2}/${encodeURIComponent(row.id)}/runs/${encodeURIComponent(run.id)}/cancel`,
                                        "POST",
                                      );
                                      await loadHistory(row.id);
                                    },
                                  },
                                  "取消执行",
                                )
                              : null,
                          ),
                        )
                      : h33("p", null, "暂无运行记录"),
                  )
                : null,
            ),
          ),
        );
      }
      return Page;
    }

    // src/features/automations/page.js
    var import_react13 = __toESM(require("react"), 1);
    var AutomationsPage = createAutomations({
      React: import_react13.default,
      request,
      apiRoot,
      useResource,
      usePresets,
      Section,
      Field,
      Input,
      Select,
      Button,
      Card,
      Status,
      friendlyError,
    });

    // src/features/conversations/preferences.js
    var import_react14 = __toESM(require("react"), 1);
    var import_react15 = require("react");
    var conversationSettings;
    var UPLOAD_PROJECT_KEY = "workagent.upload-to-project";
    function useUploadToProject() {
      return import_react14.default.useSyncExternalStore(
        (listener) => {
          window.addEventListener("workagent:upload-preference", listener);
          window.addEventListener("storage", listener);
          return () => {
            window.removeEventListener("workagent:upload-preference", listener);
            window.removeEventListener("storage", listener);
          };
        },
        () => localStorage.getItem(UPLOAD_PROJECT_KEY) !== "false",
      );
    }
    function UploadSettings() {
      const enabled = useUploadToProject();
      return (0, import_react15.createElement)(
        "label",
        { className: "workagent-busy-setting" },
        (0, import_react15.createElement)(
          "div",
          null,
          (0, import_react15.createElement)(
            "strong",
            null,
            "上传文件保存到当前项目",
          ),
          (0, import_react15.createElement)(
            "p",
            { className: "workagent-muted" },
            "开启后保存到项目根目录；关闭后作为会话附件保留。仅影响之后的上传。",
          ),
        ),
        (0, import_react15.createElement)(Switch, {
          "aria-label": "上传文件保存到当前项目",
          checked: enabled,
          onChange: (checked) => {
            localStorage.setItem(UPLOAD_PROJECT_KEY, String(checked));
            window.dispatchEvent(new Event("workagent:upload-preference"));
          },
        }),
      );
    }
    function useBusyEnter() {
      return import_react14.default.useSyncExternalStore(
        (listener) => conversationSettings.subscribe(listener),
        () =>
          conversationSettings.getSnapshot().value?.busyEnter === "steer"
            ? "steer"
            : "queue",
      );
    }
    function BusyEnterSettings() {
      const behavior = useBusyEnter();
      return (0, import_react15.createElement)(
        "div",
        { className: "workagent-busy-setting" },
        (0, import_react15.createElement)(
          "div",
          null,
          (0, import_react15.createElement)(
            "strong",
            null,
            "任务运行时的发送方式",
          ),
          (0, import_react15.createElement)(
            "p",
            { className: "workagent-muted" },
            "发送按钮和 Enter 使用此设置；Ctrl/Cmd + Enter 临时使用另一种方式。",
          ),
        ),
        (0, import_react15.createElement)(Select, {
          "aria-label": "任务运行时的发送方式",
          value: behavior,
          onChange: (event) =>
            conversationSettings.set("busyEnter", event.target.value),
          options: [
            ["queue", "排队发送"],
            ["steer", "立即追加"],
          ],
        }),
      );
    }
    function bindConversationSettings(value) {
      conversationSettings = value;
    }

    // src/features/conversations/message-delivery.js
    function createMessageDelivery(React37) {
      const sessions = /* @__PURE__ */ new Map();
      const listeners = /* @__PURE__ */ new Set();
      const key = (id) => `workagent.draft.delivery.${id}`;
      function get(id) {
        if (!sessions.has(id)) {
          let rows = [];
          try {
            rows = JSON.parse(sessionStorage.getItem(key(id)) || "[]");
          } catch {}
          sessions.set(
            id,
            rows.map((row) => ({
              ...row,
              status: "failed",
              error: "发送结果待确认，可安全重试。",
            })),
          );
        }
        return sessions.get(id);
      }
      function set(id, rows) {
        sessions.set(id, rows);
        try {
          if (rows.length)
            sessionStorage.setItem(key(id), JSON.stringify(rows));
          else sessionStorage.removeItem(key(id));
        } catch {}
        listeners.forEach((listener) => listener());
      }
      function update(id, row) {
        const rows = get(id);
        const index = rows.findIndex((item) => item.id === row.id);
        set(
          id,
          index < 0
            ? [...rows, row]
            : rows.map((item) =>
                item.id === row.id ? { ...item, ...row } : item,
              ),
        );
      }
      function reconcile(id, messages, queue) {
        const known = /* @__PURE__ */ new Set([
          ...messages.map((row) => row.id),
          ...queue.map((row) => row.messageId),
        ]);
        const rows = get(id);
        const remaining = rows.filter((row) => !known.has(row.id));
        if (remaining.length !== rows.length) set(id, remaining);
      }
      function useRows(id) {
        return React37.useSyncExternalStore(
          React37.useCallback((listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          }, []),
          React37.useCallback(() => get(id), [id]),
        );
      }
      return { get, update, reconcile, useRows };
    }

    // src/features/conversations/cache.js
    function createConversationCache(limit = 12, maxBytes = 16 * 1024 * 1024) {
      const sessions = /* @__PURE__ */ new Map();
      let bytes = 0;
      function remove(id) {
        const entry = sessions.get(id);
        if (entry) bytes -= entry.bytes;
        sessions.delete(id);
      }
      function get(id, key) {
        const entry = sessions.get(id);
        if (!entry) return;
        sessions.delete(id);
        sessions.set(id, entry);
        return entry.values.get(key)?.value;
      }
      function set(id, key, value) {
        const size = JSON.stringify(value).length * 2;
        if (size > maxBytes) {
          remove(id);
          return;
        }
        const entry = sessions.get(id) || {
          values: /* @__PURE__ */ new Map(),
          bytes: 0,
        };
        const change = size - (entry.values.get(key)?.bytes || 0);
        entry.bytes += change;
        bytes += change;
        entry.values.set(key, { value, bytes: size });
        sessions.delete(id);
        sessions.set(id, entry);
        while (sessions.size > limit || bytes > maxBytes)
          remove(sessions.keys().next().value);
      }
      return { get, set, remove };
    }

    // src/features/conversations/state.js
    var import_react16 = __toESM(require("react"), 1);
    var conversationCache = createConversationCache();
    var messageDelivery = createMessageDelivery(import_react16.default);
    var SESSIONS_CHANGED_EVENT = "workagent:sessions-changed";
    var SESSION_SEEN_PREFIX = "workagent.session-seen.";

    // src/features/conversations/runtime.js
    var import_react17 = __toESM(require("react"), 1);
    var RuntimeServices = import_react17.default.createContext(null);
    var standardSessionApi = (ctx) => ctx.connection?.api?.sessions;
    var hasStandardSessions = (ctx) =>
      Boolean(ctx.sessions?.binding && standardSessionApi(ctx));
    var rpcValue = (response) => {
      const result = response.result ?? response;
      if (!result.ok)
        throw new Error(
          result.error?.message ||
            result.error?.code ||
            "session_request_failed",
        );
      return result.value;
    };
    async function nativeSessionAction(ctx, sessionId2, action, ...args) {
      if (action === "prompt" && args[2])
        return rpcValue(
          await request("/api/session.prompt", {
            method: "POST",
            body: JSON.stringify({
              type: "client-request",
              rpcId: args[2],
              method: "session.prompt",
              payload: {
                sessionId: sessionId2,
                content: args[0],
                mode: args[1],
                clientTimeZone:
                  Intl.DateTimeFormat().resolvedOptions().timeZone,
              },
            }),
          }),
        );
      const session = ctx.sessions.binding(sessionId2)?.session;
      if (typeof session?.[action] === "function")
        return rpcValue(await session[action](...args));
      const api = standardSessionApi(ctx);
      const payload =
        action === "prompt"
          ? { sessionId: sessionId2, content: args[0], mode: args[1] }
          : action === "updateQueue"
            ? { sessionId: sessionId2, itemId: args[0], action: args[1] }
            : action === "selectModel"
              ? { sessionId: sessionId2, ...args[0] }
              : { sessionId: sessionId2 };
      return rpcValue(await api[action](payload));
    }
    function useNativeConversation(ctx, sessionId2, enabled) {
      const [state, setState] = import_react17.default.useState(() => ({
        value: conversationCache.get(sessionId2, "native"),
        loading: !conversationCache.get(sessionId2, "native"),
        error: "",
      }));
      const refresh = import_react17.default.useRef(async () => {});
      const reload = import_react17.default.useCallback(
        () => refresh.current(),
        [],
      );
      import_react17.default.useEffect(() => {
        if (!enabled) return;
        let disposed = false;
        let revision = 0;
        let generation = 0;
        let requestController;
        let loading = false;
        let binding;
        let current = conversationCache.get(sessionId2, "native");
        let sequence = current?.sequence ?? -1;
        let lastPush = Date.now();
        let stopProjection = () => {};
        const accept = (value, nextSequence = value?.sequence) => {
          if (disposed || !value) return;
          if (nextSequence !== void 0 && nextSequence < sequence) return;
          if (nextSequence !== void 0) sequence = nextSequence;
          current = value;
          revision += 1;
          conversationCache.set(sessionId2, "native", value);
          setState({ value, loading: false, error: "" });
        };
        const bind = () => {
          const next = ctx.sessions.binding(sessionId2);
          if (!next || next === binding) return;
          binding = next;
          stopProjection();
          const face = next.session.projections.faceOf("nativeSession");
          accept(face.getSnapshot());
          stopProjection = face.subscribe(() => {
            lastPush = Date.now();
            accept(face.getSnapshot());
          });
        };
        const load = async () => {
          loading = true;
          const currentGeneration = ++generation;
          const before = revision;
          requestController?.abort();
          const controller = new AbortController();
          requestController = controller;
          try {
            const block = rpcValue(
              await standardSessionApi(ctx).history(
                { sessionId: sessionId2 },
                controller.signal,
              ),
            ).projections;
            const value = block?.values?.nativeSession;
            if (
              disposed ||
              controller.signal.aborted ||
              generation !== currentGeneration ||
              (value?.sequence === void 0 && revision !== before)
            )
              return;
            if (!value)
              throw new Error("native_session_projection_unavailable");
            accept(value, block.asOfSeq);
          } catch (error) {
            if (
              !disposed &&
              !controller.signal.aborted &&
              generation === currentGeneration
            )
              setState((current2) => ({
                ...current2,
                loading: false,
                error: error.message,
              }));
          } finally {
            if (generation === currentGeneration) loading = false;
          }
        };
        refresh.current = load;
        bind();
        const stopList = ctx.sessions.list.subscribe(bind);
        const stopReset = ctx.on("connection/reset", () => {
          sequence = -1;
          bind();
          void load();
        });
        const onFocus = () => {
          if (!document.hidden) void load();
        };
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onFocus);
        const recovery = setInterval(() => {
          if (
            !document.hidden &&
            !loading &&
            Date.now() - lastPush >= 5e3 &&
            (!current ||
              current.activity.state !== "idle" ||
              messageDelivery.get(sessionId2).length)
          )
            void load();
        }, 5e3);
        void load();
        return () => {
          disposed = true;
          requestController?.abort();
          stopProjection();
          stopList();
          stopReset();
          clearInterval(recovery);
          window.removeEventListener("focus", onFocus);
          document.removeEventListener("visibilitychange", onFocus);
          refresh.current = async () => {};
        };
      }, [sessionId2, enabled]);
      return { ...state, reload };
    }

    // src/features/files/uploads.js
    function createUploadBatch(uploadFile, friendlyError2) {
      return async function uploadFiles(
        workspaceId,
        files,
        {
          directory = "",
          destination = (file) => ({
            path: [directory, file.name].filter(Boolean).join("/"),
          }),
          signal,
          onProgress = () => {},
          onUploaded = () => {},
          stopOnError = false,
        } = {},
      ) {
        let completed = 0;
        const failures = [];
        for (const file of files) {
          if (signal?.aborted) break;
          try {
            onProgress({ name: file.name, size: file.size, bytes: 0 });
            const { path, resumePrefix, conflict } = destination(file);
            let savedEntry;
            const savedPath = await uploadFile(workspaceId, path, file, {
              signal,
              resumePrefix,
              conflict,
              onEntry: (entry) => {
                savedEntry = entry;
              },
              onProgress: (bytes) =>
                onProgress({ name: file.name, size: file.size, bytes }),
            });
            completed++;
            await onUploaded(savedPath, file, savedEntry);
          } catch (reason) {
            failures.push(`${file.name}：${friendlyError2(reason.message)}`);
            if (signal?.aborted || stopOnError) break;
          }
        }
        return { completed, failures };
      };
    }
    function createUploads({
      React: React37,
      request: request2,
      apiRoot: apiRoot2,
      friendlyError: friendlyError2,
      workspaceEndpoint,
    }) {
      const h33 = React37.createElement;
      const endpoint2 = (id) =>
        workspaceEndpoint
          ? `${workspaceEndpoint(id)}/uploads`
          : `${apiRoot2}/workspaces/${encodeURIComponent(id)}/uploads`;
      function chunk(url, blob, offset, signal, onProgress) {
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PATCH", url);
          xhr.withCredentials = true;
          xhr.setRequestHeader("Upload-Offset", String(offset));
          xhr.setRequestHeader("Content-Type", "application/octet-stream");
          const abort = () => xhr.abort();
          const finish = (error, value) => {
            signal?.removeEventListener("abort", abort);
            error ? reject(error) : resolve(value);
          };
          xhr.upload.onprogress = (event) => onProgress(offset + event.loaded);
          xhr.onerror = () =>
            finish(new Error("网络中断，可重新选择同一文件继续上传"));
          xhr.onabort = () => finish(new Error("上传已暂停，可继续或取消"));
          xhr.onload = () => {
            let value;
            try {
              value = JSON.parse(xhr.responseText);
            } catch {
              finish(new Error(`HTTP ${xhr.status}`));
              return;
            }
            finish(
              xhr.status >= 200 && xhr.status < 300
                ? null
                : new Error(value.error || `HTTP ${xhr.status}`),
              value,
            );
          };
          if (signal?.aborted) {
            reject(new Error("上传已暂停"));
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
          xhr.send(blob);
        });
      }
      async function uploadFile(
        workspaceId,
        path,
        file,
        {
          signal,
          onProgress = () => {},
          resumePrefix,
          conflict,
          onEntry = () => {},
        } = {},
      ) {
        if (file.size > MAX_UPLOAD_BYTES)
          throw new Error(UPLOAD_TOO_LARGE_MESSAGE);
        const base = endpoint2(workspaceId);
        const pending = await request2(base, { signal });
        let row = pending.find(
          (row2) =>
            (row2.path === path ||
              (resumePrefix && row2.path.startsWith(resumePrefix))) &&
            row2.name === file.name &&
            row2.size === file.size &&
            row2.lastModified === file.lastModified,
        );
        if (!row)
          row = await request2(base, {
            method: "POST",
            signal,
            body: JSON.stringify({
              path,
              name: file.name,
              size: file.size,
              lastModified: file.lastModified,
              ...(conflict ? { conflict } : {}),
            }),
          });
        onProgress(row.offset);
        while (row.offset < row.size) {
          row = await chunk(
            `${base}/${row.id}`,
            file.slice(
              row.offset,
              Math.min(row.offset + 8 * 1024 * 1024, row.size),
            ),
            row.offset,
            signal,
            onProgress,
          );
        }
        const completed = await request2(`${base}/${row.id}/complete`, {
          method: "POST",
          signal,
        });
        window.dispatchEvent(new Event("workagent:files-changed"));
        onEntry(completed);
        return completed?.path || row.path;
      }
      const uploadFiles = createUploadBatch(uploadFile, friendlyError2);
      function Panel({ workspaceId, onChanged }) {
        const [rows, setRows] = React37.useState([]);
        const [progress, setProgress] = React37.useState({});
        const [error, setError] = React37.useState("");
        const [active, setActive] = React37.useState(null);
        const control = React37.useRef(null);
        async function refresh() {
          try {
            setRows(await request2(endpoint2(workspaceId)));
            setError("");
          } catch (reason) {
            setError(friendlyError2(reason.message));
          }
        }
        React37.useEffect(() => {
          let live = true;
          request2(endpoint2(workspaceId))
            .then((rows2) => {
              if (live) setRows(rows2);
            })
            .catch(() => {});
          const changed = () => refresh();
          window.addEventListener("workagent:files-changed", changed);
          return () => {
            live = false;
            control.current?.abort();
            window.removeEventListener("workagent:files-changed", changed);
          };
        }, [workspaceId]);
        async function resume(row, file) {
          if (!file) return;
          if (
            file.name !== row.name ||
            file.size !== row.size ||
            file.lastModified !== row.lastModified
          ) {
            setError("请选择原来上传的同一个文件");
            return;
          }
          const controller = new AbortController();
          control.current = controller;
          setActive(row.id);
          setError("");
          try {
            await uploadFile(workspaceId, row.path, file, {
              signal: controller.signal,
              onProgress: (bytes) =>
                setProgress((p) => ({ ...p, [row.id]: bytes })),
            });
            onChanged?.();
          } catch (reason) {
            setError(friendlyError2(reason.message));
          } finally {
            setActive(null);
            control.current = null;
            await refresh();
          }
        }
        if (!rows.length && !error) return null;
        return h33(
          "details",
          { className: "workagent-upload-sessions" },
          h33(
            "summary",
            null,
            h33("span", null, "待继续上传"),
            h33("small", null, rows.length),
          ),
          h33("button", { type: "button", onClick: refresh }, "刷新上传列表"),
          h33("p", null, "重新选择原文件可继续；未完成上传保留 7 天。"),
          error ? h33("p", { role: "alert" }, error) : null,
          ...rows.map((row) =>
            h33(
              "article",
              { key: row.id },
              h33("strong", null, row.name),
              h33("progress", {
                max: row.size || 1,
                value: progress[row.id] ?? row.offset,
                "aria-label": `${row.name} 上传进度`,
              }),
              h33(
                "span",
                null,
                `${Math.round((100 * (progress[row.id] ?? row.offset)) / (row.size || 1))}%`,
              ),
              h33(
                "label",
                null,
                "继续上传",
                h33("input", {
                  type: "file",
                  className: "workagent-upload-resume-input",
                  "aria-label": `继续上传 ${row.name}`,
                  disabled: !!active,
                  onChange: (e) => {
                    void resume(row, e.target.files[0]);
                    e.target.value = "";
                  },
                }),
              ),
              active === row.id
                ? h33(
                    "button",
                    { type: "button", onClick: () => control.current?.abort() },
                    "暂停上传",
                  )
                : h33(
                    "button",
                    {
                      type: "button",
                      disabled: !!active,
                      onClick: async () => {
                        try {
                          await request2(
                            `${endpoint2(workspaceId)}/${row.id}`,
                            {
                              method: "DELETE",
                            },
                          );
                          await refresh();
                        } catch (reason) {
                          setError(friendlyError2(reason.message));
                        }
                      },
                    },
                    "取消上传",
                  ),
            ),
          ),
        );
      }
      function Area({ workspaceId, directory, onChanged, children, ...props }) {
        const input = React37.useRef(null);
        const control = React37.useRef(null);
        const live = React37.useRef(true);
        const [progress, setProgress] = React37.useState(null);
        const [error, setError] = React37.useState("");
        const [dragging, setDragging] = React37.useState(false);
        React37.useEffect(() => {
          live.current = true;
          return () => {
            live.current = false;
            control.current?.abort();
          };
        }, []);
        async function add(files) {
          if (control.current || !files.length) return;
          const controller = new AbortController();
          control.current = controller;
          setError("");
          try {
            const { failures } = await uploadFiles(workspaceId, files, {
              directory,
              signal: controller.signal,
              onProgress: (progress2) => {
                if (live.current) setProgress(progress2);
              },
            });
            if (live.current) {
              setError(failures.join("；"));
              onChanged();
            }
          } finally {
            control.current = null;
            setProgress(null);
          }
        }
        const over = (event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = control.current ? "none" : "copy";
          setDragging(true);
        };
        return h33(
          "div",
          {
            ...props,
            onDragEnter: over,
            onDragOver: over,
            onDragLeave: (event) => {
              event.stopPropagation();
              if (!event.currentTarget.contains(event.relatedTarget))
                setDragging(false);
            },
            onDrop: (event) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              event.stopPropagation();
              setDragging(false);
              void add([...event.dataTransfer.files]);
            },
          },
          h33(
            "div",
            { className: "workagent-file-toolbar" },
            h33(
              "button",
              {
                type: "button",
                className: "workagent-button",
                disabled: !!progress,
                onClick: () => input.current.click(),
              },
              "上传文件",
            ),
            h33(
              "span",
              { role: "status" },
              dragging
                ? "松开以上传到当前文件夹"
                : `可拖入文件，单个最大 ${UPLOAD_SIZE_LABEL}`,
            ),
            h33("input", {
              ref: input,
              type: "file",
              hidden: true,
              multiple: true,
              "aria-label": "选择项目上传文件",
              onChange: (event) => {
                const files = [...event.target.files];
                event.target.value = "";
                void add(files);
              },
            }),
          ),
          progress
            ? h33(
                "div",
                { className: "workagent-upload-progress" },
                progress.name,
                h33("progress", {
                  max: progress.size || 1,
                  value: progress.bytes,
                  "aria-label": "上传进度",
                }),
                h33(
                  "button",
                  { type: "button", onClick: () => control.current?.abort() },
                  "暂停上传",
                ),
              )
            : null,
          error ? h33("p", { role: "alert" }, error) : null,
          h33(Panel, { workspaceId, onChanged }),
          children,
        );
      }
      return { uploadFile, uploadFiles, Panel, Area };
    }

    // src/features/files/api.js
    var import_react18 = __toESM(require("react"), 1);
    var FILE_PROJECT_EVENT = "workagent:files-project";
    var FILES_CHANGED_EVENT = "workagent:files-changed";
    var fileParent = (path) => path.split("/").slice(0, -1).join("/");
    var workspaceFileRoot = (workspaceId) =>
      workspaceId?.startsWith("shared:")
        ? `/api/portal/shared-workspaces/${encodeURIComponent(workspaceId.slice("shared:".length))}`
        : `${apiRoot}/workspaces/${encodeURIComponent(workspaceId)}`;
    var fileURL = (
      workspaceId,
      path,
      preview = false,
      fileId,
      historical = false,
    ) =>
      `${workspaceFileRoot(workspaceId)}/content?path=${encodeURIComponent(path)}${preview ? "&preview=1" : ""}${fileId ? `&fileId=${encodeURIComponent(fileId)}` : ""}${historical ? "&reference=1" : ""}`;
    var uploads = createUploads({
      React: import_react18.default,
      request,
      apiRoot,
      friendlyError,
      workspaceEndpoint: workspaceFileRoot,
    });
    var fileSize = (size) =>
      size < 1024
        ? `${size} B`
        : size < 1024 * 1024
          ? `${(size / 1024).toFixed(1)} KB`
          : `${(size / 1024 / 1024).toFixed(1)} MB`;

    // ../contracts/dist/file-reference.js
    function fileReferenceText(reference) {
      return `项目文件：${JSON.stringify(reference)}`;
    }
    function fileReferenceParts(text) {
      const parts = [];
      const pattern =
        /项目文件[：:]\s*("(?:\\.|[^"\\])*"|\{(?:"(?:\\.|[^"\\])*"|[^"\r\n}])*\})/g;
      let end = 0;
      for (const match of text.matchAll(pattern)) {
        let reference;
        try {
          const value = JSON.parse(match[1]);
          const path = typeof value === "string" ? value : value?.path;
          if (typeof path !== "string" || !path) continue;
          if (
            typeof value === "object" &&
            value.workspaceId !== void 0 &&
            typeof value.workspaceId !== "string"
          )
            continue;
          reference = {
            path,
            ...(typeof value?.fileId === "string"
              ? { fileId: value.fileId }
              : {}),
            name:
              typeof value?.name === "string"
                ? value.name
                : path.split(/[\\/]/).at(-1),
            ...(typeof value?.workspaceId === "string"
              ? { workspaceId: value.workspaceId }
              : {}),
          };
        } catch {
          continue;
        }
        if (match.index > end)
          parts.push({ text: text.slice(end, match.index) });
        parts.push({ text: match[0], reference });
        end = match.index + match[0].length;
      }
      if (end < text.length) parts.push({ text: text.slice(end) });
      return parts;
    }
    function fileReferenceLabel(text) {
      return fileReferenceParts(text)
        .map((part) => part.reference?.name ?? part.text)
        .join("");
    }

    // src/features/conversations/file-composer.js
    function isComposerImage(name) {
      return /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i.test(name);
    }
    function bindComposerFiles(input, upload, disabled) {
      const form = input?.closest("form");
      if (!form) return () => {};
      input.dataset.composerFiles = "true";
      const paste = (event) => {
        const files = [...(event.clipboardData?.files || [])];
        if (!files.length) return;
        event.preventDefault();
        if (!disabled) void upload(files);
      };
      const route = (event) => {
        if (!Array.from(event.dataTransfer?.types || []).includes("Files"))
          return;
        if (
          event.target.closest?.(
            ".workagent-file-manager, .workagent-file-browser, .workagent-collab-files",
          )
        )
          return;
        const targetForm = event.target.closest?.("form");
        const surface =
          document.querySelector(".workagent-overlay") || document;
        if (!surface.contains(form)) return;
        if (
          targetForm
            ? targetForm !== form
            : surface.querySelector('[data-composer-files="true"]') !== input
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        event.dataTransfer.dropEffect = disabled ? "none" : "copy";
        form.classList.toggle(
          "is-file-dragging",
          event.type !== "drop" && !disabled,
        );
        if (event.type === "drop" && !disabled)
          void upload([...event.dataTransfer.files]);
      };
      const leave = (event) => {
        if (!event.relatedTarget || !form.contains(event.relatedTarget))
          form.classList.remove("is-file-dragging");
      };
      form.addEventListener("paste", paste);
      for (const name of ["drop", "dragenter", "dragover"])
        document.addEventListener(name, route, true);
      document.addEventListener("dragleave", leave, true);
      document.addEventListener("dragend", leave, true);
      return () => {
        delete input.dataset.composerFiles;
        form.classList.remove("is-file-dragging");
        form.removeEventListener("paste", paste);
        for (const name of ["drop", "dragenter", "dragover"])
          document.removeEventListener(name, route, true);
        document.removeEventListener("dragleave", leave, true);
        document.removeEventListener("dragend", leave, true);
      };
    }
    function composerText(root) {
      if (root.childNodes.length === 1 && root.firstChild.nodeName === "BR")
        return "";
      let text = "";
      for (const node of root.childNodes) {
        if (node.nodeType === 3) text += node.textContent;
        else if (node.dataset?.fileReference)
          text += node.dataset.fileReference;
        else if (node.nodeName === "BR") text += "\n";
        else {
          const block = /^(DIV|P)$/.test(node.nodeName);
          if (block && node.previousSibling) text += "\n";
          text +=
            block &&
            node.childNodes.length === 1 &&
            node.firstChild.nodeName === "BR"
              ? ""
              : composerText(node);
        }
      }
      return text;
    }
    function createFileComposer({
      React: React37,
      fileURL: fileURL2,
      openFile,
    }) {
      const h33 = React37.createElement;
      function fragment(value, workspaceId) {
        const result = document.createDocumentFragment();
        for (const part of fileReferenceParts(value)) {
          if (!part.reference) {
            result.append(document.createTextNode(part.text));
            continue;
          }
          const reference = part.reference;
          const chip = document.createElement("span");
          chip.className = "workagent-file-reference";
          chip.contentEditable = "false";
          chip.dataset.fileReference = part.text;
          chip.dataset.workspaceId = reference.workspaceId || workspaceId || "";
          chip.title = reference.path;
          const link = document.createElement("a");
          link.href = fileURL2(
            chip.dataset.workspaceId,
            reference.path,
            true,
            reference.fileId,
            true,
          );
          link.setAttribute("aria-label", `预览 ${reference.name}`);
          link.textContent = `📄${reference.name}`;
          if (isComposerImage(reference.name)) {
            chip.classList.add("workagent-image-reference");
            const image = document.createElement("img");
            image.src = link.href;
            image.alt = reference.name;
            image.draggable = false;
            image.addEventListener(
              "error",
              () => {
                chip.classList.remove("workagent-image-reference");
                link.textContent = `📄${reference.name}`;
              },
              { once: true },
            );
            link.replaceChildren(image);
          }
          const remove = document.createElement("button");
          remove.type = "button";
          remove.tabIndex = -1;
          remove.setAttribute("aria-label", `移除引用 ${reference.name}`);
          remove.textContent = "×";
          chip.append(link, remove);
          result.append(chip);
        }
        return result;
      }
      return function FileComposer({
        value = "",
        onChange,
        onKeyDown,
        workspaceId,
        disabled,
        autoFocus,
        placeholder,
        className = "",
        ...props
      }) {
        const ref = React37.useRef(null);
        const savedRange = React37.useRef(null);
        const change = React37.useRef(onChange);
        change.current = onChange;
        const history2 = React37.useRef({
          current: value,
          past: [],
          future: [],
          group: null,
          time: 0,
        });
        function record(next, group = null) {
          const state = history2.current;
          if (next === state.current) return;
          if (
            !group ||
            group !== state.group ||
            Date.now() - state.time > 750
          ) {
            state.past.push(state.current);
            if (state.past.length > 100) state.past.shift();
          }
          state.current = next;
          state.future = [];
          state.group = group;
          state.time = Date.now();
        }
        const changed = (group) => {
          const next = composerText(ref.current);
          record(next, group);
          change.current?.({ target: { value: next } });
        };
        function undo(redo = false) {
          const state = history2.current;
          const from = redo ? state.future : state.past;
          if (!from.length) return;
          (redo ? state.past : state.future).push(state.current);
          state.current = from.pop();
          state.group = null;
          ref.current.replaceChildren(fragment(state.current, workspaceId));
          select(end());
          remember();
          change.current?.({ target: { value: state.current } });
        }
        function selection() {
          const selected = window.getSelection();
          return selected.rangeCount &&
            ref.current.contains(selected.anchorNode)
            ? selected.getRangeAt(0)
            : null;
        }
        function remember() {
          const range = selection();
          if (range) savedRange.current = range.cloneRange();
        }
        function select(range) {
          const selected = window.getSelection();
          selected.removeAllRanges();
          selected.addRange(range);
        }
        function end() {
          const range = document.createRange();
          range.selectNodeContents(ref.current);
          range.collapse(false);
          return range;
        }
        function insert(text) {
          const editor = ref.current;
          editor.focus();
          const range =
            savedRange.current &&
            editor.contains(savedRange.current.commonAncestorContainer)
              ? savedRange.current
              : end();
          select(range);
          const content = fragment(text, workspaceId);
          const last = content.lastChild;
          range.deleteContents();
          range.insertNode(content);
          if (last) range.setStartAfter(last);
          range.collapse(true);
          select(range);
          remember();
          changed();
        }
        React37.useLayoutEffect(() => {
          const editor = ref.current;
          if (history2.current.current !== value) {
            if (!value)
              history2.current = {
                current: value,
                past: [],
                future: [],
                group: null,
                time: 0,
              };
            else record(value);
          }
          if (composerText(editor) !== value) {
            const active = document.activeElement === editor;
            editor.replaceChildren(fragment(value, workspaceId));
            savedRange.current = null;
            if (active) select(end());
          }
          editor.dataset.empty = String(!value);
        }, [value, workspaceId]);
        React37.useEffect(() => {
          const editor = ref.current;
          editor.workagentInsertReference = insert;
          const before = (event) => {
            if (["historyUndo", "historyRedo"].includes(event.inputType)) {
              event.preventDefault();
              undo(event.inputType === "historyRedo");
            }
          };
          editor.addEventListener("beforeinput", before);
          return () => {
            delete editor.workagentInsertReference;
            editor.removeEventListener("beforeinput", before);
          };
        });
        React37.useEffect(() => {
          if (autoFocus) ref.current.focus();
        }, []);
        return h33("div", {
          ...props,
          ref,
          className: `workagent-composer-input ${className}`,
          role: "textbox",
          "aria-multiline": true,
          "aria-disabled": !!disabled,
          contentEditable: !disabled,
          suppressContentEditableWarning: true,
          "data-placeholder": placeholder,
          onInput: (event) => {
            remember();
            changed(event.nativeEvent.inputType);
          },
          onBlur: remember,
          onKeyUp: remember,
          onMouseUp: remember,
          onClick: (event) => {
            const chip = event.target.closest("[data-file-reference]");
            if (!chip) return;
            event.preventDefault();
            if (event.target.closest("button")) {
              const range = document.createRange();
              range.selectNode(chip);
              select(range);
              range.deleteContents();
              ref.current.focus();
              remember();
              changed();
            } else
              openFile({
                ...fileReferenceParts(chip.dataset.fileReference)[0].reference,
                workspaceId: chip.dataset.workspaceId,
              });
          },
          onKeyDown: (event) => {
            if (
              !event.nativeEvent.isComposing &&
              (event.ctrlKey || event.metaKey) &&
              ["z", "y"].includes(event.key.toLowerCase())
            ) {
              event.preventDefault();
              undo(event.shiftKey || event.key.toLowerCase() === "y");
              return;
            }
            if (
              !event.nativeEvent.isComposing &&
              ["Backspace", "Delete"].includes(event.key)
            ) {
              const range = selection();
              if (range?.collapsed) {
                const node = range.startContainer;
                const back = event.key === "Backspace";
                const neighbor =
                  node.nodeType === 3
                    ? back && range.startOffset === 0
                      ? node.previousSibling
                      : !back && range.startOffset === node.length
                        ? node.nextSibling
                        : null
                    : node.childNodes[range.startOffset + (back ? -1 : 0)];
                if (neighbor?.dataset?.fileReference) {
                  event.preventDefault();
                  range.selectNode(neighbor);
                  select(range);
                  range.deleteContents();
                  remember();
                  changed();
                  return;
                }
              }
            }
            onKeyDown?.(event);
          },
          onPaste: (event) => {
            if (event.clipboardData.files.length) return;
            event.preventDefault();
            remember();
            insert(
              event.clipboardData.getData("application/x-workagent-draft") ||
                event.clipboardData.getData("text/plain"),
            );
          },
          onCopy: (event) => {
            const range = selection();
            if (!range || range.collapsed) return;
            const text = composerText(range.cloneContents());
            event.preventDefault();
            event.clipboardData.setData("application/x-workagent-draft", text);
            event.clipboardData.setData("text/plain", fileReferenceLabel(text));
          },
          onCut: (event) => {
            const range = selection();
            if (!range || range.collapsed) return;
            const text = composerText(range.cloneContents());
            event.preventDefault();
            event.clipboardData.setData("application/x-workagent-draft", text);
            event.clipboardData.setData("text/plain", fileReferenceLabel(text));
            range.deleteContents();
            remember();
            changed();
          },
        });
      };
    }

    // src/features/content/workbench.js
    function createWorkbench({
      React: React37,
      navigate = (href) => location.assign(href),
      friendlyError: friendlyError2 = (value) => value,
      reasoningLabel: reasoningLabel2 = (option) => option.name || option.id,
      primitives: primitives2,
      request: request2,
      apiRoot: apiRoot2,
      fileURL: fileURL2,
      workspaceEndpoint = (id) =>
        `${apiRoot2}/workspaces/${encodeURIComponent(id)}`,
      nativeSessionAction: nativeSessionAction2,
      uploadFiles,
      Icon: Icon2,
      useUploadToProject: useUploadToProject2 = () => true,
    }) {
      const h33 = React37.createElement;
      const button = (label, onClick, props = {}) =>
        h33("button", { type: "button", onClick, ...props }, label);
      async function openFile(reference) {
        const entry = await request2(
          `${workspaceEndpoint(reference.workspaceId)}/locate?path=${encodeURIComponent(reference.path)}&reference=1${reference.fileId ? `&fileId=${encodeURIComponent(reference.fileId)}` : ""}`,
        );
        window.dispatchEvent(
          new CustomEvent("workagent:file-open", {
            detail: { workspaceId: reference.workspaceId, entry },
          }),
        );
      }
      const FileComposer = createFileComposer({
        React: React37,
        fileURL: fileURL2,
        openFile: (reference) =>
          openFile(reference).catch((error) =>
            window.alert(friendlyError2(error.message)),
          ),
      });
      const readStored = (store, key, fallback) => {
        try {
          return JSON.parse(store.getItem(key)) ?? fallback;
        } catch {
          return fallback;
        }
      };
      const saveStored = (store, key, value) => {
        try {
          store.setItem(key, JSON.stringify(value));
        } catch {}
      };
      function useDraft(sessionId2, authorized = true) {
        const key = authorized ? `workagent.draft.${sessionId2}` : null;
        const [state, update] = React37.useState(() => ({
          key,
          text: key ? readStored(sessionStorage, key, "") : "",
        }));
        const text =
          state.key === key
            ? state.text
            : key
              ? readStored(sessionStorage, key, "")
              : "";
        const set = React37.useCallback(
          (value) =>
            update((current) => {
              if (!key) return current;
              const previous =
                current.key === key
                  ? current.text
                  : readStored(sessionStorage, key, "");
              const next =
                typeof value === "function" ? value(previous) : value;
              saveStored(sessionStorage, key, next);
              return { key, text: next };
            }),
          [key],
        );
        return [text, set];
      }
      function clearDrafts() {
        for (let index = sessionStorage.length - 1; index >= 0; index--) {
          const key = sessionStorage.key(index);
          if (
            key?.startsWith("workagent.draft.") ||
            key?.startsWith("workagent.file-draft.")
          )
            sessionStorage.removeItem(key);
        }
      }
      let mermaidPromise;
      function Mermaid({ code }) {
        const [result, setResult] = React37.useState(null);
        const [source, setSource] = React37.useState(false);
        const [theme, setTheme] = React37.useState(() =>
          isDarkTheme() ? "dark" : "default",
        );
        React37.useEffect(
          () => watchTheme((dark) => setTheme(dark ? "dark" : "default")),
          [],
        );
        const id = React37.useId().replaceAll(":", "");
        React37.useEffect(() => {
          let live = true;
          setResult(null);
          const mermaidURL =
            "/plugins/@workagent/dsh-client/mermaid/mermaid.esm.min.mjs";
          mermaidPromise ??= import(
            /* @vite-ignore */
            mermaidURL
          )
            .then(({ default: mermaid }) => {
              return mermaid;
            })
            .catch((error) => {
              mermaidPromise = void 0;
              throw error;
            });
          mermaidPromise
            .then((mermaid) => {
              mermaid.initialize({
                startOnLoad: false,
                securityLevel: "strict",
                suppressErrorRendering: true,
                theme,
              });
              return mermaid.render(`wa-diagram-${id}`, code);
            })
            .then((value) => {
              if (live) setResult({ svg: value.svg });
            })
            .catch(() => {
              if (live) setResult({ error: "图表暂时无法显示，可查看源码。" });
            });
          return () => {
            live = false;
          };
        }, [code, id, theme]);
        return h33(
          "figure",
          { className: "workagent-diagram" },
          button(source ? "图表" : "Mermaid 源码", () => setSource(!source)),
          source || result?.error
            ? h33(primitives2.CodeBlock, { code, lang: "mermaid" })
            : result?.svg
              ? h33("div", { dangerouslySetInnerHTML: { __html: result.svg } })
              : h33("p", { role: "status" }, "正在绘制图表…"),
          result?.error ? h33("figcaption", null, result.error) : null,
        );
      }
      function workspaceDestination(value, workspaceId) {
        if (
          !workspaceId ||
          !value ||
          /^(?:[a-z][a-z\d+.-]*:|[/\\#])/i.test(value)
        )
          return null;
        let path;
        try {
          path = decodeURIComponent(value).replaceAll("\\", "/");
        } catch {
          return null;
        }
        if (path.split("/").includes("..") || path.includes(":")) return null;
        const anchor = /#L?(\d+)(?:[-:]\d+)?$/.exec(path);
        if (anchor) path = path.slice(0, anchor.index);
        const identity = /\?workagentFileId=([a-zA-Z0-9-]+)$/.exec(path);
        if (identity) path = path.slice(0, identity.index);
        return new URL(
          fileURL2(
            workspaceId,
            path.replace(/^\.\//, ""),
            true,
            identity?.[1],
            true,
          ) + (anchor ? `#L${anchor[1]}` : ""),
          location.origin,
        ).href;
      }
      function Markdown2({ children, streaming = false, workspaceId }) {
        const [error, setError] = React37.useState("");
        const root = React37.useRef(null);
        const text = String(children || "");
        React37.useLayoutEffect(() => {
          for (const anchor of root.current.querySelectorAll("a[href]")) {
            const url = new URL(anchor.href, location.origin);
            if (
              url.origin === location.origin &&
              /^\/api\/runtime\/v1\/workspaces\/[^/]+\/content$/.test(
                url.pathname,
              )
            )
              anchor.title = url.searchParams.get("path") || "";
          }
        }, [text, workspaceId]);
        const chunks = text.split(
          /(^ {0,3}(?:`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}(?:`{3,}|~{3,})\s*$)/gm,
        );
        const diagrams = [];
        const rendered = chunks
          .map((chunk, index) => {
            const diagram =
              /^ {0,3}(`{3,}|~{3,})mermaid\s*\n([\s\S]*?)\n {0,3}\1\s*$/.exec(
                chunk,
              );
            if (diagram && !streaming)
              diagrams.push(h33(Mermaid, { key: index, code: diagram[2] }));
            if (index % 2) return chunk;
            return fileReferenceParts(chunk)
              .map((part) => {
                if (!part.reference) return part.text;
                const file = part.reference;
                const label = file.name.replace(/[\\[\]`*]/g, "\\$&");
                const title = file.path
                  .replace(/\\/g, "\\\\")
                  .replace(/"/g, '\\"');
                const href = new URL(
                  fileURL2(
                    file.workspaceId || workspaceId,
                    file.path,
                    true,
                    file.fileId,
                    true,
                  ),
                  location.origin,
                ).href
                  .replaceAll("(", "%28")
                  .replaceAll(")", "%29");
                return `[📄 ${label}](${href} "${title}")`;
              })
              .join("")
              .replace(
                /(`+)[\s\S]*?\1|(!?\[[^\]\n]*\]\()([^\s)]+)(\))/g,
                (match, codeDelimiter, start, destination, end) => {
                  if (codeDelimiter) return match;
                  const url = workspaceDestination(destination, workspaceId);
                  return url ? `${start}${url}${end}` : match;
                },
              );
          })
          .join("");
        return h33(
          "div",
          {
            className: "workagent-markdown",
            ref: root,
            onClick: async (event) => {
              const anchor = event.target.closest?.("a[href]");
              if (
                !anchor ||
                !workspaceId ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              const url = new URL(anchor.href, location.origin);
              const base = new URL(
                fileURL2(workspaceId, "", true),
                location.origin,
              );
              const fileWorkspace =
                /^\/api\/runtime\/v1\/workspaces\/([^/]+)\/content$/.exec(
                  url.pathname,
                )?.[1];
              const sharedFileProject =
                /^\/api\/portal\/shared-workspaces\/([^/]+)\/content$/.exec(
                  url.pathname,
                )?.[1];
              if (
                url.origin !== base.origin ||
                (!fileWorkspace &&
                  !sharedFileProject &&
                  url.pathname !== base.pathname) ||
                !url.searchParams.has("path")
              )
                return;
              event.preventDefault();
              try {
                const selectedWorkspace = fileWorkspace
                  ? decodeURIComponent(fileWorkspace)
                  : sharedFileProject
                    ? `shared:${decodeURIComponent(sharedFileProject)}`
                    : workspaceId;
                const entry = await request2(
                  `${workspaceEndpoint(selectedWorkspace)}/locate?path=${encodeURIComponent(url.searchParams.get("path"))}&reference=1${url.searchParams.has("fileId") ? `&fileId=${encodeURIComponent(url.searchParams.get("fileId"))}` : ""}`,
                );
                const line = /^#L(\d+)$/.exec(url.hash);
                window.dispatchEvent(
                  new CustomEvent("workagent:file-open", {
                    detail: {
                      workspaceId: selectedWorkspace,
                      entry: {
                        ...entry,
                        ...(line ? { line: Number(line[1]) } : {}),
                      },
                    },
                  }),
                );
                setError("");
              } catch (reason) {
                setError(friendlyError2(reason.message));
              }
            },
          },
          h33(primitives2.MarkdownText, {
            text: rendered,
            streaming,
            codeLabels: { copyLabel: "复制代码", copiedLabel: "已复制" },
          }),
          ...diagrams,
          error ? h33("small", { role: "alert" }, error) : null,
        );
      }
      function FileLocation({ workspaceId, path, line, fileId }) {
        const [error, setError] = React37.useState("");
        return h33(
          "span",
          null,
          button(`${path}${line ? `:${line}` : ""}`, async () => {
            try {
              const entry = await request2(
                `${workspaceEndpoint(workspaceId)}/locate?path=${encodeURIComponent(path)}&reference=1${fileId ? `&fileId=${encodeURIComponent(fileId)}` : ""}`,
              );
              window.dispatchEvent(
                new CustomEvent("workagent:file-open", {
                  detail: {
                    workspaceId,
                    entry: {
                      ...entry,
                      line:
                        Number.isSafeInteger(line) && line > 0 ? line : void 0,
                    },
                  },
                }),
              );
            } catch (reason) {
              setError(friendlyError2(reason.message));
            }
          }),
          error ? h33("small", { role: "alert" }, error) : null,
        );
      }
      function Artifacts({ sessionId: sessionId2, workspaceId, revision }) {
        const [rows, setRows] = React37.useState([]);
        const [fileRevision, setFileRevision] = React37.useState(0);
        React37.useEffect(() => {
          const update = () => setFileRevision((value) => value + 1);
          window.addEventListener("workagent:files-changed", update);
          return () =>
            window.removeEventListener("workagent:files-changed", update);
        }, []);
        React37.useEffect(() => {
          if (!workspaceId || !sessionId2) return;
          const controller = new AbortController();
          request2(
            `${workspaceEndpoint(workspaceId)}/assets?sessionId=${encodeURIComponent(sessionId2)}`,
            { signal: controller.signal },
          )
            .then((value) => {
              if (!controller.signal.aborted)
                setRows(value.filter((row) => row.kind === "artifact"));
            })
            .catch(() => {});
          return () => controller.abort();
        }, [sessionId2, workspaceId, revision, fileRevision]);
        return rows.length
          ? h33(
              "details",
              { className: "workagent-artifacts" },
              h33("summary", null, `会话产物 · ${rows.length}`),
              ...rows.map((row) =>
                h33(
                  "div",
                  { key: row.id },
                  h33(FileLocation, {
                    workspaceId,
                    path: row.path,
                    fileId: row.fileId,
                  }),
                  h33(
                    "a",
                    {
                      href: fileURL2(
                        workspaceId,
                        row.path,
                        false,
                        row.fileId,
                        true,
                      ),
                      download: row.name,
                    },
                    "下载",
                  ),
                ),
              ),
            )
          : null;
      }
      function Tools({ tools = {}, workspaceId }) {
        const rows = Object.values(tools);
        if (!rows.length) return null;
        return h33(
          "details",
          { className: "workagent-tool-history" },
          h33("summary", null, `工具过程 · ${rows.length}`),
          rows.map((tool) =>
            h33(
              "details",
              { key: tool.toolCallId },
              h33(
                "summary",
                null,
                `${tool.tool || "工具"} · ${tool.type === "tool.completed" ? (tool.failed ? "失败" : "完成") : "未返回完成结果"}`,
              ),
              workspaceId && Array.isArray(tool.locations)
                ? tool.locations
                    .filter((item) => typeof item?.path === "string")
                    .map((item, index) =>
                      h33(FileLocation, {
                        key: index,
                        workspaceId,
                        path: item.path,
                        line: item.line,
                      }),
                    )
                : null,
              ["input", "output", "result", "locations", "raw"]
                .filter((key) => tool[key] !== void 0)
                .map((key) =>
                  h33(
                    "section",
                    { key },
                    h33("strong", null, key),
                    h33(primitives2.CodeBlock, {
                      code:
                        typeof tool[key] === "string"
                          ? tool[key]
                          : JSON.stringify(tool[key], null, 2),
                      lang: typeof tool[key] === "string" ? "text" : "json",
                    }),
                  ),
                ),
            ),
          ),
        );
      }
      function Process({ items }) {
        const rows = Object.values(items || {});
        if (!rows.length) return null;
        return h33(
          "details",
          { className: "workagent-process" },
          h33("summary", null, "计划与过程"),
          ...rows.map((row) =>
            h33(
              "section",
              { key: row.processId },
              h33(
                "h4",
                null,
                row.kind === "plan"
                  ? "执行计划"
                  : row.kind === "commentary"
                    ? "进度说明"
                    : "引擎过程摘要",
              ),
              row.text
                ? h33("p", { style: { whiteSpace: "pre-wrap" } }, row.text)
                : null,
              Array.isArray(row.data)
                ? h33(
                    "ol",
                    null,
                    ...row.data.map((entry, index) =>
                      h33(
                        "li",
                        { key: index },
                        `${{ pending: "待开始", in_progress: "进行中", completed: "已完成" }[entry.status] || entry.status || ""} · ${entry.step || entry.content || ""}`,
                      ),
                    ),
                  )
                : null,
            ),
          ),
        );
      }
      function Question({
        id,
        sessionId: sessionId2,
        children,
        onReply,
        answered = false,
        disabled = false,
      }) {
        const heading = React37.useId();
        const [reply, setReply] = useDraft(`${sessionId2}:question:${id}`);
        const [pending, setPending] = React37.useState(false);
        const [status, setStatus] = React37.useState("");
        const sending = React37.useRef(false);
        const submit = async (event) => {
          event.preventDefault();
          const content = reply.trim();
          if (!content || disabled || sending.current) return;
          sending.current = true;
          setPending(true);
          setStatus("");
          try {
            await onReply(content);
            setReply("");
            setStatus("已发送");
          } catch (cause) {
            setStatus(friendlyError2(cause.message));
          } finally {
            sending.current = false;
            setPending(false);
          }
        };
        if (answered)
          return h33(
            "article",
            {
              id: `workagent-question-${id}`,
              className: "workagent-question is-answered",
              "data-message-id": id,
              "aria-label": "补充问题",
            },
            h33(
              "details",
              null,
              h33("summary", null, "✓ 已补充"),
              ...React37.Children.toArray(children),
            ),
          );
        return h33(
          "article",
          {
            id: `workagent-question-${id}`,
            className: "workagent-question",
            "data-message-id": id,
            "aria-labelledby": heading,
          },
          h33(
            "header",
            { className: "workagent-question-heading" },
            h33(
              "svg",
              {
                width: 18,
                height: 18,
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "currentColor",
                strokeWidth: 1.5,
                strokeLinecap: "round",
                strokeLinejoin: "round",
                "aria-hidden": true,
              },
              h33("path", {
                d: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z",
              }),
              h33("path", {
                d: "M10 8.5a2 2 0 0 1 4 .5c0 1.3-2 1.5-2 3M12 15h.01",
              }),
            ),
            h33("span", { id: heading }, "补充问题"),
          ),
          ...React37.Children.toArray(children),
          onReply &&
            h33(
              "form",
              { className: "workagent-question-reply", onSubmit: submit },
              h33("textarea", {
                "aria-label": "回复补充问题",
                placeholder: "在这里补充你的回答…",
                rows: 2,
                value: reply,
                disabled: pending,
                onChange: (event) => {
                  setReply(event.target.value);
                  setStatus("");
                },
              }),
              h33(
                "div",
                { className: "workagent-question-reply-footer" },
                h33("span", { role: "status" }, status),
                h33(
                  "button",
                  {
                    type: "submit",
                    disabled: disabled || pending || !reply.trim(),
                  },
                  pending ? "发送中…" : "发送回复",
                ),
              ),
            ),
        );
      }
      function SessionReminder({ sessionId: sessionId2, onSaved }) {
        const [state, setState] = React37.useState(null);
        const [draft, setDraft] = React37.useState(null);
        const [busy, setBusy] = React37.useState(false);
        const [error, setError] = React37.useState("");
        React37.useEffect(() => {
          const controller = new AbortController();
          request2(`${apiRoot2}/completion-notifications`, {
            signal: controller.signal,
          })
            .then((value) => {
              if (!controller.signal.aborted) {
                setState(value);
                const configured = value.sessionSettings?.[sessionId2];
                const connected = (value.targets || []).filter(
                  (target) => target.connected,
                );
                setDraft({
                  enabled:
                    configured?.enabled === true ||
                    (value.enabled === true &&
                      !value.mutedSessions?.includes(sessionId2)),
                  targetId:
                    configured?.targetId ||
                    value.lastTargetId ||
                    value.targetId ||
                    connected[0]?.id ||
                    "",
                });
              }
            })
            .catch((reason) => {
              if (!controller.signal.aborted)
                setError(friendlyError2(reason.message));
            });
          return () => controller.abort();
        }, [sessionId2]);
        if (!draft) return null;
        return h33(
          "div",
          { className: "workagent-session-reminder" },
          h33("small", null, "提醒渠道"),
          h33(
            "select",
            {
              "aria-label": "当前会话接收聊天",
              value: draft.targetId,
              disabled: busy,
              onChange: (event) =>
                setDraft((value) => ({
                  ...value,
                  targetId: event.target.value,
                })),
            },
            h33("option", { value: "" }, "选择接收聊天"),
            ...(state?.targets || [])
              .filter((target) => target.connected)
              .map((target) =>
                h33(
                  "option",
                  { key: target.id, value: target.id },
                  target.label,
                ),
              ),
          ),
          h33(
            "div",
            { className: "workagent-actions" },
            h33(
              "button",
              {
                type: "button",
                className: "workagent-button",
                disabled: busy || !draft.targetId,
                onClick: async () => {
                  setBusy(true);
                  setError("");
                  try {
                    const value = await request2(
                      `${apiRoot2}/completion-notifications/session`,
                      {
                        method: "PUT",
                        body: JSON.stringify({
                          sessionId: sessionId2,
                          enabled: true,
                          targetId: draft.targetId,
                        }),
                      },
                    );
                    setState(value);
                    setDraft((current) => ({ ...current, enabled: true }));
                    onSaved?.(true);
                  } catch (reason) {
                    setError(friendlyError2(reason.message));
                  } finally {
                    setBusy(false);
                  }
                },
              },
              busy ? "保存中…" : draft.enabled ? "确认" : "开启消息提醒",
            ),
            draft.enabled
              ? h33(
                  "button",
                  {
                    type: "button",
                    className: "workagent-button",
                    disabled: busy,
                    onClick: async () => {
                      setBusy(true);
                      setError("");
                      try {
                        const value = await request2(
                          `${apiRoot2}/completion-notifications/session`,
                          {
                            method: "PUT",
                            body: JSON.stringify({
                              sessionId: sessionId2,
                              enabled: false,
                            }),
                          },
                        );
                        setState(value);
                        setDraft((current) => ({ ...current, enabled: false }));
                        onSaved?.(false);
                      } catch (reason) {
                        setError(friendlyError2(reason.message));
                      } finally {
                        setBusy(false);
                      }
                    },
                  },
                  "关闭提醒",
                )
              : null,
          ),
          !(state?.targets || []).some((target) => target.connected)
            ? h33(
                "small",
                null,
                "暂无可选聊天，请先在消息渠道中连接账号，并从目标聊天给机器人发送一条消息。",
              )
            : null,
          error ? h33("small", { role: "alert" }, error) : null,
        );
      }
      function Controls({ ctx, session, busy, cancel }) {
        const [permission, setPermission] = React37.useState(
          session?.permissionMode || "",
        );
        React37.useEffect(
          () => setPermission(session?.permissionMode || ""),
          [session?.permissionMode, session?.id],
        );
        const [catalog, setCatalog] = React37.useState(null);
        const [pending, setPending] = React37.useState([]);
        const [saving, setSaving] = React37.useState(false);
        const [error, setError] = React37.useState("");
        const sessionId2 = session?.id;
        React37.useEffect(() => {
          if (!sessionId2 || !ctx?.sessions?.binding) return;
          let live = true;
          Promise.all([
            nativeSessionAction2(ctx, sessionId2, "models"),
            session.permissionMode
              ? Promise.resolve({ permissionMode: session.permissionMode })
              : request2(
                  `${apiRoot2}/sessions/${encodeURIComponent(sessionId2)}/configuration`,
                ),
          ])
            .then(([value, configuration]) => {
              if (live) {
                setCatalog(value);
                setPermission(configuration.permissionMode || "");
              }
            })
            .catch((reason) => {
              if (live) setError(friendlyError2(reason.message));
            });
          return () => {
            live = false;
          };
        }, [ctx, sessionId2, busy, session?.permissionMode]);
        React37.useEffect(() => {
          if (!sessionId2) return;
          let live = true,
            timer;
          const refresh = async () => {
            try {
              const rows = await request2(
                `${apiRoot2}/interactions?sessionId=${encodeURIComponent(sessionId2)}`,
              );
              if (live) setPending(rows);
            } catch (reason) {
              if (live && busy) setError(friendlyError2(reason.message));
            } finally {
              if (live) timer = setTimeout(refresh, 1500);
            }
          };
          void refresh();
          return () => {
            live = false;
            clearTimeout(timer);
          };
        }, [sessionId2, busy]);
        const select = async (selection) => {
          setSaving(true);
          setError("");
          try {
            await nativeSessionAction2(
              ctx,
              sessionId2,
              "selectModel",
              selection,
            );
            setCatalog(await nativeSessionAction2(ctx, sessionId2, "models"));
          } catch (reason) {
            setError(friendlyError2(reason.message));
          } finally {
            setSaving(false);
          }
        };
        const decide = async (item, decision) => {
          setSaving(true);
          setError("");
          try {
            await request2(
              `${apiRoot2}/interactions/${encodeURIComponent(item.id)}/respond`,
              { method: "POST", body: JSON.stringify({ decision }) },
            );
            setPending((rows) => rows.filter((row) => row.id !== item.id));
          } catch (reason) {
            setError(friendlyError2(reason.message));
          } finally {
            setSaving(false);
          }
        };
        const groups = catalog?.groups || [];
        const current = catalog?.current;
        const model = groups
          .flatMap((group) => group.models)
          .find((row) => row.id === current?.model);
        return h33(
          "div",
          { className: "workagent-session-controls" },
          current
            ? h33(
                "label",
                { className: "workagent-model-choice", title: model?.name },
                h33(
                  "span",
                  {
                    className: "workagent-model-choice-label",
                    "aria-hidden": true,
                  },
                  model?.name || current.model,
                ),
                h33(
                  "select",
                  {
                    "aria-label": "当前会话模型",
                    disabled: busy || saving,
                    value: `${current.provider}/${current.model}`,
                    onChange: (event) => {
                      const [provider, ...rest] = event.target.value.split("/");
                      void select({ provider, model: rest.join("/") });
                    },
                  },
                  groups.map((group) =>
                    h33(
                      "optgroup",
                      { key: group.id, label: group.name },
                      group.models.map((row) =>
                        h33(
                          "option",
                          { key: row.id, value: `${group.id}/${row.id}` },
                          row.name,
                        ),
                      ),
                    ),
                  ),
                ),
              )
            : null,
          model?.reasoning
            ? h33(
                "label",
                null,
                h33(
                  "select",
                  {
                    "aria-label": "当前会话思考强度",
                    disabled: busy || saving,
                    value:
                      current.reasoningEffort ||
                      model.reasoning.defaultEffort ||
                      "",
                    onChange: (event) => {
                      const { reasoningEffort: _old, ...base } = current;
                      void select({
                        ...base,
                        ...(event.target.value
                          ? { reasoningEffort: event.target.value }
                          : {}),
                      });
                    },
                  },
                  !current.reasoningEffort && !model.reasoning.defaultEffort
                    ? h33(
                        "option",
                        { value: "", disabled: true, hidden: true },
                        "思考强度",
                      )
                    : null,
                  h33(
                    "optgroup",
                    { label: "思考强度" },
                    model.reasoning.efforts.map((row) =>
                      h33(
                        "option",
                        { key: row.id, value: row.id },
                        reasoningLabel2(row),
                      ),
                    ),
                  ),
                ),
              )
            : null,
          h33(
            "label",
            null,
            h33(
              "select",
              {
                "aria-label": "当前会话权限",
                value: permission,
                disabled:
                  busy ||
                  saving ||
                  !session?.id ||
                  session.engine === "harness",
                onChange: async (event) => {
                  const next = event.target.value;
                  setSaving(true);
                  setError("");
                  try {
                    const value = await request2(
                      `${apiRoot2}/sessions/${encodeURIComponent(session.id)}/configuration`,
                      {
                        method: "PATCH",
                        body: JSON.stringify({ permissionMode: next }),
                      },
                    );
                    setPermission(value.permissionMode);
                  } catch (reason) {
                    setError(friendlyError2(reason.message));
                  } finally {
                    setSaving(false);
                  }
                },
              },
              !permission
                ? h33(
                    "option",
                    { value: "", disabled: true, hidden: true },
                    "权限",
                  )
                : null,
              permission === "manual_approval"
                ? h33(
                    "option",
                    { value: "manual_approval", disabled: true, hidden: true },
                    "逐次确认",
                  )
                : null,
              h33(
                "optgroup",
                { label: "权限" },
                h33("option", { value: "read_only" }, "只读"),
                h33("option", { value: "workspace_write" }, "项目内读写"),
                h33("option", { value: "full_access" }, "完全访问"),
              ),
            ),
          ),
          pending.map((item) =>
            h33(
              "section",
              {
                className: "workagent-approval",
                key: item.id,
                "aria-label": "等待授权",
              },
              h33("strong", null, `需要授权 · ${item.tool}`),
              h33("p", null, item.summary),
              item.input !== void 0
                ? h33(
                    "details",
                    null,
                    h33("summary", null, "操作详情"),
                    h33(primitives2.CodeBlock, {
                      code: JSON.stringify(item.input, null, 2),
                      lang: "json",
                    }),
                  )
                : null,
              button("允许本次", () => void decide(item, "allow"), {
                disabled: saving,
              }),
              button("拒绝", () => void decide(item, "reject"), {
                disabled: saving,
              }),
              button("停止任务", cancel, { disabled: saving }),
            ),
          ),
          error ? h33("span", { role: "alert" }, error) : null,
        );
      }
      function usePins(key = "workagent.session-pins.v1") {
        const [pins, setPins] = React37.useState(() =>
          readStored(localStorage, key, []),
        );
        React37.useEffect(() => {
          const update = (event) => {
            if (event.key === key || event.key === null)
              setPins(readStored(localStorage, key, []));
          };
          window.addEventListener("storage", update);
          return () => window.removeEventListener("storage", update);
        }, []);
        const save = (next) => {
          setPins(next);
          saveStored(localStorage, key, next);
        };
        return {
          pins,
          toggle: (id) =>
            save(
              pins.includes(id)
                ? pins.filter((value) => value !== id)
                : [...pins, id],
            ),
          move: (id, target) => {
            if (id === target || !pins.includes(id) || !pins.includes(target))
              return;
            const next = pins.filter((value) => value !== id);
            next.splice(next.indexOf(target), 0, id);
            save(next);
          },
        };
      }
      function Notifications({ sessions = [], settings = true }) {
        const [enabled, setEnabled] = React37.useState(() =>
          readStored(localStorage, "workagent.browser-notifications", false),
        );
        const [error, setError] = React37.useState("");
        const known = React37.useRef(/* @__PURE__ */ new Map());
        React37.useEffect(() => {
          const sync = () =>
            setEnabled(
              readStored(
                localStorage,
                "workagent.browser-notifications",
                false,
              ),
            );
          window.addEventListener("storage", sync);
          window.addEventListener("workagent:notifications-changed", sync);
          return () => {
            window.removeEventListener("storage", sync);
            window.removeEventListener("workagent:notifications-changed", sync);
          };
        }, []);
        React37.useEffect(() => {
          if (!enabled || settings) return;
          let live = true,
            timer;
          async function pollApprovals() {
            try {
              const rows = await request2(`${apiRoot2}/interactions`);
              if (
                !live ||
                !(document.hidden || !document.hasFocus()) ||
                typeof Notification === "undefined" ||
                Notification.permission !== "granted"
              )
                return;
              for (const item of rows) {
                const key = `workagent.approval-notified.${item.id}`;
                if (readStored(localStorage, key, false)) continue;
                const notice = new Notification("WorkAgent · 等待确认", {
                  body: item.summary || "任务需要你确认后继续",
                  tag: `workagent-approval-${item.id}`,
                });
                saveStored(localStorage, key, true);
                notice.onclick = () => {
                  window.focus();
                  navigate(
                    `/?frontend=dsh&session=${encodeURIComponent(item.sessionId)}`,
                  );
                  notice.close();
                };
              }
            } catch {
            } finally {
              if (live) timer = setTimeout(pollApprovals, 3e3);
            }
          }
          void pollApprovals();
          return () => {
            live = false;
            clearTimeout(timer);
          };
        }, [enabled, settings]);
        React37.useEffect(() => {
          for (const session of sessions) {
            const turn = session.lastTurn;
            const previous = known.current.get(session.id);
            const current = `${turn?.id || ""}:${turn?.status || ""}`;
            known.current.set(session.id, current);
            if (
              !enabled ||
              previous === void 0 ||
              previous === current ||
              !turn ||
              turn.status !== "completed" ||
              !(document.hidden || !document.hasFocus())
            )
              continue;
            if (
              typeof Notification === "undefined" ||
              Notification.permission !== "granted"
            )
              continue;
            const key = `workagent.notified.${session.id}`;
            if (readStored(localStorage, key, "") === turn.id) continue;
            saveStored(localStorage, key, turn.id);
            const notice = new Notification("WorkAgent · 任务完成", {
              body: session.title || "对话已完成",
              tag: `workagent-${session.id}`,
            });
            notice.onclick = () => {
              window.focus();
              navigate(
                `/?frontend=dsh&session=${encodeURIComponent(session.id)}`,
              );
              notice.close();
            };
          }
        }, [sessions, enabled]);
        if (!settings) return null;
        return h33(
          "div",
          { className: "workagent-browser-notifications" },
          button(enabled ? "关闭桌面提醒" : "开启桌面提醒", async () => {
            setError("");
            if (enabled) {
              setEnabled(false);
              saveStored(
                localStorage,
                "workagent.browser-notifications",
                false,
              );
              window.dispatchEvent(
                new Event("workagent:notifications-changed"),
              );
              return;
            }
            if (typeof Notification === "undefined") {
              setError("此浏览器不支持桌面提醒。");
              return;
            }
            try {
              const granted =
                (await Notification.requestPermission()) === "granted";
              setEnabled(granted);
              saveStored(
                localStorage,
                "workagent.browser-notifications",
                granted,
              );
              window.dispatchEvent(
                new Event("workagent:notifications-changed"),
              );
              if (!granted) setError("请在浏览器站点设置中允许通知。");
            } catch {
              setError("无法开启桌面提醒。");
            }
          }),
          error ? h33("small", { role: "status" }, error) : null,
        );
      }
      function ComposerTools({
        session,
        input,
        setInput,
        onError,
        disabled,
        onBusyChange,
      }) {
        const uploadInput = React37.useRef(null);
        const uploadToProject = useUploadToProject2();
        const uploadControl = React37.useRef(null);
        const [uploadProgress, setUploadProgress] = React37.useState(null);
        const [uploading, setUploading] = React37.useState(false);
        const [directory, setDirectory] = React37.useState("");
        const [entries, setEntries] = React37.useState([]);
        const [filesOpen, setFilesOpen] = React37.useState(false);
        const [commandsOpen, setCommandsOpen] = React37.useState(false);
        const mention = /(?:^|\s)@([^\s]*)$/.exec(input)?.[1];
        const showingFiles = filesOpen || mention !== void 0;
        const workspaceId = session?.workspaceId;
        const live = React37.useRef(true);
        React37.useEffect(() => {
          live.current = true;
          return () => {
            live.current = false;
            uploadControl.current?.abort();
          };
        }, []);
        React37.useEffect(() => {
          if (!showingFiles || !workspaceId) return;
          const abort = new AbortController();
          request2(
            `${workspaceEndpoint(workspaceId)}/files?path=${encodeURIComponent(directory)}`,
            { signal: abort.signal },
          )
            .then((rows) => {
              if (!abort.signal.aborted) setEntries(rows);
            })
            .catch((error) => {
              if (!abort.signal.aborted) onError(error.message);
            });
          return () => abort.abort();
        }, [workspaceId, showingFiles, directory]);
        const insert = async (path, savedEntry) => {
          let entry = savedEntry;
          try {
            entry ??= await request2(
              `${workspaceEndpoint(workspaceId)}/locate?path=${encodeURIComponent(path)}`,
            );
          } catch (error) {
            onError(friendlyError2(error.message));
            return;
          }
          const reference = fileReferenceText({
            fileId: entry.fileId,
            workspaceId,
            path,
            name: path.split("/").at(-1),
          });
          const editor = uploadInput.current
            ?.closest("form")
            ?.querySelector(".workagent-composer-input");
          if (mention === void 0 && editor?.workagentInsertReference)
            editor.workagentInsertReference(reference + " ");
          else
            setInput(
              (value) =>
                `${value.replace(/(?:^|\s)@[^\s]*$/, "")}${value && !/\s$/.test(value) ? " " : ""}${reference} `,
            );
        };
        const upload = async (files) => {
          if (uploadControl.current || disabled) return;
          if (!workspaceId) {
            onError("请先选择一个已有项目，再添加文件。");
            return;
          }
          setUploading(true);
          const controller = new AbortController();
          uploadControl.current = controller;
          onBusyChange?.(true);
          onError("");
          try {
            const { failures } = await uploadFiles(workspaceId, files, {
              signal: controller.signal,
              stopOnError: true,
              destination: (file) => {
                const name = file.name.replace(/[\\/:*?"<>|]/g, "_");
                if (uploadToProject) return { path: name, conflict: "rename" };
                const resumePrefix = `.workagent-attachments/${session.id}/`;
                return {
                  path: `${resumePrefix}${crypto.randomUUID()}/${name}`,
                  resumePrefix,
                };
              },
              onProgress: (progress) => {
                if (live.current) setUploadProgress(progress);
              },
              onUploaded: async (path, _file, savedEntry) => {
                if (live.current) await insert(path, savedEntry);
              },
            });
            if (live.current) onError(failures.join("；"));
            window.dispatchEvent(new Event("workagent:files-changed"));
          } catch (error) {
            if (live.current) onError(error.message);
          } finally {
            uploadControl.current = null;
            window.dispatchEvent(new Event("workagent:files-changed"));
            if (live.current) {
              setUploading(false);
              setUploadProgress(null);
              onBusyChange?.(false);
            }
          }
        };
        React37.useEffect(() => {
          return bindComposerFiles(
            uploadInput.current,
            upload,
            uploading || disabled || !workspaceId,
          );
        }, [
          workspaceId,
          uploading,
          disabled,
          setInput,
          uploadToProject,
          mention,
        ]);
        const skills = session?.preset?.resolvedSnapshot?.skillIds || [];
        const slash = /^\/([^\s]*)$/.exec(input);
        const commands = [
          { id: "btw", label: "发起侧聊", text: "/btw " },
          ...skills.map((id) => ({
            id,
            label: `使用已加载技能 ${id}`,
            text: `请使用当前助手已加载的技能 ${JSON.stringify(id)} 处理以下任务：
`,
          })),
        ].filter(
          (row) =>
            !slash || row.id.toLowerCase().includes(slash[1].toLowerCase()),
        );
        React37.useEffect(() => {
          const form = uploadInput.current?.closest("form");
          if (!form) return;
          const navigate2 = (event) => {
            if (
              !event.target.matches('textarea, [contenteditable="true"]') ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              !["Tab", "ArrowDown"].includes(event.key)
            )
              return;
            const first = form.querySelector(".workagent-composer-menu button");
            if (!first) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Tab" && !event.shiftKey) first.click();
            else first.focus();
          };
          form.addEventListener("keydown", navigate2, true);
          return () => form.removeEventListener("keydown", navigate2, true);
        }, []);
        return h33(
          "div",
          { className: "workagent-composer-tools" },
          h33("input", {
            ref: uploadInput,
            type: "file",
            multiple: true,
            hidden: true,
            "aria-label": "选择会话附件",
            onChange: (event) => {
              const files = [...event.target.files];
              event.target.value = "";
              void upload(files);
            },
          }),
          button(
            Icon2 ? h33(Icon2, { name: "plus", size: 18 }) : "+",
            () => uploadInput.current.click(),
            {
              disabled: disabled || uploading || !workspaceId,
              "aria-label": uploading ? "正在上传…" : "附件",
              className: "workagent-attachment-button",
              title: uploadToProject
                ? "上传到当前项目；支持粘贴和拖放"
                : "添加会话附件；支持粘贴和拖放",
            },
          ),
          h33(Voice, { setInput, onError, disabled: disabled || uploading }),
          uploadProgress
            ? h33(
                "div",
                null,
                uploadProgress.name,
                h33("progress", {
                  max: uploadProgress.size || 1,
                  value: uploadProgress.bytes,
                }),
                button("暂停上传", () => uploadControl.current?.abort()),
              )
            : null,
          showingFiles
            ? h33(
                "div",
                {
                  className: "workagent-composer-menu",
                  "aria-label": "引用项目文件",
                },
                directory
                  ? button("上级目录", () =>
                      setDirectory(directory.split("/").slice(0, -1).join("/")),
                    )
                  : null,
                entries
                  .filter(
                    (entry) =>
                      mention === void 0 ||
                      entry.name.toLowerCase().includes(mention.toLowerCase()),
                  )
                  .map((entry) =>
                    button(
                      `${entry.kind === "directory" ? "▸ " : ""}${entry.name}`,
                      () => {
                        if (entry.kind === "directory")
                          setDirectory(entry.path);
                        else {
                          insert(entry.path);
                          setFilesOpen(false);
                        }
                      },
                      { key: entry.path },
                    ),
                  ),
                entries.length ? null : h33("span", null, "此目录没有文件"),
              )
            : null,
          slash || commandsOpen
            ? h33(
                "div",
                {
                  className: "workagent-composer-menu",
                  "aria-label": "命令与已加载技能",
                },
                commands.map((command) =>
                  button(
                    `/${command.id} · ${command.label}`,
                    () => {
                      setInput((value) =>
                        slash
                          ? command.text
                          : `${value}${value ? "\n" : ""}${command.text}`,
                      );
                      setCommandsOpen(false);
                    },
                    { key: command.id },
                  ),
                ),
              )
            : null,
        );
      }
      function Voice({ setInput, onError, disabled }) {
        const [capability, setCapability] = React37.useState(null);
        const [state, setState] = React37.useState("idle");
        const recording = React37.useRef(null);
        const live = React37.useRef(true);
        React37.useEffect(() => {
          live.current = true;
          request2("/api/speech/capability")
            .then((value) => {
              if (live.current) setCapability(value);
            })
            .catch(() => {});
          return () => {
            live.current = false;
            recording.current?.stop();
          };
        }, []);
        const start = async () => {
          if (state === "recording") {
            recording.current?.stop();
            return;
          }
          setState("starting");
          onError("");
          let stream;
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (!live.current) {
              stream.getTracks().forEach((track) => track.stop());
              return;
            }
            const recorder = new MediaRecorder(stream);
            const parts = [];
            let timer;
            const stop = () => {
              clearTimeout(timer);
              if (recorder.state !== "inactive") recorder.stop();
              stream.getTracks().forEach((track) => track.stop());
            };
            recording.current = { stop };
            recorder.ondataavailable = (event) => {
              if (event.data.size) parts.push(event.data);
            };
            recorder.onstop = async () => {
              clearTimeout(timer);
              stream.getTracks().forEach((track) => track.stop());
              recording.current = null;
              if (!live.current) return;
              setState("transcribing");
              try {
                const blob = new Blob(parts, { type: recorder.mimeType });
                if (
                  capability.maxAudioBytes &&
                  blob.size > capability.maxAudioBytes
                )
                  throw new Error("录音超过大小限制，请缩短后重试。");
                const data = new FormData();
                data.append(
                  "file",
                  blob,
                  recorder.mimeType.includes("mp4")
                    ? "recording.mp4"
                    : "recording.webm",
                );
                const response = await fetch("/api/stt", {
                  method: "POST",
                  credentials: "same-origin",
                  body: data,
                });
                const result = await response.json();
                if (!response.ok || result.success === false)
                  throw new Error(result.error || "语音转写失败");
                const text = result.data?.text ?? result.text;
                if (typeof text !== "string")
                  throw new Error("转写服务没有返回文字。");
                if (live.current)
                  setInput((value) => `${value}${value ? "\n" : ""}${text}`);
              } catch (error) {
                if (live.current) onError(error.message);
              } finally {
                if (live.current) setState("idle");
              }
            };
            recorder.start();
            setState("recording");
            timer = setTimeout(
              stop,
              Math.min(capability.maxStreamSeconds || 60, 300) * 1e3,
            );
          } catch (error) {
            stream?.getTracks().forEach((track) => track.stop());
            if (live.current) {
              setState("idle");
              onError(error.message);
            }
          }
        };
        if (!capability?.enabled) return null;
        const available = Boolean(
          navigator.mediaDevices?.getUserMedia &&
            typeof MediaRecorder !== "undefined",
        );
        return button(
          {
            idle: "语音输入",
            starting: "正在开启麦克风…",
            recording: "停止并转写",
            transcribing: "正在转写…",
          }[state],
          () => void start(),
          {
            disabled:
              !available ||
              disabled ||
              ["starting", "transcribing"].includes(state),
            title: available
              ? "转写后填入草稿，由你确认发送"
              : "请使用支持麦克风的 HTTPS 或本机浏览器连接",
            "aria-pressed": state === "recording",
          },
        );
      }
      function TextEditor({
        workspaceId,
        path,
        fileId,
        original,
        onSaved,
        onCancel,
        onDirty,
      }) {
        const key = `workagent.file-draft.${workspaceId}.${fileId || path}`;
        const { confirm, confirmation } = useConfirm();
        const [draft] = React37.useState(() =>
          readStored(sessionStorage, key, null),
        );
        const [base] = React37.useState(draft?.base ?? original);
        const [text, setText] = React37.useState(draft?.text ?? original);
        const [diff, setDiff] = React37.useState(false);
        const [busy, setBusy] = React37.useState(false);
        const [error, setError] = React37.useState("");
        const dirty = text !== base;
        const leaseOwner = React37.useRef(crypto.randomUUID());
        React37.useEffect(() => {
          if (!dirty) return;
          const url = `${workspaceEndpoint(workspaceId)}/move`;
          const hold = () =>
            request2(url, {
              method: "POST",
              body: JSON.stringify({
                action: "lease",
                owner: leaseOwner.current,
                path,
              }),
            }).catch((error2) => setError(friendlyError2(error2.message)));
          void hold();
          const timer = setInterval(hold, 15e3);
          return () => {
            clearInterval(timer);
            void request2(url, {
              method: "POST",
              body: JSON.stringify({
                action: "lease",
                owner: leaseOwner.current,
              }),
            }).catch(() => {});
          };
        }, [workspaceId, path, dirty]);
        React37.useEffect(() => {
          if (dirty) saveStored(sessionStorage, key, { base, text });
          else sessionStorage.removeItem(key);
          onDirty?.(dirty);
        }, [key, base, text, dirty, onDirty]);
        React37.useEffect(() => {
          if (!dirty) return;
          const warn = (event) => {
            event.preventDefault();
            event.returnValue = "";
          };
          window.addEventListener("beforeunload", warn);
          return () => window.removeEventListener("beforeunload", warn);
        }, [dirty]);
        return h33(
          "div",
          { className: "workagent-text-editor" },
          confirmation,
          h33(
            "p",
            { role: "status" },
            dirty ? "有未保存修改 · 草稿保存在当前浏览器标签页" : "尚无修改",
          ),
          base !== original
            ? h33(
                "p",
                { role: "alert" },
                "文件已在其他位置修改。保留了你的草稿；保存时会检查冲突。",
              )
            : null,
          h33(
            "div",
            { className: "workagent-editor-body" },
            diff
              ? h33(primitives2.DiffBlock, {
                  diffs: [{ path, oldText: base, newText: text }],
                  maxLines: 80,
                })
              : null,
            h33("textarea", {
              hidden: diff,
              "aria-label": "编辑文件内容",
              value: text,
              onChange: (event) => setText(event.target.value),
              spellCheck: false,
            }),
          ),
          h33(
            "div",
            { className: "workagent-editor-actions" },
            button(diff ? "返回编辑" : "查看修改对比", () => setDiff(!diff)),
            button(
              busy ? "正在保存…" : "保存文件",
              async () => {
                setBusy(true);
                setError("");
                try {
                  await request2(fileURL2(workspaceId, path, false, fileId), {
                    method: "PATCH",
                    body: JSON.stringify({ original: base, text }),
                  });
                  sessionStorage.removeItem(key);
                  onDirty?.(false);
                  onSaved(text);
                  window.dispatchEvent(new Event("workagent:files-changed"));
                } catch (reason) {
                  setError(friendlyError2(reason.message));
                } finally {
                  setBusy(false);
                }
              },
              { disabled: busy },
            ),
            button(
              "取消编辑",
              async () => {
                if (
                  dirty &&
                  !(await confirm({
                    description: "放弃此文件的未保存修改？",
                    danger: true,
                    confirmLabel: "放弃修改",
                  }))
                )
                  return;
                sessionStorage.removeItem(key);
                onDirty?.(false);
                onCancel();
              },
              { disabled: busy },
            ),
          ),
          error ? h33("p", { role: "alert" }, error) : null,
        );
      }
      return {
        FileComposer,
        Artifacts,
        Process,
        Question,
        Markdown: Markdown2,
        Controls,
        Tools,
        useDraft,
        clearDrafts,
        usePins,
        Notifications,
        SessionReminder,
        ComposerTools,
        TextEditor,
        workspaceDestination,
      };
    }

    // src/features/content/index.js
    var primitives = __toESM(
      require("@deepseek-ai/dsh-client-ui-primitives"),
      1,
    );
    var import_react19 = __toESM(require("react"), 1);
    var workbench = createWorkbench({
      navigate: navigation.navigate,
      reasoningLabel,
      Icon,
      uploadFiles: uploads.uploadFiles,
      useUploadToProject,
      friendlyError,
      React: import_react19.default,
      primitives,
      request,
      apiRoot,
      fileURL,
      workspaceEndpoint: workspaceFileRoot,
      nativeSessionAction,
    });
    var Markdown = workbench.Markdown;

    // src/ui/conversation-management.js
    var import_react20 = require("react");
    function ConversationMenu({
      title,
      projectName,
      pinned,
      onPin,
      onReminder,
      onManage,
      onClose,
      busy = false,
      error,
    }) {
      return (0, import_react20.createElement)(
        Dialog,
        { title, "aria-label": "对话操作", onClose, closeDisabled: busy },
        projectName
          ? (0, import_react20.createElement)(
              "small",
              null,
              `项目：${projectName}`,
            )
          : null,
        (0, import_react20.createElement)(
          ActionList,
          null,
          onPin
            ? (0, import_react20.createElement)(
                Button,
                { onClick: onPin, disabled: busy },
                (0, import_react20.createElement)(Icon, { name: "pin" }),
                pinned ? "取消置顶" : "置顶对话",
              )
            : null,
          onReminder
            ? (0, import_react20.createElement)(
                Button,
                { onClick: onReminder, disabled: busy },
                (0, import_react20.createElement)(Icon, {
                  name: "notifications",
                }),
                "消息提醒",
              )
            : null,
          (0, import_react20.createElement)(
            Button,
            { onClick: onManage, disabled: busy },
            (0, import_react20.createElement)(Icon, { name: "edit" }),
            "管理对话",
          ),
        ),
        error
          ? (0, import_react20.createElement)(
              "p",
              { role: "alert", className: "workagent-error" },
              error,
            )
          : null,
      );
    }
    function ConversationManagementDialog({
      title,
      name,
      onNameChange,
      onSave,
      onDelete,
      onRequestDelete,
      onClose,
      busy = false,
      error,
      deleting = false,
      deleteDescription = "删除后，这个对话将不再显示。",
    }) {
      return (0, import_react20.createElement)(
        Dialog,
        {
          title: title || (deleting ? "确认删除" : "管理对话"),
          as: "form",
          onClose,
          closeDisabled: busy,
          onSubmit: (event) => {
            event.preventDefault();
            if (busy || (!deleting && !name.trim())) return;
            if (deleting) onDelete(event);
            else onSave(event);
          },
        },
        deleting
          ? (0, import_react20.createElement)("p", null, deleteDescription)
          : (0, import_react20.createElement)(Input, {
              "aria-label": "对话名称",
              autoFocus: true,
              value: name,
              onChange: (event) => onNameChange(event.target.value),
              disabled: busy,
              required: true,
              maxLength: 120,
            }),
        error
          ? (0, import_react20.createElement)(
              "p",
              { role: "alert", className: "workagent-error" },
              error,
            )
          : null,
        (0, import_react20.createElement)(
          "div",
          { className: "workagent-dialog-actions" },
          (0, import_react20.createElement)(
            Button,
            {
              type: "submit",
              variant: deleting ? "danger" : "primary",
              disabled: busy || (!deleting && !name.trim()),
            },
            deleting ? (busy ? "删除中…" : "删除") : busy ? "保存中…" : "保存",
          ),
          !deleting
            ? (0, import_react20.createElement)(
                Button,
                { variant: "danger", onClick: onRequestDelete, disabled: busy },
                "删除",
              )
            : null,
          (0, import_react20.createElement)(
            Button,
            { onClick: onClose, disabled: busy },
            "取消",
          ),
        ),
      );
    }

    // src/ui/sidebar.js
    var import_react21 = require("react");
    function SidebarPin({ pinned = true }) {
      return (0, import_react21.createElement)(Icon, {
        name: "pin",
        size: 14,
        className: `workagent-sidebar-pin${pinned ? " is-pinned" : ""}`,
      });
    }
    function SidebarAction({ label, icon = "more", children, ...props }) {
      return (0, import_react21.createElement)(
        "button",
        {
          type: "button",
          className: "workagent-row-action",
          "aria-label": label,
          title: label,
          ...props,
        },
        children ||
          (icon === "pin"
            ? (0, import_react21.createElement)(SidebarPin, {
                pinned: props["aria-pressed"] === true,
              })
            : (0, import_react21.createElement)(Icon, {
                name: icon,
                size: 14,
              })),
      );
    }
    function SidebarStatus({ running, unread, label }) {
      if (!running && !unread) return null;
      return (0, import_react21.createElement)("span", {
        className: `workagent-session-status ${running ? "is-running" : "is-unread"}`,
        role: "img",
        "aria-label": label || (running ? "正在运行" : "未读"),
        title: label || (running ? "正在运行" : "未读"),
      });
    }
    function SidebarRow({
      title,
      subtitle,
      icon = (0, import_react21.createElement)(Icon, {
        name: "chat",
        size: 16,
      }),
      status,
      meta,
      pinned = false,
      selected = false,
      onOpen,
      actions,
      leading,
      rowProps = {},
      buttonProps = {},
      kind = "session",
      children,
    }) {
      return (0, import_react21.createElement)(
        "div",
        {
          ...rowProps,
          className: [
            kind === "project"
              ? "workagent-sidebar-project-row"
              : "workagent-sidebar-session",
            rowProps.className,
          ]
            .filter(Boolean)
            .join(" "),
        },
        leading,
        (0, import_react21.createElement)(
          "button",
          {
            type: "button",
            onClick: onOpen,
            "aria-current": selected ? "page" : void 0,
            ...buttonProps,
            className: [
              "is-main",
              selected && "is-active",
              buttonProps.className,
            ]
              .filter(Boolean)
              .join(" "),
          },
          icon,
          (0, import_react21.createElement)(
            "span",
            { className: "workagent-sidebar-label" },
            (0, import_react21.createElement)(
              "span",
              { className: "workagent-session-title" },
              title,
            ),
            subtitle
              ? (0, import_react21.createElement)(
                  "span",
                  { className: "workagent-sidebar-subtitle" },
                  subtitle,
                )
              : null,
          ),
          status,
          meta || pinned
            ? (0, import_react21.createElement)(
                "span",
                { className: "workagent-sidebar-meta" },
                meta,
                pinned ? (0, import_react21.createElement)(SidebarPin) : null,
              )
            : null,
        ),
        actions,
        children,
      );
    }
    function SidebarGroup({
      title,
      icon,
      expanded,
      onToggle,
      actions,
      badge,
      pinned = false,
      children,
      ...props
    }) {
      return (0, import_react21.createElement)(
        "section",
        {
          ...props,
          className: ["workagent-sidebar-project", props.className]
            .filter(Boolean)
            .join(" "),
        },
        (0, import_react21.createElement)(SidebarRow, {
          kind: "project",
          title,
          icon: (0, import_react21.createElement)(
            "span",
            { className: "workagent-sidebar-group-icons" },
            (0, import_react21.createElement)(Icon, {
              name: expanded ? "chevronDown" : "chevronRight",
              size: 13,
            }),
            icon,
          ),
          meta: badge,
          pinned,
          onOpen: onToggle,
          buttonProps: { "aria-expanded": expanded },
          actions,
        }),
        expanded
          ? (0, import_react21.createElement)(
              "div",
              { className: "workagent-sidebar-project-sessions" },
              children,
            )
          : null,
      );
    }
    function SidebarHeader({
      title,
      heading,
      expanded,
      onToggle,
      actions,
      children,
    }) {
      return (0, import_react21.createElement)(
        "div",
        { className: "workagent-sidebar-heading" },
        heading ||
          (onToggle
            ? (0, import_react21.createElement)(
                "button",
                {
                  type: "button",
                  className: "workagent-sidebar-section-toggle",
                  "aria-expanded": expanded,
                  "aria-label": `${expanded ? "收起" : "展开"}${title}`,
                  onClick: onToggle,
                },
                (0, import_react21.createElement)(Icon, {
                  name: expanded ? "chevronDown" : "chevronRight",
                  size: 13,
                }),
                (0, import_react21.createElement)("span", null, title),
              )
            : (0, import_react21.createElement)(
                "span",
                { className: "workagent-sidebar-section-label" },
                title,
              )),
        (0, import_react21.createElement)(
          "div",
          { className: "workagent-sidebar-heading-actions" },
          actions,
          children,
        ),
      );
    }
    function SidebarSearch(props) {
      return (0, import_react21.createElement)("input", {
        type: "text",
        ...props,
        className: "workagent-sidebar-search",
      });
    }

    // src/features/files/preview.js
    var import_react22 = __toESM(require("react"), 1);
    var import_react23 = require("react");
    function FileIconButton({ name, label, ...props }) {
      return (0, import_react23.createElement)(
        "button",
        {
          type: "button",
          className: "workagent-file-icon-button",
          title: label,
          "aria-label": label,
          ...props,
        },
        (0, import_react23.createElement)(Icon, { name, size: 17 }),
      );
    }
    function FileTreeRow({ depth = 0, className = "", ...props }) {
      return (0, import_react23.createElement)("div", {
        ...props,
        className: `workagent-file-tree-row ${className}`,
        style: { "--file-depth": depth, ...props.style },
      });
    }
    var documentPreviewTemplate;
    function loadDocumentPreview() {
      if (!documentPreviewTemplate) {
        const root = "/plugins/@workagent/dsh-client/";
        documentPreviewTemplate = Promise.all([
          request(`${root}document-preview.html`),
          request(`${root}jszip.js`),
          request(`${root}docx-preview.js`),
        ])
          .then(([html, zip, docx]) =>
            html
              .replace("__JSZIP_SOURCE__", () =>
                zip.replace(/<\/script/gi, "<\\/script"),
              )
              .replace("__DOCX_SOURCE__", () =>
                docx.replace(/<\/script/gi, "<\\/script"),
              ),
          )
          .catch((error) => {
            documentPreviewTemplate = null;
            throw error;
          });
      }
      return documentPreviewTemplate;
    }
    function DocxPreview({ title, html, data }) {
      const frame = import_react22.default.useRef(null);
      const sendTypography = import_react22.default.useCallback(() => {
        const size = document.documentElement.dataset.workagentFontSize;
        frame.current.contentWindow.postMessage(
          {
            type: "workagent:document-typography",
            inputSize: size === "18" ? 20 : size === "16" ? 18 : 16,
          },
          "*",
        );
      }, []);
      import_react22.default.useEffect(() => {
        const observer = new MutationObserver(sendTypography);
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-workagent-font-size"],
        });
        return () => observer.disconnect();
      }, [sendTypography]);
      return (0, import_react23.createElement)("iframe", {
        ref: frame,
        title,
        sandbox: "allow-scripts",
        srcDoc: html,
        onLoad: () => {
          sendTypography();
          frame.current.contentWindow.postMessage(
            { type: "workagent:document", data },
            "*",
          );
        },
      });
    }
    function WorkspaceFilePreview({
      workspace,
      entry,
      revision,
      onClose,
      onDismiss,
      dismissLabel = "关闭文件侧栏",
      onDirty,
      active,
      contentURL = fileURL,
      resolveOfficePreview,
      editable = true,
    }) {
      const [state, setState] = import_react22.default.useState({
        loading: true,
      });
      const [source, setSource] = import_react22.default.useState(false);
      const [editingFile, setEditingFile] =
        import_react22.default.useState(false);
      const [maximized, setMaximized] = import_react22.default.useState(false);
      const locatedLine = import_react22.default.useRef(null);
      import_react22.default.useEffect(() => {
        if (active) locatedLine.current?.scrollIntoView?.({ block: "center" });
      }, [entry.line, state.text, active]);
      import_react22.default.useEffect(() => {
        if (!active) setMaximized(false);
      }, [active]);
      const reportDirty = import_react22.default.useCallback(
        (value) => onDirty?.(entry.path, value),
        [onDirty, entry.path],
      );
      const extension = entry.name.toLowerCase().split(".").pop();
      import_react22.default.useEffect(() => {
        if (active === false) return;
        const controller = new AbortController();
        let objectURL;
        setState({ loading: true });
        setSource(false);
        const load = async () => {
          try {
            const inline = contentURL(workspace.id, entry.path, true);
            if (extension === "pdf") {
              const response2 = await fetch(inline, {
                signal: controller.signal,
              });
              if (!response2.ok) throw new Error("file_not_found");
              await response2.body?.cancel();
              if (controller.signal.aborted) return;
              setState({
                media: "pdf",
                url: `${inline}#navpanes=0&toolbar=1`,
              });
              return;
            }
            if (extension === "docx") {
              if (entry.size > 25 * 1024 * 1024)
                throw new Error("file_too_large");
              const [response2, template] = await Promise.all([
                fetch(inline, { signal: controller.signal }),
                loadDocumentPreview(),
              ]);
              if (!response2.ok) throw new Error("file_not_found");
              const data = await response2.arrayBuffer();
              if (!controller.signal.aborted)
                setState({
                  media: "docx",
                  data,
                  html: template,
                });
              return;
            }
            if (["xlsx", "pptx"].includes(extension)) {
              const url = resolveOfficePreview
                ? await resolveOfficePreview(
                    workspace,
                    entry,
                    controller.signal,
                  )
                : await request(`${apiRoot}/office-preview/convert`, {
                    method: "POST",
                    signal: controller.signal,
                    body: JSON.stringify({
                      workspace: workspace.directory || workspace.id,
                      path: entry.path,
                    }),
                  }).then(
                    (value) =>
                      `${apiRoot}/office-preview/content/${encodeURIComponent(value.hash)}.pdf`,
                  );
              const response2 = await fetch(url, { signal: controller.signal });
              if (
                !response2.ok ||
                !response2.headers
                  .get("content-type")
                  ?.includes("application/pdf")
              )
                throw new Error("office_preview_not_found");
              await response2.body?.cancel();
              if (!controller.signal.aborted)
                setState({
                  media: "pdf",
                  url: `${url}#view=FitH&navpanes=0&toolbar=1`,
                });
              return;
            }
            const images = {
              png: "image/png",
              jpg: "image/jpeg",
              jpeg: "image/jpeg",
              gif: "image/gif",
              webp: "image/webp",
              svg: "image/svg+xml",
              bmp: "image/bmp",
              avif: "image/avif",
              ico: "image/x-icon",
            };
            const textFile =
              [
                "txt",
                "md",
                "markdown",
                "csv",
                "tsv",
                "json",
                "yaml",
                "yml",
                "log",
                "js",
                "ts",
                "tsx",
                "jsx",
                "css",
                "scss",
                "html",
                "htm",
                "xml",
                "py",
                "go",
                "rs",
                "java",
                "c",
                "cpp",
                "h",
                "hpp",
                "ps1",
                "sh",
                "bat",
                "toml",
                "ini",
                "sql",
                "diff",
                "patch",
                "env",
              ].includes(extension) || !entry.name.includes(".");
            if (!images[extension] && !textFile) {
              setState({ media: "unsupported" });
              return;
            }
            if (entry.size > (images[extension] ? 25 : 2) * 1024 * 1024) {
              setState({ error: "文件较大，请下载后查看。" });
              return;
            }
            const response = await fetch(inline, {
              credentials: "same-origin",
              signal: controller.signal,
            });
            if (!response.ok)
              throw new Error(
                response.status === 404
                  ? "file_not_found"
                  : "workspace_operation_failed",
              );
            if (images[extension]) {
              const data = await response.arrayBuffer();
              if (controller.signal.aborted) return;
              objectURL = URL.createObjectURL(
                new Blob([data], { type: images[extension] }),
              );
              setState({ media: "image", url: objectURL });
            } else {
              const text = await response.text();
              if (!controller.signal.aborted)
                setState({
                  media: ["md", "markdown"].includes(extension)
                    ? "markdown"
                    : ["html", "htm"].includes(extension)
                      ? "html"
                      : "text",
                  text,
                });
            }
          } catch (error) {
            if (!controller.signal.aborted)
              setState({
                error: ["docx", "xlsx", "pptx"].includes(extension)
                  ? "文档转换暂不可用，可下载原文件查看。"
                  : friendlyError(error.message),
              });
          }
        };
        void load();
        return () => {
          controller.abort();
          if (objectURL) URL.revokeObjectURL(objectURL);
        };
      }, [workspace.id, entry.path, revision, active]);
      const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">${state.text || ""}`;
      return (0, import_react23.createElement)(
        "section",
        {
          className: `workagent-file-preview-pane${maximized ? " is-maximized" : ""}`,
          "aria-label": "文件预览",
          onKeyDown: (event) => {
            if (event.key === "Escape" && maximized) {
              event.stopPropagation();
              setMaximized(false);
            }
          },
        },
        (0, import_react23.createElement)(
          "header",
          null,
          (0, import_react23.createElement)(FileIconButton, {
            name: "back",
            label: "返回文件列表",
            onClick: onClose,
          }),
          (0, import_react23.createElement)(
            "strong",
            { title: entry.path },
            entry.name,
          ),
          editable && state.text !== void 0 && !editingFile
            ? (0, import_react23.createElement)(
                "button",
                { type: "button", onClick: () => setEditingFile(true) },
                "编辑文件",
              )
            : null,
          ["markdown", "html"].includes(state.media)
            ? (0, import_react23.createElement)(
                "button",
                { type: "button", onClick: () => setSource(!source) },
                source ? "预览" : "源码",
              )
            : null,
          (0, import_react23.createElement)(FileIconButton, {
            name: "expand",
            label: maximized ? "还原文件预览" : "最大化文件预览",
            onClick: () => setMaximized(!maximized),
          }),
          (0, import_react23.createElement)(
            "a",
            {
              href: contentURL(workspace.id, entry.path),
              download: entry.name,
              "aria-label": `下载 ${entry.name}`,
              title: "下载原文件",
            },
            (0, import_react23.createElement)(Icon, {
              name: "download",
              size: 17,
            }),
          ),
          (0, import_react23.createElement)(FileIconButton, {
            name: "close",
            label: dismissLabel,
            onClick: onDismiss,
          }),
        ),
        (0, import_react23.createElement)(
          "div",
          { className: "workagent-file-preview-body" },
          editingFile && state.text !== void 0
            ? (0, import_react23.createElement)(workbench.TextEditor, {
                key: entry.path,
                workspaceId: workspace.id,
                path: entry.path,
                fileId: entry.fileId,
                original: state.text,
                onDirty: reportDirty,
                onCancel: () => setEditingFile(false),
                onSaved: (text) => {
                  setState((current) => ({ ...current, text }));
                  setEditingFile(false);
                },
              })
            : state.loading
              ? (0, import_react23.createElement)(
                  "p",
                  { role: "status" },
                  "正在加载预览…",
                )
              : state.error
                ? (0, import_react23.createElement)(
                    "p",
                    { role: "alert" },
                    state.error,
                  )
                : state.media === "docx"
                  ? (0, import_react23.createElement)(DocxPreview, {
                      key: `${entry.path}:${revision}`,
                      title: entry.name,
                      html: state.html,
                      data: state.data,
                    })
                  : state.media === "image"
                    ? (0, import_react23.createElement)("img", {
                        src: state.url,
                        alt: entry.name,
                      })
                    : state.media === "pdf"
                      ? (0, import_react23.createElement)("iframe", {
                          src: state.url,
                          title: entry.name,
                        })
                      : state.media === "html" && !source && !entry.line
                        ? (0, import_react23.createElement)("iframe", {
                            srcDoc: html,
                            sandbox: "",
                            title: entry.name,
                          })
                        : state.media === "markdown" && !source && !entry.line
                          ? (0, import_react23.createElement)(
                              Markdown,
                              null,
                              state.text,
                            )
                          : state.text !== void 0
                            ? (0, import_react23.createElement)(
                                "pre",
                                null,
                                entry.line
                                  ? state.text.split("\n").map((line, index) =>
                                      (0, import_react23.createElement)(
                                        "span",
                                        {
                                          key: index,
                                          ref:
                                            index + 1 === entry.line
                                              ? locatedLine
                                              : void 0,
                                          className:
                                            index + 1 === entry.line
                                              ? "workagent-located-line"
                                              : void 0,
                                          style: { display: "block" },
                                        },
                                        `${index + 1}  ${line}`,
                                      ),
                                    )
                                  : state.text,
                              )
                            : (0, import_react23.createElement)(
                                "p",
                                null,
                                "此格式暂不支持在线预览，请下载后查看。",
                              ),
        ),
      );
    }

    // src/features/collaboration/shared.js
    function sortProjectsByChat(projects, conversations, pinned = []) {
      const latest = /* @__PURE__ */ new Map();
      for (const conversation of conversations) {
        if (conversation.hidden || conversation.branchKind === "side_chat")
          continue;
        const projectId = conversation.workspaceId ?? conversation.project_id;
        const time2 = Date.parse(
          conversation.updatedAt ?? conversation.updated_at,
        );
        if (time2 > (latest.get(projectId) ?? 0)) latest.set(projectId, time2);
      }
      const time = (project) =>
        latest.get(project.id) ?? (Date.parse(project.createdAt) || 0);
      return projects
        .slice()
        .sort(
          (a, b) =>
            Number(pinned.includes(b.id)) - Number(pinned.includes(a.id)) ||
            time(b) - time(a),
        );
    }
    function reconcileSharedMentions(before, after, mentions) {
      let start = 0;
      while (
        start < before.length &&
        start < after.length &&
        before[start] === after[start]
      )
        start++;
      let end = before.length,
        nextEnd = after.length;
      while (
        end > start &&
        nextEnd > start &&
        before[end - 1] === after[nextEnd - 1]
      ) {
        end--;
        nextEnd--;
      }
      const delta = after.length - before.length;
      return mentions
        .flatMap((mention) =>
          mention.end <= start
            ? [mention]
            : mention.start >= end
              ? [
                  {
                    ...mention,
                    start: mention.start + delta,
                    end: mention.end + delta,
                  },
                ]
              : [],
        )
        .filter(
          (mention) =>
            after.slice(mention.start, mention.end) === mention.label,
        );
    }
    function createShared({
      React: React37,
      request: request2,
      apiRoot: apiRoot2,
      useResource: useResource2,
      Button: Button2,
      Input: Input2,
      Markdown: Markdown2,
      friendlyError: friendlyError2,
      navigation: navigation2,
      Icon: Icon2,
      EngineMark: EngineMark2,
      SessionAvatar: SessionAvatar2,
      createUploads: createUploads2,
      ComposerForm: ComposerForm2 = "form",
      closeMobileSidebar: closeMobileSidebar3,
      usePins,
      FileManager,
      SessionReminder,
      closeSidebar: closeSidebar3,
    }) {
      const h33 = React37.createElement,
        root = "/api/portal",
        enc = encodeURIComponent;
      const uid = () => crypto.randomUUID();
      const json = (body, method = "POST") => ({
        method,
        body: JSON.stringify(body),
      });
      async function sendDiscussion(input, conversation) {
        return request2(
          `${root}/shared-messages`,
          json({ ...input, conversation_id: conversation.id }),
        );
      }
      const go = (path) =>
        navigation2 ? navigation2.navigate(path) : location.assign(path);
      const useSearch = navigation2
        ? navigation2.useSearch
        : () => location.search;
      const route = (project, discussion) =>
        `/?workagent=shared${project ? `&project=${enc(project)}` : ""}${discussion ? `&discussion=${enc(discussion)}` : ""}`;
      const icon = (name, size = 18) =>
        Icon2 ? h33(Icon2, { name, size }) : null;
      const assistantAvatar = (backend, fallback) =>
        EngineMark2
          ? h33(EngineMark2, { engine: backend || "harness" })
          : fallback;
      const errorText = (error) =>
        ({
          shared_invite_already_pending: "邀请已经发出，正在等待对方接受。",
          shared_member_already_exists: "这位员工已经是项目成员。",
          invite_target_not_found: "无法邀请此账号，请搜索并选择可用员工。",
          shared_project_forbidden: "你已没有此项目的访问权限。",
          shared_project_not_found: "项目不存在，或你已不再是项目成员。",
          shared_project_busy: "项目正在准备或转移，请稍后重试。",
          shared_invite_expired: "邀请已过期，请联系负责人重新邀请。",
          shared_invite_link_revoked: "邀请链接已撤销。",
          shared_invite_link_exhausted: "邀请链接已被使用。",
          shared_invite_link_not_found: "邀请链接无效或已过期。",
          shared_run_busy: "助手正在处理，完成后可再次 @ 助手。",
          shared_assistant_locked:
            "助手身份不可更换，请邀请其他助手作为新成员加入。",
          shared_assistant_catalog_unavailable:
            "助手列表暂时不可用，请稍后重试。",
          invalid_shared_runtime: "请选择该助手当前支持的模型和思考强度。",
          shared_assistant_not_joined: "请先邀请该助手加入项目。",
          shared_assistant_unavailable: "这个助手不可用，请选择已启用的助手。",
          shared_context_too_large:
            "讨论超出助手上下文容量，请新建讨论后继续。",
          shared_context_unavailable: "消息已发送，但讨论上下文暂时无法读取。",
          shared_runtime_not_authorized:
            "所选模型尚未授权，请联系项目负责人调整。",
          shared_turn_unavailable: "助手暂时不可用。",
          shared_storage_exceeded: "共享空间不足，请联系管理员调整额度。",
          invalid_shared_mention: "提及对象已变化，请重新选择。",
          shared_project_conflict: "项目状态已变化，请刷新后重试。",
        })[error?.message || error] || friendlyError2(error?.message || error);
      const fileRoot = (id) => `${root}/shared-workspaces/${enc(id)}`;
      const fileURL2 = (id, path, preview = false) =>
        `${fileRoot(id)}/content?path=${enc(path)}${preview ? "&preview=1" : ""}`;
      const uploads2 = createUploads2?.({
        React: React37,
        request: request2,
        apiRoot: apiRoot2,
        friendlyError: errorText,
        workspaceEndpoint: fileRoot,
      });
      let snapshot = {
          projects: [],
          invites: [],
          conversations: [],
          loading: true,
          error: "",
          revision: 0,
        },
        refreshing,
        stop;
      const subscribers = /* @__PURE__ */ new Set();
      const refresh = () => {
        if (refreshing) return refreshing;
        refreshing = Promise.all([
          request2(`${root}/shared-projects?include_hidden=true`),
          request2(`${root}/shared-invites`),
          request2(`${root}/shared-conversations?include_hidden=true`),
        ])
          .then(([p, i, c]) => {
            snapshot = {
              projects: p.projects || [],
              invites: i.invites || [],
              conversations: c.conversations || [],
              loading: false,
              error: "",
              revision: snapshot.revision + 1,
            };
          })
          .catch((error) => {
            snapshot = {
              ...snapshot,
              ...(error.status === 401
                ? { projects: [], invites: [], conversations: [] }
                : {}),
              loading: false,
              error: errorText(error),
            };
          })
          .finally(() => {
            refreshing = null;
            subscribers.forEach((fn) => fn());
          });
        return refreshing;
      };
      function subscribe(fn) {
        subscribers.add(fn);
        if (subscribers.size === 1) {
          void refresh();
          const events =
            typeof EventSource === "function"
              ? new EventSource(`${root}/shared-events`)
              : null;
          if (events) {
            events.onmessage = refresh;
            events.onopen = refresh;
            events.addEventListener?.("change", refresh);
          }
          const timer = setInterval(refresh, 5e3);
          window.addEventListener("focus", refresh);
          window.addEventListener("workagent:shared-changed", refresh);
          stop = () => {
            clearInterval(timer);
            events?.close();
            window.removeEventListener("focus", refresh);
            window.removeEventListener("workagent:shared-changed", refresh);
          };
        }
        return () => {
          subscribers.delete(fn);
          if (!subscribers.size) stop?.();
        };
      }
      const useShared = () =>
        React37.useSyncExternalStore(subscribe, () => snapshot);
      async function mutate2(path, body, method = "POST") {
        const value = await request2(
          `${root}/${path}`,
          body === void 0 ? { method } : json(body, method),
        );
        if (refreshing) await refreshing;
        await refresh();
        return value;
      }
      function PersonalTaskButton({ project, onClose }) {
        return h33(
          Button2,
          {
            className: "workagent-button workagent-personal-task-entry",
            "aria-label": "新建个人任务",
            onClick: () => {
              onClose();
              closeSidebar3?.();
              go(personalTaskRoute(project.id));
            },
          },
          icon("workspace", 20),
          h33(
            "span",
            null,
            h33("strong", null, "个人任务"),
            h33("small", null, "仅自己可见 · 在项目共享文件夹中运行"),
          ),
          icon("chevronRight", 18),
        );
      }
      async function deletePersonalTask2(row) {
        await deletePersonalTask(row.id, request2);
        await refresh();
      }
      async function openProject(projectId, discussionId) {
        const selected =
          discussionId ||
          snapshot.conversations.find(
            (row) =>
              row.project_id === projectId &&
              !row.hidden &&
              row.kind !== "personal_task",
          )?.id;
        const discussion =
          selected ||
          (await mutate2(`shared-projects/${enc(projectId)}/discussion`, {}))
            .conversation.id;
        go(route(projectId, discussion));
      }
      const Feedback = ({ error, notice }) =>
        h33(
          React37.Fragment,
          null,
          error
            ? h33(
                "p",
                {
                  role: "alert",
                  className: "workagent-collab-feedback is-error",
                },
                error,
              )
            : null,
          notice
            ? h33(
                "p",
                { role: "status", className: "workagent-collab-feedback" },
                notice,
              )
            : null,
        );
      function useMembers(project, revision) {
        const [members, setMembers] = React37.useState([]);
        React37.useEffect(() => {
          if (!project) {
            setMembers([]);
            return;
          }
          const abort = new AbortController();
          request2(`${root}/shared-projects/${enc(project.id)}/members`, {
            signal: abort.signal,
          })
            .then((value) => {
              if (!abort.signal.aborted) setMembers(value.members);
            })
            .catch((error) => {
              if (!abort.signal.aborted && [403, 404].includes(error.status)) {
                setMembers([]);
                void refresh();
              }
            });
          return () => abort.abort();
        }, [project?.id, revision]);
        return members;
      }
      function MoreMenu({ children }) {
        const ref = React37.useRef(null);
        React37.useEffect(() => {
          const close = (event) => {
            if (event.type === "keydown" && event.key !== "Escape") return;
            if (
              event.type === "pointerdown" &&
              ref.current.contains(event.target)
            )
              return;
            if (ref.current.open) {
              ref.current.open = false;
              if (event.type === "keydown")
                ref.current.querySelector("summary").focus();
            }
          };
          document.addEventListener("pointerdown", close);
          document.addEventListener("keydown", close);
          return () => {
            document.removeEventListener("pointerdown", close);
            document.removeEventListener("keydown", close);
          };
        }, []);
        return h33(
          "details",
          { className: "workagent-collab-more", ref },
          h33("summary", { "aria-label": "项目更多操作" }, icon("more", 16)),
          h33(
            "div",
            {
              className: "workagent-collab-menu-popover",
              onClick: (event) => {
                if (event.target.closest("button")) ref.current.open = false;
              },
            },
            children,
          ),
        );
      }
      function UserSearch({ onSelect, selected = [] }) {
        const [query, setQuery] = React37.useState(""),
          [results, setResults] = React37.useState([]),
          [error, setError] = React37.useState("");
        React37.useEffect(() => {
          setResults([]);
          if (!query.trim()) return;
          const abort = new AbortController();
          const timer = setTimeout(
            () =>
              request2(`${root}/shared-users?q=${enc(query.trim())}`, {
                signal: abort.signal,
              })
                .then((value) => {
                  if (!abort.signal.aborted) {
                    setResults(value.users);
                    setError("");
                  }
                })
                .catch((error2) => {
                  if (!abort.signal.aborted) setError(errorText(error2));
                }),
            250,
          );
          return () => {
            clearTimeout(timer);
            abort.abort();
          };
        }, [query]);
        return h33(
          "div",
          { className: "workagent-collab-search" },
          h33(Input2, {
            "aria-label": "搜索员工",
            placeholder: "搜索姓名或用户名",
            value: query,
            onChange: (event) => setQuery(event.target.value),
          }),
          query
            ? h33(
                "div",
                { className: "workagent-collab-search-results" },
                ...results
                  .filter(
                    (user) => !selected.some((item) => item.id === user.id),
                  )
                  .map((user) =>
                    h33(
                      Button2,
                      {
                        key: user.id,
                        onClick: () => {
                          onSelect(user);
                          setQuery("");
                        },
                      },
                      user.display_name || user.username,
                      h33("small", null, ` @${user.username}`),
                    ),
                  ),
              )
            : null,
          h33(Feedback, { error }),
        );
      }
      function CreateProject({ onClose, onCreated }) {
        const [name, setName] = React37.useState(""),
          [invitees, setInvitees] = React37.useState([]);
        const [busy, setBusy] = React37.useState(false),
          [error, setError] = React37.useState("");
        const operation = React37.useRef(uid()),
          created = React37.useRef(null);
        async function create(event) {
          event.preventDefault();
          if (busy || !name.trim()) return;
          setBusy(true);
          setError("");
          try {
            const value =
              created.current ||
              (await mutate2("shared-projects", {
                name: name.trim(),
                operation_id: operation.current,
              }));
            created.current = value;
            const failed = [];
            for (const user of invitees) {
              try {
                await mutate2(
                  `shared-projects/${enc(value.project.id)}/invites`,
                  {
                    targetUsername: user.username,
                    expiresInHours: 72,
                  },
                );
              } catch (error2) {
                if (
                  ![
                    "shared_invite_already_pending",
                    "shared_member_already_exists",
                  ].includes(error2.message)
                )
                  failed.push(
                    `${user.display_name || user.username}：${errorText(error2)}`,
                  );
              }
            }
            sessionStorage.setItem(
              `workagent.shared.notice.${value.project.id}`,
              failed.length
                ? `项目已创建，以下邀请未发送：${failed.join("；")}。可在成员中重试。`
                : invitees.length
                  ? "项目已创建，邀请已发送，等待同事接受。"
                  : "项目已创建，可以开始讨论或邀请同事。",
            );
            await refresh();
            onCreated
              ? await onCreated(value)
              : go(route(value.project.id, value.conversation.id));
            onClose();
          } catch (error2) {
            setError(
              `${created.current ? "项目已创建，后续操作未完成，可重试。" : ""}${errorText(error2)}`,
            );
          } finally {
            setBusy(false);
          }
        }
        return h33(
          Dialog,
          {
            title: "新建协作项目",
            onClose: () => {
              if (!busy) onClose();
            },
          },
          h33(
            "form",
            { onSubmit: create, className: "workagent-collab-form" },
            h33(
              "label",
              null,
              "项目名称",
              h33(Input2, {
                "aria-label": "共享项目名称",
                value: name,
                disabled: !!created.current,
                required: true,
                maxLength: 120,
                placeholder: "例如：秋季产品发布",
                onChange: (event) => setName(event.target.value),
              }),
            ),
            h33("label", null, "邀请同事 · 可稍后添加"),
            h33(UserSearch, {
              selected: invitees,
              onSelect: (user) => setInvitees((rows) => [...rows, user]),
            }),
            h33(
              "div",
              { className: "workagent-collab-chips" },
              ...invitees.map((user) =>
                h33(
                  Button2,
                  {
                    key: user.id,
                    onClick: () =>
                      setInvitees((rows) =>
                        rows.filter((row) => row.id !== user.id),
                      ),
                  },
                  user.display_name || user.username,
                  " ×",
                ),
              ),
            ),
            h33(Feedback, { error }),
            h33(
              "footer",
              null,
              h33(Button2, { onClick: onClose, disabled: busy }, "取消"),
              h33(
                Button2,
                {
                  type: "submit",
                  className: "workagent-button is-primary",
                  disabled: busy || !name.trim(),
                },
                busy ? "正在创建…" : created.current ? "继续完成" : "创建项目",
              ),
            ),
          ),
        );
      }
      function Invitations({ onClose }) {
        const state = useShared(),
          params = new URLSearchParams(useSearch()),
          token = params.get("token");
        const [busy, setBusy] = React37.useState(""),
          [error, setError] = React37.useState("");
        const pending = state.invites.filter((row) => row.status === "pending");
        async function act(invite, accept) {
          setBusy(invite?.id || "link");
          setError("");
          try {
            const value =
              token && !invite
                ? await mutate2("shared-invite-links/accept", { token })
                : await mutate2(
                    `shared-invites/${enc(invite.id)}/${accept ? "accept" : "decline"}`,
                    {},
                  );
            if (accept) {
              onClose();
              await openProject(value.project.id);
            }
          } catch (error2) {
            setError(errorText(error2));
          } finally {
            setBusy("");
          }
        }
        return h33(
          Dialog,
          { title: "项目邀请", onClose },
          h33(
            "div",
            { className: "workagent-collab-form" },
            h33(Feedback, { error }),
            token
              ? h33(
                  "div",
                  null,
                  h33(
                    "p",
                    null,
                    "接受后，你将加入此共享项目并看到项目文件和讨论。",
                  ),
                  h33(
                    Button2,
                    { disabled: !!busy, onClick: () => act(null, true) },
                    busy ? "正在加入…" : "接受邀请",
                  ),
                )
              : null,
            ...pending.map((invite) =>
              h33(
                "article",
                { key: invite.id, className: "workagent-collab-invite" },
                h33(
                  "div",
                  null,
                  h33("strong", null, invite.projectName),
                  h33("p", null, `${invite.inviterName} 邀请你加入`),
                  h33(
                    "small",
                    null,
                    `有效期至 ${new Date(invite.expiresAt).toLocaleString()}`,
                  ),
                ),
                h33(
                  "div",
                  { className: "workagent-collab-actions" },
                  h33(
                    Button2,
                    { disabled: !!busy, onClick: () => act(invite, false) },
                    "拒绝",
                  ),
                  h33(
                    Button2,
                    {
                      disabled: !!busy,
                      className: "workagent-button is-primary",
                      onClick: () => act(invite, true),
                    },
                    busy === invite.id ? "处理中…" : "接受",
                  ),
                ),
              ),
            ),
            !pending.length && !token
              ? h33(
                  "p",
                  { className: "workagent-collab-empty" },
                  "暂时没有待处理的邀请。",
                )
              : null,
          ),
        );
      }
      function useAssistantMembers(project, revision) {
        const [state, setState] = React37.useState({
          members: [],
          options: [],
          error: "",
        });
        React37.useEffect(() => {
          const abort = new AbortController();
          Promise.all([
            request2(`${root}/shared-projects/${enc(project.id)}/assistants`, {
              signal: abort.signal,
            }),
            project.currentRole === "owner"
              ? request2(
                  `${root}/shared-projects/${enc(project.id)}/assistant-options`,
                  { signal: abort.signal },
                ).catch((error) => ({
                  assistants: [],
                  error: errorText(error),
                }))
              : Promise.resolve({ assistants: [] }),
          ])
            .then(([members, options]) => {
              if (!abort.signal.aborted)
                setState({
                  members: members.assistants,
                  options: options.assistants,
                  error: options.error || "",
                });
            })
            .catch((error) => {
              if (!abort.signal.aborted)
                setState((value) => ({ ...value, error: errorText(error) }));
            });
          return () => abort.abort();
        }, [project.id, project.currentRole, revision]);
        return state;
      }
      function AssistantMembers({ project, revision }) {
        const state = useAssistantMembers(project, revision);
        const [selected, setSelected] = React37.useState(""),
          [busy, setBusy] = React37.useState(false),
          [notice, setNotice] = React37.useState(""),
          [error, setError] = React37.useState("");
        const available = state.options.filter(
          (row) =>
            !state.members.some((member) => member.assistant_id === row.id),
        );
        async function perform(action, notice2) {
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            await action();
            setNotice(notice2);
            setSelected("");
          } catch (error2) {
            setError(errorText(error2));
          } finally {
            setBusy(false);
          }
        }
        return h33(
          "section",
          { "aria-label": "助手成员", className: "workagent-collab-form" },
          h33("strong", null, "助手成员"),
          project.currentRole === "owner"
            ? h33(
                "div",
                { className: "workagent-collab-actions" },
                h33(
                  "select",
                  {
                    "aria-label": "邀请助手",
                    className: "workagent-control",
                    value: selected,
                    onChange: (event) => setSelected(event.target.value),
                  },
                  h33("option", { value: "" }, "选择要邀请的助手"),
                  ...available.map((row) =>
                    h33("option", { key: row.id, value: row.id }, row.name),
                  ),
                ),
                h33(
                  Button2,
                  {
                    disabled: busy || !selected,
                    onClick: () =>
                      perform(
                        () =>
                          mutate2(
                            `shared-projects/${enc(project.id)}/assistant-invites`,
                            { assistant_id: selected },
                          ),
                        "助手已接受邀请并加入项目。",
                      ),
                  },
                  "发送助手邀请",
                ),
              )
            : null,
          h33(Feedback, { error: error || state.error, notice }),
          ...state.members.map((member) =>
            h33(
              "div",
              {
                key: member.assistant_id,
                className: "workagent-collab-member",
              },
              h33(
                "span",
                { className: "workagent-collab-avatar", "aria-hidden": true },
                assistantAvatar(member.assistant_backend, icon("assistant")),
              ),
              h33(
                "div",
                null,
                h33("strong", null, member.name),
                h33("small", null, `${member.assistant_backend} · 已加入`),
              ),
              project.currentRole === "owner"
                ? h33(
                    Button2,
                    {
                      disabled: busy || member.running,
                      "aria-label": `移除助手 ${member.name}`,
                      onClick: () =>
                        perform(
                          () =>
                            mutate2(
                              `shared-projects/${enc(project.id)}/assistants/${enc(member.assistant_id)}`,
                              void 0,
                              "DELETE",
                            ),
                          "助手已移出，历史讨论保留。",
                        ),
                    },
                    "移除",
                  )
                : null,
            ),
          ),
          !state.members.length
            ? h33("p", null, "邀请助手加入后，成员才能 @ 它。")
            : null,
        );
      }
      function AssistantSettingsRow({ project, member, options }) {
        const [model, setModel] = React37.useState(member.model_id),
          [effort, setEffort] = React37.useState(member.thinking_effort),
          [busy, setBusy] = React37.useState(false),
          [error, setError] = React37.useState(""),
          [notice, setNotice] = React37.useState("");
        React37.useEffect(() => {
          setModel(member.model_id);
          setEffort(member.thinking_effort);
        }, [member.model_id, member.thinking_effort]);
        const choices = [
          ...new Map(
            options
              .filter((row) => row.engine === member.assistant_backend)
              .flatMap((row) => row.models)
              .map((row) => [row.id, row]),
          ).values(),
        ];
        if (!choices.some((row) => row.id === member.model_id))
          choices.unshift({ id: member.model_id, name: member.model_id });
        const selectedModel = choices.find((row) => row.id === model);
        const levels = selectedModel?.reasoning?.length
          ? selectedModel.reasoning
          : [{ id: "off", name: "关闭" }];
        const levelLabels = {
          off: "关闭",
          on: "开启",
          low: "低",
          medium: "中",
          high: "高",
          xhigh: "更高",
          max: "最高",
          minimal: "最低",
        };
        React37.useEffect(() => {
          if (
            selectedModel?.reasoning &&
            !levels.some((row) => row.id === effort)
          )
            setEffort(selectedModel.defaultReasoning || levels[0].id);
        }, [
          model,
          selectedModel?.defaultReasoning,
          JSON.stringify(selectedModel?.reasoning),
        ]);
        return h33(
          "form",
          {
            className: "workagent-collab-form",
            "aria-label": `${member.name} 的设置`,
            onSubmit: async (event) => {
              event.preventDefault();
              if (busy || member.running) return;
              setBusy(true);
              setError("");
              setNotice("");
              try {
                await mutate2(
                  `shared-projects/${enc(project.id)}/assistants/${enc(member.assistant_id)}`,
                  { model_id: model, thinking_effort: effort },
                  "PATCH",
                );
                setNotice("已保存，下次 @ 时生效。");
              } catch (error2) {
                setError(errorText(error2));
              } finally {
                setBusy(false);
              }
            },
          },
          h33(
            "div",
            null,
            h33("strong", null, member.name),
            h33("small", null, ` · ${member.assistant_backend}`),
          ),
          h33(
            "label",
            null,
            "模型",
            h33(
              "select",
              {
                "aria-label": `${member.name} 模型`,
                className: "workagent-control",
                value: model,
                disabled: busy || member.running,
                onChange: (event) => setModel(event.target.value),
              },
              ...choices.map((row) =>
                h33("option", { key: row.id, value: row.id }, row.name),
              ),
            ),
          ),
          h33(
            "label",
            null,
            "思考强度",
            h33(
              "select",
              {
                "aria-label": `${member.name} 思考强度`,
                className: "workagent-control",
                value: effort,
                disabled: busy || member.running,
                onChange: (event) => setEffort(event.target.value),
              },
              ...levels.map(({ id, name }) =>
                h33("option", { key: id, value: id }, levelLabels[id] || name),
              ),
            ),
          ),
          member.running
            ? h33("p", null, "助手正在执行，结束后可调整设置。")
            : null,
          h33(Feedback, { error, notice }),
          h33(
            Button2,
            {
              type: "submit",
              className: "workagent-button is-primary",
              disabled: busy || member.running,
            },
            busy ? "保存中…" : "保存",
          ),
        );
      }
      function AssistantSettings({ project, revision, onClose }) {
        const state = useAssistantMembers(project, revision);
        return h33(
          Dialog,
          { title: "助手设置", onClose },
          h33(
            "div",
            { className: "workagent-collab-form" },
            h33(
              "p",
              null,
              "分别调整群内助手的模型和思考强度，已有会话继续保留。",
            ),
            h33(Feedback, { error: state.error }),
            ...state.members.map((member) =>
              h33(AssistantSettingsRow, {
                key: member.assistant_id,
                project,
                member,
                options: state.options,
              }),
            ),
            !state.members.length
              ? h33("p", null, "请先在项目成员中邀请助手加入。")
              : null,
          ),
        );
      }
      function Members({ project, members, revision, onClose }) {
        const { confirm, confirmation } = useConfirm();
        const [outgoing, setOutgoing] = React37.useState([]),
          [selected, setSelected] = React37.useState(null),
          [busy, setBusy] = React37.useState(false);
        const [notice, setNotice] = React37.useState(""),
          [error, setError] = React37.useState(""),
          [link, setLink] = React37.useState(null);
        const owner = project.currentRole === "owner";
        React37.useEffect(() => {
          if (!owner) return;
          const abort = new AbortController();
          request2(`${root}/shared-projects/${enc(project.id)}/invites`, {
            signal: abort.signal,
          })
            .then((value) => {
              if (!abort.signal.aborted) setOutgoing(value.invites);
            })
            .catch((error2) => {
              if (!abort.signal.aborted) setError(errorText(error2));
            });
          return () => abort.abort();
        }, [project.id, owner, revision]);
        async function perform(fn, success) {
          if (busy) return;
          setBusy(true);
          setError("");
          setNotice("");
          try {
            await fn();
            setNotice(success);
          } catch (error2) {
            setError(errorText(error2));
          } finally {
            setBusy(false);
          }
        }
        const statuses = {
          pending: "等待接受",
          accepting: "正在加入",
          accepted: "已加入",
          declined: "已拒绝",
          expired: "已过期",
          revoked: "已撤销",
        };
        return h33(
          Dialog,
          { title: "项目成员", onClose },
          confirmation,
          h33(
            "div",
            { className: "workagent-collab-form" },
            owner
              ? h33(
                  React37.Fragment,
                  null,
                  h33(UserSearch, { onSelect: setSelected }),
                  selected
                    ? h33(
                        "div",
                        { className: "workagent-collab-actions" },
                        h33(
                          "span",
                          null,
                          selected.display_name || selected.username,
                        ),
                        h33(
                          Button2,
                          {
                            disabled: busy,
                            className: "workagent-button is-primary",
                            onClick: () =>
                              perform(
                                async () => {
                                  await mutate2(
                                    `shared-projects/${enc(project.id)}/invites`,
                                    {
                                      targetUsername: selected.username,
                                      expiresInHours: 72,
                                    },
                                  );
                                  setSelected(null);
                                },
                                `已邀请${selected.display_name || selected.username}，等待接受。`,
                              ),
                          },
                          "发送邀请",
                        ),
                      )
                    : null,
                  h33(
                    Button2,
                    {
                      disabled: busy,
                      onClick: () =>
                        perform(async () => {
                          const value =
                            link ||
                            (
                              await mutate2(
                                `shared-projects/${enc(project.id)}/invite-links`,
                                { expiresInHours: 72, singleUse: true },
                              )
                            ).link;
                          setLink(value);
                          const url = `${location.origin}/?frontend=dsh&workagent=shared&token=${enc(value.token)}`;
                          if (navigator.clipboard?.writeText)
                            await navigator.clipboard.writeText(url);
                          else {
                            const field = document.createElement("textarea");
                            field.value = url;
                            document.body.append(field);
                            field.select();
                            const copied = document.execCommand("copy");
                            field.remove();
                            if (!copied)
                              throw new Error("请复制下方邀请链接。");
                          }
                        }, "邀请链接已复制，72 小时内有效，仅可使用一次。"),
                    },
                    "复制邀请链接",
                  ),
                  link
                    ? h33(
                        "div",
                        { className: "workagent-collab-link" },
                        h33(Input2, {
                          "aria-label": "邀请链接",
                          readOnly: true,
                          value: `${location.origin}/?frontend=dsh&workagent=shared&token=${enc(link.token)}`,
                          onFocus: (event) => event.target.select(),
                        }),
                        h33(
                          Button2,
                          {
                            disabled: busy,
                            onClick: () =>
                              perform(async () => {
                                await mutate2(
                                  `shared-projects/${enc(project.id)}/invite-links/${enc(link.token)}`,
                                  void 0,
                                  "DELETE",
                                );
                                setLink(null);
                              }, "邀请链接已撤销。"),
                          },
                          "撤销链接",
                        ),
                      )
                    : null,
                )
              : null,
            h33(Feedback, { notice, error }),
            h33(AssistantMembers, { project, revision }),
            h33(
              "div",
              { className: "workagent-collab-member-list" },
              ...members.map((member) =>
                h33(
                  "div",
                  { key: member.userId, className: "workagent-collab-member" },
                  h33(
                    "span",
                    {
                      className: "workagent-collab-avatar",
                      "aria-hidden": true,
                    },
                    Array.from(
                      (member.displayName || member.username || "员").trim(),
                    )[0].toLocaleUpperCase(),
                  ),
                  h33(
                    "div",
                    null,
                    h33("strong", null, member.displayName || member.username),
                    h33(
                      "small",
                      null,
                      member.role === "owner" ? "负责人" : "成员",
                    ),
                  ),
                  owner && member.role !== "owner"
                    ? h33(
                        "details",
                        { className: "workagent-collab-member-menu" },
                        h33(
                          "summary",
                          {
                            "aria-label": `管理${member.displayName || member.username}`,
                          },
                          icon("more", 15),
                        ),
                        h33(
                          Button2,
                          {
                            disabled: busy,
                            onClick: async () => {
                              if (
                                await confirm(
                                  `移除${member.displayName || member.username}？对方将无法继续访问项目。`,
                                )
                              )
                                void perform(
                                  () =>
                                    mutate2(
                                      `shared-projects/${enc(project.id)}/members/${member.userId}`,
                                      void 0,
                                      "DELETE",
                                    ),
                                  "成员已移除。",
                                );
                            },
                          },
                          "移除成员",
                        ),
                        h33(
                          Button2,
                          {
                            disabled: busy,
                            onClick: async () => {
                              if (
                                await confirm(
                                  `将项目转交给${member.displayName || member.username}？`,
                                )
                              )
                                void perform(
                                  () =>
                                    mutate2(
                                      `shared-projects/${enc(project.id)}/ownership`,
                                      { targetUserId: member.userId },
                                    ),
                                  "项目负责人已更新。",
                                );
                            },
                          },
                          "转移所有权",
                        ),
                      )
                    : null,
                ),
              ),
            ),
            owner && outgoing.length
              ? h33(
                  "section",
                  null,
                  h33("h3", null, "邀请记录"),
                  ...outgoing.map((invite) =>
                    h33(
                      "div",
                      {
                        key: invite.id,
                        className: "workagent-collab-invite-row",
                      },
                      h33("span", null, invite.displayName || invite.username),
                      h33(
                        "small",
                        null,
                        statuses[invite.status] || invite.status,
                      ),
                      invite.status === "pending"
                        ? h33(
                            Button2,
                            {
                              disabled: busy,
                              onClick: () =>
                                perform(
                                  () =>
                                    mutate2(
                                      `shared-invites/${enc(invite.id)}`,
                                      void 0,
                                      "DELETE",
                                    ),
                                  "邀请已撤销。",
                                ),
                            },
                            "撤销",
                          )
                        : null,
                    ),
                  ),
                )
              : null,
          ),
        );
      }
      function Composer({
        conversation,
        members = [],
        initial = "",
        onSend,
        projectId,
      }) {
        const [body, setBody] = React37.useState(initial),
          [mentions, setMentions] = React37.useState([]),
          [caret, setCaret] = React37.useState(initial.length),
          [choice, setChoice] = React37.useState(0);
        const [busy, setBusy] = React37.useState(false),
          [uploading, setUploading] = React37.useState(false),
          [attachments, setAttachments] = React37.useState([]),
          [error, setError] = React37.useState(""),
          [notice, setNotice] = React37.useState("");
        const messageID = React37.useRef(null),
          textarea = React37.useRef(null);
        React37.useLayoutEffect(() => {
          const input = textarea.current;
          input.style.height = "auto";
          input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
        }, [body]);
        const uploadControl = React37.useRef(null);
        React37.useEffect(() => () => uploadControl.current?.abort(), []);
        async function upload(files) {
          if (
            !uploads2 ||
            !projectId ||
            busy ||
            uploadControl.current ||
            !files.length
          )
            return;
          const controller = new AbortController();
          uploadControl.current = controller;
          setUploading(true);
          setError("");
          try {
            const result = await uploads2.uploadFiles(projectId, files, {
              signal: controller.signal,
              destination: (file) => ({
                path: `附件/${file.name}`,
                conflict: "rename",
              }),
              onUploaded: (path) => {
                if (controller.signal.aborted) return;
                setAttachments((rows) => [
                  .../* @__PURE__ */ new Set([...rows, path]),
                ]);
                messageID.current = null;
              },
            });
            if (!controller.signal.aborted)
              setError(result.failures.join("；"));
          } catch (error2) {
            if (!controller.signal.aborted) setError(errorText(error2));
          } finally {
            uploadControl.current = null;
            if (!controller.signal.aborted) setUploading(false);
          }
        }
        React37.useEffect(
          () =>
            bindComposerFiles(
              textarea.current,
              upload,
              busy || uploading || !projectId,
            ),
          [busy, uploading, projectId],
        );
        const query = body.slice(0, caret).match(/(^|\s)@([^\s@]*)$/u);
        const agents = conversation?.assistants || [];
        const candidates = query
          ? [
              ...agents.map((row) => ({
                kind: "assistant",
                id: row.assistant_id,
                name: row.name,
                detail: `${row.assistant_backend} · 助手成员`,
              })),
              ...members.map((member) => ({
                kind: "member",
                id: String(member.userId),
                name: member.displayName || member.username,
                detail: "项目成员",
              })),
            ].filter((row) =>
              `${row.name} ${row.detail}`
                .toLowerCase()
                .includes(query[2].toLowerCase()),
            )
          : [];
        function select(candidate) {
          const start = caret - query[2].length - 1,
            label = `@${candidate.name}`,
            next = body.slice(0, start) + label + " " + body.slice(caret);
          setMentions([
            ...reconcileSharedMentions(body, next, mentions),
            {
              kind: candidate.kind,
              id: candidate.id,
              label,
              start,
              end: start + label.length,
            },
          ]);
          setBody(next);
          setCaret(start + label.length + 1);
          messageID.current = null;
          queueMicrotask(() => {
            textarea.current?.focus();
            textarea.current?.setSelectionRange(
              start + label.length + 1,
              start + label.length + 1,
            );
          });
        }
        async function send(event) {
          event.preventDefault();
          if (!body.trim() || busy || uploading) return;
          setBusy(true);
          setError("");
          setNotice("");
          messageID.current ||= uid();
          try {
            const selected = mentions
              .filter((row) => body.slice(row.start, row.end) === row.label)
              .map(({ kind, id }) => ({ kind, id }));
            const agentIDs = [
              ...new Set(
                selected
                  .filter((row) => row.kind === "assistant")
                  .map((row) => row.id),
              ),
            ];
            if (
              agentIDs.some(
                (id) => !agents.some((agent) => agent.assistant_id === id),
              )
            )
              throw new Error("请先邀请这个助手加入项目，再 @ 它。");
            const value = await onSend({
              body,
              mentions: selected,
              attachments,
              client_message_id: messageID.current,
            });
            setBody("");
            setMentions([]);
            setAttachments([]);
            setCaret(0);
            messageID.current = null;
            const declined =
              value?.assistants?.filter((row) => row.status !== "started") ||
              [];
            if (declined.length)
              setNotice(
                `消息已发送。${declined.map((row) => `${agents.find((agent) => agent.assistant_id === row.assistant_id)?.name || "助手"}：${errorText(row.reason)}`).join("；")}`,
              );
            else if (["busy", "blocked"].includes(value?.ai_status))
              setNotice(
                `消息已发送。${errorText(value.ai_reason || "shared_turn_unavailable")}`,
              );
            else if (value?.ai_status === "already_sent")
              setNotice("消息已发送，没有重复发送或启动助手。");
          } catch (error2) {
            setError(errorText(error2));
          } finally {
            setBusy(false);
          }
        }
        return h33(
          ComposerForm2,
          {
            className:
              "workagent-conversation-composer workagent-collab-composer",
            onSubmit: send,
            ...(ComposerForm2 !== "form" ? { showSettings: false } : {}),
          },
          h33(Feedback, { error, notice }),
          h33(
            React37.Fragment,
            null,
            candidates.length
              ? h33(
                  "div",
                  {
                    role: "listbox",
                    "aria-label": "提及对象",
                    className: "workagent-collab-mentions",
                  },
                  ...candidates.map((candidate, index) =>
                    h33(
                      "button",
                      {
                        key: `${candidate.kind}:${candidate.id}`,
                        type: "button",
                        role: "option",
                        "aria-selected": index === choice,
                        className: index === choice ? "is-active" : "",
                        onMouseDown: (event) => event.preventDefault(),
                        onClick: () => select(candidate),
                      },
                      h33("strong", null, candidate.name),
                      h33(
                        "small",
                        null,
                        candidate.kind === "assistant"
                          ? "仅本条消息请助手参与"
                          : "提醒这位同事",
                      ),
                    ),
                  ),
                )
              : null,
            attachments.length
              ? h33(
                  "div",
                  { className: "workagent-composer-attachments" },
                  ...attachments.map((path) =>
                    h33(
                      "span",
                      {
                        key: path,
                        className: `workagent-file-reference${isComposerImage(path) ? " workagent-image-reference" : ""}`,
                      },
                      h33(
                        "a",
                        {
                          href: fileURL2(projectId, path, true),
                          target: "_blank",
                          rel: "noopener",
                          "aria-label": `预览 ${path.split("/").at(-1)}`,
                        },
                        isComposerImage(path)
                          ? h33("img", {
                              src: fileURL2(projectId, path, true),
                              alt: path.split("/").at(-1),
                              draggable: false,
                            })
                          : path.split("/").at(-1),
                      ),
                      h33(
                        "button",
                        {
                          type: "button",
                          disabled: busy,
                          "aria-label": `移除附件 ${path.split("/").at(-1)}`,
                          onClick: () => {
                            setAttachments((rows) =>
                              rows.filter((row) => row !== path),
                            );
                            messageID.current = null;
                          },
                        },
                        "×",
                      ),
                    ),
                  ),
                )
              : null,
            h33("textarea", {
              ref: textarea,
              "aria-label": "共享消息",
              value: body,
              disabled: busy,
              rows: 1,
              maxLength: 1e5,
              placeholder: "输入消息，@ 提及成员或 Agent…",
              onChange: (event) => {
                setMentions(
                  reconcileSharedMentions(body, event.target.value, mentions),
                );
                setBody(event.target.value);
                setCaret(event.target.selectionStart);
                setChoice(0);
                messageID.current = null;
              },
              onSelect: (event) => setCaret(event.target.selectionStart),
              onPaste: (event) => {
                if (event.clipboardData?.files.length) return;
                const { selectionStart: start, selectionEnd: end } =
                  event.target;
                setMentions((rows) =>
                  rows.filter((row) => row.end <= start || row.start >= end),
                );
                messageID.current = null;
              },
              onKeyDown: (event) => {
                if (event.nativeEvent?.isComposing || event.isComposing) return;
                if (
                  candidates.length &&
                  ["ArrowUp", "ArrowDown", "Enter", "Tab"].includes(event.key)
                ) {
                  event.preventDefault();
                  if (event.key === "ArrowUp" || event.key === "ArrowDown")
                    setChoice(
                      (value) =>
                        (value +
                          (event.key === "ArrowUp" ? -1 : 1) +
                          candidates.length) %
                        candidates.length,
                    );
                  else
                    select(candidates[Math.min(choice, candidates.length - 1)]);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) void send(event);
              },
            }),
            h33(
              "div",
              {
                className:
                  "workagent-conversation-composer-bar workagent-collab-composer-bar",
              },
              projectId && uploads2
                ? h33(
                    "label",
                    { className: "workagent-collab-attach", title: "添加附件" },
                    icon("plus", 20),
                    h33("input", {
                      type: "file",
                      multiple: true,
                      "aria-label": "添加共享附件",
                      disabled: busy || uploading,
                      onChange: async (event) => {
                        const files = [...event.target.files];
                        event.target.value = "";
                        void upload(files);
                      },
                    }),
                  )
                : null,
              h33(
                "small",
                null,
                uploading
                  ? "正在上传…"
                  : conversation?.assistant_id
                    ? "只有 @ 助手才会执行"
                    : "与项目成员讨论",
              ),
              h33(
                "button",
                {
                  type: "submit",
                  className: "workagent-composer-send",
                  "aria-label": "发送消息",
                  disabled: busy || uploading || !body.trim(),
                },
                icon("send"),
              ),
            ),
          ),
        );
      }
      function Chat({ conversation, project, members, revision }) {
        const [messages, setMessages] = React37.useState([]),
          [error, setError] = React37.useState(""),
          [local, setLocal] = React37.useState(0);
        const targetMessage = new URLSearchParams(useSearch()).get("message"),
          located = React37.useRef("");
        const list = React37.useRef(null),
          bottom = React37.useRef(true);
        React37.useEffect(() => {
          const abort = new AbortController();
          (async () => {
            const rows = [];
            let after = 0;
            for (;;) {
              const value = await request2(
                `${root}/shared-messages?conversation_id=${enc(conversation.id)}&after=${after}&limit=200`,
                { signal: abort.signal },
              );
              rows.push(...value.messages);
              if (value.messages.length < 200) break;
              after = value.messages.at(-1).seq;
            }
            if (!abort.signal.aborted) {
              setMessages(rows);
              setError("");
            }
          })().catch((error2) => {
            if (!abort.signal.aborted) {
              setError(errorText(error2));
              if ([403, 404].includes(error2.status)) {
                setMessages([]);
                void refresh();
              }
            }
          });
          return () => abort.abort();
        }, [conversation.id, revision, local]);
        React37.useLayoutEffect(() => {
          const key = `${conversation.id}:${targetMessage}`;
          if (targetMessage && located.current !== key && list.current) {
            const target = [
              ...list.current.querySelectorAll("[data-shared-message-id]"),
            ].find((node) => node.dataset.sharedMessageId === targetMessage);
            if (target) {
              bottom.current = false;
              target.scrollIntoView?.({ block: "center" });
              located.current = key;
            }
          } else if (!targetMessage && bottom.current && list.current)
            list.current.scrollTop = list.current.scrollHeight;
        }, [messages, targetMessage, conversation.id]);
        const assistantBackend = (message) =>
          (conversation.assistants || []).find(
            (row) => row.assistant_id === message.author_assistant_id,
          )?.assistant_backend ||
          conversation.assistant_backend ||
          "harness";
        return h33(
          "section",
          { className: "workagent-collab-chat", "aria-label": "共享对话" },
          h33(Feedback, { error }),
          h33(
            "div",
            {
              className: "workagent-collab-messages",
              ref: list,
              onScroll: () => {
                const node = list.current;
                bottom.current =
                  node.scrollHeight - node.scrollTop - node.clientHeight < 100;
              },
            },
            !messages.length
              ? h33(
                  "div",
                  { className: "workagent-collab-chat-empty" },
                  icon("chat", 32),
                  h33("h2", null, "一起把事情做好"),
                  h33("p", null, "在这里讨论、分享文件，需要助手时再 @ 它。"),
                )
              : null,
            ...messages.map((message) =>
              h33(
                "article",
                {
                  key: message.id,
                  "data-shared-message-id": message.id,
                  className: `workagent-message workagent-collab-message is-${message.kind}${message.is_current_user ? " is-user is-mine" : ""}${message.id === targetMessage ? " workagent-message-highlight" : ""}`,
                },
                h33(
                  "header",
                  null,
                  h33(
                    "span",
                    {
                      className:
                        "workagent-collab-avatar workagent-member-avatar",
                      "aria-hidden": true,
                    },
                    message.kind === "assistant"
                      ? assistantAvatar(
                          assistantBackend(message),
                          icon("chat", 18),
                        )
                      : message.kind === "system"
                        ? icon("chat", 16)
                        : Array.from(
                            (message.author_name || "?").trim(),
                          )[0]?.toLocaleUpperCase(),
                  ),
                  h33(
                    "strong",
                    null,
                    message.kind === "assistant"
                      ? message.author_name || "助手"
                      : message.kind === "system"
                        ? "项目动态"
                        : message.author_name,
                  ),
                  h33(
                    "time",
                    { dateTime: message.created_at },
                    new Date(message.created_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                  ),
                ),
                h33(
                  "div",
                  {
                    onClick: (event) => {
                      const anchor = event.target.closest?.("a[href]"),
                        raw = anchor?.getAttribute("href");
                      if (!raw || /^(?:https?:|mailto:|#|\/api\/)/i.test(raw))
                        return;
                      const path = raw
                        .replace(/^shared:\/\/[^/]+\//, "")
                        .replace(/^\.\//, "");
                      if (
                        !path.startsWith("/") &&
                        !path.includes(":") &&
                        !path.split("/").includes("..")
                      ) {
                        event.preventDefault();
                        window.open(
                          fileURL2(project.id, path),
                          "_blank",
                          "noopener",
                        );
                      }
                    },
                  },
                  h33(Markdown2, null, message.body),
                ),
                message.attachments?.length
                  ? h33(
                      "div",
                      { className: "workagent-collab-chips" },
                      ...message.attachments.map((path) =>
                        h33(
                          "a",
                          {
                            key: path,
                            href: fileURL2(project.id, path),
                            download: path.split("/").at(-1),
                          },
                          path.split("/").at(-1),
                        ),
                      ),
                    )
                  : null,
              ),
            ),
          ),
          ...(conversation.assistants || [])
            .filter((agent) => agent.active)
            .map((agent) =>
              h33(
                "div",
                {
                  key: agent.assistant_id,
                  role: "status",
                  className: "workagent-collab-running",
                },
                h33("span", null, `${agent.name} 正在处理…`),
                h33(
                  Button2,
                  {
                    "aria-label": `停止 ${agent.name}`,
                    onClick: async () => {
                      try {
                        await mutate2("shared-runs/cancel", {
                          conversation_id: conversation.id,
                          assistant_id: agent.assistant_id,
                        });
                      } catch (error2) {
                        setError(errorText(error2));
                      }
                    },
                  },
                  "停止",
                ),
              ),
            ),
          h33(Composer, {
            key: conversation.id,
            conversation,
            members,
            projectId: project.id,
            onSend: async (input) => {
              const value = await sendDiscussion(input, conversation);
              setMessages((rows) =>
                rows.some((row) => row.id === value.message.id)
                  ? rows
                  : [...rows, value.message],
              );
              bottom.current = true;
              setLocal((value2) => value2 + 1);
              void refresh();
              return value;
            },
          }),
        );
      }
      function Files({ project, onClose, revision }) {
        const [wide, setWide] = React37.useState(false);
        const resolveOfficePreview = async (_workspace, entry, signal) => {
          const result = await request2(`${root}/shared-office-preview`, {
            ...json({ project_id: project.id, path: entry.path }),
            signal,
          });
          return result.url;
        };
        const createEmptyFile = async ({ directory, name }) => {
          const result = await uploads2.uploadFiles(
            project.id,
            [new File([new Uint8Array(0)], name, { type: "text/plain" })],
            { directory },
          );
          if (result.failures.length)
            throw new Error(result.failures.join("；"));
        };
        return h33(
          "aside",
          {
            className: `workagent-collab-files is-unified${wide ? " is-wide" : ""}`,
            "aria-label": "项目文件侧栏",
          },
          h33(
            "header",
            { className: "workagent-files-panel-header" },
            h33("strong", null, "项目文件"),
            h33(FileIconButton, {
              name: "expand",
              label: wide ? "缩小文件侧栏" : "放大文件侧栏",
              onClick: () => setWide(!wide),
            }),
            h33(FileIconButton, {
              name: "close",
              label: "关闭文件侧栏",
              onClick: onClose,
            }),
          ),
          h33(
            "div",
            { className: "workagent-files-project", title: project.name },
            project.name,
          ),
          FileManager
            ? h33(FileManager, {
                key: project.id,
                workspace: project,
                root: fileRoot(project.id),
                trashRoot: `${fileRoot(project.id)}/trash`,
                contentURL: fileURL2,
                uploadClient: uploads2,
                resolveOfficePreview,
                editable: false,
                createEmptyFile,
                onDismiss: onClose,
              })
            : h33(
                "div",
                { className: "workagent-file-panel-empty" },
                "文件管理器暂不可用。",
              ),
        );
      }
      function Sidebar() {
        const { confirm, confirmation } = useConfirm();
        const state = useShared(),
          params = new URLSearchParams(useSearch()),
          selected = params.get("project"),
          pins = usePins("workagent.shared-project-pins.v1");
        const hasPersonalTasks = state.conversations.some(
          (row) => row.kind === "personal_task",
        );
        const [sessionState, reloadSessions] = useResource2(
          hasPersonalTasks ? `${apiRoot2}/sessions` : null,
        );
        React37.useEffect(() => {
          if (hasPersonalTasks) void reloadSessions();
        }, [state.revision, hasPersonalTasks]);
        const taskSessions = new Map(
          sessionState.rows.map((row) => [row.id, row]),
        );
        const [creating2, setCreating] = React37.useState(false),
          [invites, setInvites] = React37.useState(false),
          [searching, setSearching] = React37.useState(false),
          [collapsed, setCollapsed] = React37.useState({}),
          [sectionClosed, setSectionClosed] = React37.useState(false),
          [menu, setMenu] = React37.useState(null),
          [action, setAction] = React37.useState(null),
          [name, setName] = React37.useState(""),
          [busy, setBusy] = React37.useState(false),
          [query, setQuery] = React37.useState(""),
          [hidden, setHidden] = React37.useState(false),
          [error, setError] = React37.useState("");
        const members = useMembers(
          action?.kind === "members" ? action.project : null,
          state.revision,
        );
        const operation = React37.useRef(uid());
        const rows = sortProjectsByChat(
            state.projects,
            state.conversations,
            pins.pins,
          ).filter(
            (row) =>
              Boolean(row.hidden) === hidden &&
              (row.name.toLowerCase().includes(query.toLowerCase()) ||
                state.conversations.some(
                  (discussion) =>
                    discussion.project_id === row.id &&
                    !discussion.hidden &&
                    discussion.name.toLowerCase().includes(query.toLowerCase()),
                )),
          ),
          count = state.invites.filter(
            (row) => row.status === "pending",
          ).length;
        React37.useEffect(() => {
          const close = (event) => {
            if (event.defaultPrevented) return;
            if (event.key === "Escape") {
              if (menu) setMenu(null);
              else if (!action && !creating2 && !invites)
                closeMobileSidebar3?.();
            }
          };
          window.addEventListener("keydown", close);
          return () => window.removeEventListener("keydown", close);
        }, [menu, action, creating2, invites]);
        const begin = (kind, project, discussion) => {
          setMenu(null);
          setError("");
          setName(
            kind === "discussion"
              ? ""
              : discussion?.name || project?.name || "",
          );
          operation.current = uid();
          setAction({ kind, project, discussion });
        };
        const perform = async (fn) => {
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            await fn();
            setMenu(null);
            setAction(null);
          } catch (error2) {
            setError(errorText(error2));
          } finally {
            setBusy(false);
          }
        };
        const updateDiscussion = (discussion, fields) =>
          mutate2(
            "shared-conversations",
            { conversation_id: discussion.id, ...fields },
            "PATCH",
          );
        const more = (label, target) =>
          h33(SidebarAction, {
            label,
            "aria-haspopup": "dialog",
            onClick: () => {
              setError("");
              setMenu(target);
            },
          });
        const menuItem = (label, glyph, onClick) =>
          h33(Button2, { disabled: busy, onClick }, icon(glyph, 16), label);
        return h33(
          "section",
          {
            className: "workagent-sidebar-browser workagent-collab-sidebar",
            "aria-label": "协作项目",
          },
          h33("button", {
            type: "button",
            className: "workagent-mobile-backdrop",
            "aria-label": "收起导航菜单",
            tabIndex: -1,
            onClick: closeMobileSidebar3,
          }),
          h33(SidebarHeader, {
            title: hidden ? "已隐藏项目" : "项目",
            expanded: !sectionClosed,
            onToggle: () => setSectionClosed(!sectionClosed),
            actions: h33(
              React37.Fragment,
              null,
              h33(SidebarAction, {
                label: searching ? "关闭搜索" : "搜索共享项目",
                icon: searching ? "close" : "search",
                "aria-pressed": searching,
                onClick: () => {
                  setSearching(!searching);
                  setQuery("");
                },
              }),
              h33(SidebarAction, {
                label: "新建协作项目",
                icon: "plus",
                onClick: () => setCreating(true),
              }),
              more("协作更多操作", {}),
            ),
          }),
          searching
            ? h33(SidebarSearch, {
                autoFocus: true,
                "aria-label": "搜索共享项目",
                placeholder: "搜索项目",
                value: query,
                onChange: (event) => setQuery(event.target.value),
              })
            : null,
          count
            ? h33(
                Button2,
                {
                  className: "workagent-collab-invite-entry",
                  onClick: () => setInvites(true),
                },
                "项目邀请",
                h33("span", { className: "workagent-badge" }, count),
              )
            : null,
          h33(Feedback, { error: error || state.error }),
          h33(
            "div",
            { className: "workagent-sidebar-projects" },
            ...(sectionClosed ? [] : rows).map((project) => {
              const discussions = state.conversations
                .filter((row) => row.project_id === project.id && !row.hidden)
                .sort((a, b) => Number(b.pinned) - Number(a.pinned));
              const firstDiscussion = discussions.find(
                (row) => row.kind !== "personal_task",
              );
              return h33(
                SidebarGroup,
                {
                  key: project.id,
                  title: project.name,
                  icon: icon("workspace", 15),
                  pinned: pins.pins.includes(project.id),
                  expanded: !collapsed[project.id],
                  onToggle: () =>
                    setCollapsed((value) => ({
                      ...value,
                      [project.id]: !value[project.id],
                    })),
                  actions: h33(
                    React37.Fragment,
                    null,
                    h33(SidebarAction, {
                      label: `在 ${project.name} 中新建讨论`,
                      icon: "plus",
                      onClick: () => begin("discussion", project),
                    }),
                    more(`项目操作 ${project.name}`, { project }),
                  ),
                },
                ...discussions.map((discussion) => {
                  const personalTask = discussion.kind === "personal_task";
                  const active = personalTask
                    ? params.get("session") === discussion.runtime_session_id
                    : params.get("discussion") === discussion.id ||
                      (!params.get("discussion") &&
                        !params.get("session") &&
                        firstDiscussion === discussion);
                  return h33(SidebarRow, {
                    key: discussion.id,
                    title: discussion.name,
                    selected: selected === project.id && active,
                    icon: personalTask
                      ? SessionAvatar2
                        ? h33(SessionAvatar2, {
                            session: taskSessions.get(
                              discussion.runtime_session_id,
                            ),
                          })
                        : assistantAvatar(null, icon("chat", 16))
                      : icon("teams", 16),
                    meta: personalTask
                      ? h33("span", { className: "workagent-badge" }, "个人")
                      : null,
                    pinned: personalTask && !!discussion.pinned,
                    status: h33(SidebarStatus, {
                      running: discussion.state === "running",
                      label: "助手正在运行",
                    }),
                    onOpen: () =>
                      personalTask
                        ? go(
                            personalTaskRoute(
                              project.id,
                              discussion.runtime_session_id,
                            ),
                          )
                        : go(route(project.id, discussion.id)),
                    actions: personalTask
                      ? more(`个人任务操作 ${discussion.name}`, {
                          project,
                          discussion,
                        })
                      : h33(SidebarAction, {
                          label: `${discussion.pinned ? "取消置顶" : "置顶"} ${discussion.name}`,
                          icon: "pin",
                          disabled: busy,
                          "aria-pressed": !!discussion.pinned,
                          onClick: () =>
                            void perform(() =>
                              updateDiscussion(discussion, {
                                pinned: !discussion.pinned,
                              }),
                            ),
                        }),
                  });
                }),
                !discussions.length
                  ? h33(
                      "button",
                      {
                        type: "button",
                        className:
                          "workagent-sidebar-empty workagent-collab-open-empty",
                        onClick: () =>
                          void openProject(project.id).catch((error2) =>
                            setError(errorText(error2)),
                          ),
                      },
                      "开始讨论",
                    )
                  : null,
              );
            }),
          ),
          !rows.length && !sectionClosed
            ? h33(
                "p",
                { className: "workagent-collab-empty" },
                state.loading
                  ? "正在加载…"
                  : query
                    ? "没有找到项目"
                    : hidden
                      ? "没有隐藏项目"
                      : "创建项目，邀请同事一起协作。",
              )
            : null,
          menu?.discussion?.kind === "personal_task"
            ? h33(ConversationMenu, {
                title: menu.discussion.name,
                projectName: menu.project.name,
                pinned: !!menu.discussion.pinned,
                busy,
                error,
                onPin: () =>
                  void perform(() =>
                    updateDiscussion(menu.discussion, {
                      pinned: !menu.discussion.pinned,
                    }),
                  ),
                onManage: () =>
                  begin("rename-personal-task", menu.project, menu.discussion),
                onClose: () => {
                  if (!busy) setMenu(null);
                },
              })
            : menu
              ? h33(
                  Dialog,
                  {
                    title:
                      menu.discussion?.name || menu.project?.name || "协作",
                    onClose: () => setMenu(null),
                  },
                  h33(
                    ActionList,
                    null,
                    menu.discussion
                      ? h33(
                          React37.Fragment,
                          null,
                          menuItem(
                            menu.discussion.pinned ? "取消置顶" : "置顶讨论",
                            "pin",
                            () =>
                              void perform(() =>
                                updateDiscussion(menu.discussion, {
                                  pinned: !menu.discussion.pinned,
                                }),
                              ),
                          ),
                          menuItem("重命名讨论", "edit", () =>
                            begin(
                              "rename-discussion",
                              menu.project,
                              menu.discussion,
                            ),
                          ),
                        )
                      : menu.project
                        ? h33(
                            React37.Fragment,
                            null,
                            menuItem(
                              pins.pins.includes(menu.project.id)
                                ? "取消置顶"
                                : "置顶项目",
                              "pin",
                              () => {
                                pins.toggle(menu.project.id);
                                setMenu(null);
                              },
                            ),
                            menuItem("新建讨论", "plus", () =>
                              begin("discussion", menu.project),
                            ),
                            menuItem(
                              menu.project.currentRole === "owner"
                                ? "邀请与成员"
                                : "项目成员",
                              "teams",
                              () => begin("members", menu.project),
                            ),
                            menu.project.currentRole === "owner"
                              ? menuItem("重命名项目", "edit", () =>
                                  begin("rename", menu.project),
                                )
                              : null,
                            menu.project.currentRole === "owner"
                              ? menuItem("管理讨论", "list", () =>
                                  begin("manage-discussions", menu.project),
                                )
                              : null,
                            menuItem(
                              menu.project.hidden ? "显示项目" : "隐藏项目",
                              "workspace",
                              () =>
                                void perform(() =>
                                  mutate2(
                                    `shared-projects/${enc(menu.project.id)}`,
                                    { hidden: !menu.project.hidden },
                                    "PATCH",
                                  ),
                                ),
                            ),
                          )
                        : h33(
                            React37.Fragment,
                            null,
                            menuItem(
                              count ? `项目邀请 · ${count}` : "项目邀请",
                              "teams",
                              () => {
                                setMenu(null);
                                setInvites(true);
                              },
                            ),
                            menuItem(
                              hidden ? "返回项目" : "已隐藏项目",
                              "workspace",
                              () => {
                                setHidden(!hidden);
                                setMenu(null);
                              },
                            ),
                          ),
                  ),
                  h33(Feedback, { error }),
                )
              : null,
          action?.kind === "members"
            ? h33(Members, {
                project: action.project,
                members,
                revision: state.revision,
                onClose: () => setAction(null),
              })
            : null,
          action?.kind === "manage-discussions"
            ? h33(
                Dialog,
                {
                  title: "管理讨论",
                  onClose: () => setAction(null),
                },
                h33(
                  "div",
                  { className: "workagent-collab-discussion-manager" },
                  ...state.conversations
                    .filter(
                      (discussion) =>
                        discussion.project_id === action.project.id &&
                        !discussion.hidden &&
                        discussion.kind !== "personal_task",
                    )
                    .map((discussion) =>
                      h33(
                        "div",
                        { key: discussion.id, className: "workagent-file-row" },
                        icon("teams", 16),
                        h33(
                          "span",
                          { className: "workagent-file-name" },
                          discussion.name,
                        ),
                        h33(
                          "div",
                          { className: "workagent-file-actions" },
                          h33(
                            Button2,
                            {
                              onClick: () =>
                                begin(
                                  "rename-discussion",
                                  action.project,
                                  discussion,
                                ),
                            },
                            "重命名",
                          ),
                          h33(
                            Button2,
                            {
                              className: "workagent-button is-danger",
                              onClick: () =>
                                begin(
                                  "delete-discussion",
                                  action.project,
                                  discussion,
                                ),
                            },
                            "删除",
                          ),
                        ),
                      ),
                    ),
                ),
              )
            : null,
          action?.discussion?.kind === "personal_task"
            ? h33(ConversationManagementDialog, {
                name,
                onNameChange: setName,
                busy,
                error,
                deleting: action.kind === "delete-personal-task",
                deleteDescription: `删除个人任务“${action.discussion.name}”？会话和消息将一并删除，项目文件会保留。此操作无法撤销。`,
                onClose: () => {
                  if (!busy) setAction(null);
                },
                onRequestDelete: () =>
                  begin(
                    "delete-personal-task",
                    action.project,
                    action.discussion,
                  ),
                onSave: (event) => {
                  event.preventDefault();
                  if (!name.trim()) return;
                  void perform(() =>
                    updateDiscussion(action.discussion, { name: name.trim() }),
                  );
                },
                onDelete: (event) => {
                  event.preventDefault();
                  void perform(async () => {
                    await deletePersonalTask2(action.discussion);
                    if (
                      params.get("session") ===
                      action.discussion.runtime_session_id
                    )
                      go(route(action.project.id));
                  });
                },
              })
            : action && !["members", "manage-discussions"].includes(action.kind)
              ? h33(
                  Dialog,
                  {
                    title:
                      action.kind === "discussion"
                        ? "新建讨论"
                        : action.kind === "rename"
                          ? "重命名项目"
                          : action.kind === "delete-discussion"
                            ? "删除讨论"
                            : "重命名讨论",
                    onClose: () => {
                      if (!busy) setAction(null);
                    },
                  },
                  h33(
                    "form",
                    {
                      className: "workagent-collab-form",
                      onSubmit: (event) => {
                        event.preventDefault();
                        if (action.kind !== "delete-discussion" && !name.trim())
                          return;
                        void perform(async () => {
                          if (action.kind === "discussion") {
                            const value = await mutate2(
                              "shared-conversations",
                              {
                                project_id: action.project.id,
                                name: name.trim(),
                                operation_id: operation.current,
                              },
                            );
                            go(route(action.project.id, value.conversation.id));
                          } else if (action.kind === "rename")
                            await mutate2(
                              `shared-projects/${enc(action.project.id)}`,
                              { name: name.trim() },
                              "PATCH",
                            );
                          else if (action.kind === "rename-discussion")
                            await updateDiscussion(action.discussion, {
                              name: name.trim(),
                            });
                          else {
                            await mutate2(
                              "shared-conversations",
                              { conversation_id: action.discussion.id },
                              "DELETE",
                            );
                            if (
                              params.get("discussion") === action.discussion.id
                            ) {
                              const next = state.conversations.find(
                                (row) =>
                                  row.project_id === action.project.id &&
                                  row.id !== action.discussion.id &&
                                  !row.hidden &&
                                  row.kind !== "personal_task",
                              );
                              go(route(action.project.id, next?.id));
                            }
                          }
                        });
                      },
                    },
                    action.kind === "delete-discussion"
                      ? h33(
                          "p",
                          null,
                          `确定删除“${action.discussion.name}”及其全部消息？此操作无法撤销。`,
                        )
                      : h33(Input2, {
                          "aria-label": "名称",
                          required: true,
                          maxLength: 120,
                          value: name,
                          onChange: (event) => setName(event.target.value),
                        }),
                    action.kind === "discussion"
                      ? h33(PersonalTaskButton, {
                          project: action.project,
                          onClose: () => setAction(null),
                        })
                      : null,
                    h33(Feedback, { error }),
                    h33(
                      "footer",
                      null,
                      h33(
                        Button2,
                        { onClick: () => setAction(null), disabled: busy },
                        "取消",
                      ),
                      h33(
                        Button2,
                        {
                          type: "submit",
                          className:
                            action.kind === "delete-discussion"
                              ? "workagent-button is-danger"
                              : "workagent-button is-primary",
                          disabled:
                            busy ||
                            (action.kind !== "delete-discussion" &&
                              !name.trim()),
                        },
                        busy
                          ? "处理中…"
                          : action.kind === "delete-discussion"
                            ? "删除"
                            : "保存",
                      ),
                    ),
                  ),
                )
              : null,
          creating2
            ? h33(CreateProject, { onClose: () => setCreating(false) })
            : null,
          invites
            ? h33(Invitations, { onClose: () => setInvites(false) })
            : null,
          confirmation,
        );
      }
      function Page() {
        const { confirm, confirmation } = useConfirm();
        const state = useShared(),
          search = useSearch(),
          params = new URLSearchParams(search),
          project = state.projects.find(
            (row) => row.id === params.get("project"),
          );
        const discussions = state.conversations.filter(
            (row) =>
              row.project_id === project?.id &&
              !row.hidden &&
              row.kind !== "personal_task",
          ),
          conversation =
            discussions.find((row) => row.id === params.get("discussion")) ||
            discussions[0],
          members = useMembers(project, state.revision);
        const [modal, setModal] = React37.useState(""),
          [files, setFiles] = React37.useState(false),
          [error, setError] = React37.useState(""),
          [notice, setNotice] = React37.useState(""),
          [name, setName] = React37.useState(""),
          [busy, setBusy] = React37.useState(false);
        const discussionOperation = React37.useRef(uid());
        React37.useEffect(() => {
          setModal(
            params.has("token") ||
              params.has("invite") ||
              params.get("view") === "invites"
              ? "invites"
              : "",
          );
          setError("");
        }, [search]);
        React37.useEffect(() => {
          setFiles(false);
          const key = `workagent.shared.notice.${project?.id}`;
          setNotice(sessionStorage.getItem(key) || "");
          sessionStorage.removeItem(key);
          if (project && !discussions.length)
            void openProject(project.id).catch((error2) =>
              setError(errorText(error2)),
            );
        }, [project?.id]);
        async function perform(fn, success) {
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            await fn();
            setNotice(success || "");
            setModal("");
          } catch (error2) {
            setError(errorText(error2));
          } finally {
            setBusy(false);
          }
        }
        return h33(
          "div",
          { className: "workagent-collab-page" },
          confirmation,
          project
            ? h33(
                React37.Fragment,
                null,
                h33(
                  "header",
                  { className: "workagent-collab-project-header" },
                  h33(
                    "div",
                    { className: "workagent-collab-project-title" },
                    h33("h1", null, project.name),
                    h33(
                      "select",
                      {
                        "aria-label": "切换讨论",
                        value: conversation?.id || "",
                        onChange: (event) =>
                          go(route(project.id, event.target.value)),
                      },
                      ...discussions.map((row) =>
                        h33("option", { key: row.id, value: row.id }, row.name),
                      ),
                    ),
                  ),
                  h33(
                    "div",
                    { className: "workagent-collab-actions" },
                    conversation && SessionReminder
                      ? h33(
                          "details",
                          {
                            className: "workagent-collab-reminder",
                            key: conversation.id,
                          },
                          h33(
                            "summary",
                            {
                              className: "workagent-button",
                              "aria-label": "消息提醒",
                            },
                            "消息提醒",
                          ),
                          h33(
                            "div",
                            { className: "workagent-collab-reminder-popover" },
                            h33(
                              "small",
                              null,
                              "仅接收 Agent 完成提醒和产物文件。",
                            ),
                            h33(SessionReminder, {
                              sessionId: `collaboration:${conversation.id}`,
                            }),
                          ),
                        )
                      : null,
                    h33(
                      Button2,
                      {
                        onClick: () => setModal("members"),
                        "aria-label": "查看项目成员",
                        title: `${members.length} 位成员`,
                        className: "workagent-collab-members-button",
                      },
                      h33(
                        "span",
                        { className: "workagent-collab-avatars" },
                        ...members.slice(0, 3).map((member) =>
                          h33(
                            "span",
                            {
                              key: member.userId,
                              className: "workagent-collab-avatar",
                            },
                            Array.from(
                              (
                                member.displayName ||
                                member.username ||
                                "员"
                              ).trim(),
                            )[0].toLocaleUpperCase(),
                          ),
                        ),
                      ),
                    ),
                    h33(
                      Button2,
                      {
                        "aria-pressed": files,
                        "aria-label": "文件",
                        title: "项目文件",
                        className: "workagent-collab-header-icon",
                        onClick: () => setFiles(!files),
                      },
                      icon("workspace"),
                    ),
                    h33(
                      MoreMenu,
                      null,
                      h33(
                        Button2,
                        { onClick: () => setModal("members") },
                        project.currentRole === "owner"
                          ? "邀请与成员"
                          : "项目成员",
                      ),
                      h33(
                        Button2,
                        {
                          onClick: () =>
                            go(
                              `/?workagent=marketplace&marketProject=${enc(project.id)}`,
                            ),
                        },
                        "项目能力与版本",
                      ),
                      h33(
                        Button2,
                        {
                          onClick: () => {
                            setName("");
                            discussionOperation.current = uid();
                            setModal("discussion");
                          },
                        },
                        "新建讨论",
                      ),
                      project.currentRole === "owner"
                        ? h33(
                            Button2,
                            {
                              onClick: () => {
                                setName(project.name);
                                setModal("rename");
                              },
                            },
                            "重命名",
                          )
                        : null,
                      project.currentRole === "owner" && conversation
                        ? h33(
                            Button2,
                            {
                              onClick: () => {
                                setModal("assistant");
                              },
                            },
                            "助手设置",
                          )
                        : null,
                      h33(
                        Button2,
                        {
                          onClick: () =>
                            perform(
                              () =>
                                mutate2(
                                  `shared-projects/${enc(project.id)}`,
                                  { hidden: !project.hidden },
                                  "PATCH",
                                ),
                              project.hidden
                                ? "项目已显示。"
                                : "项目已隐藏，可从已隐藏列表找回。",
                            ),
                        },
                        project.hidden ? "显示项目" : "隐藏项目",
                      ),
                      project.currentRole !== "owner"
                        ? h33(
                            Button2,
                            {
                              onClick: async () => {
                                if (
                                  await confirm(
                                    "退出项目后将无法继续访问文件和讨论，确定退出？",
                                  )
                                )
                                  void perform(async () => {
                                    await mutate2(
                                      `shared-projects/${enc(project.id)}/members/me`,
                                      void 0,
                                      "DELETE",
                                    );
                                    go(route());
                                  }, "已退出项目。");
                              },
                            },
                            "退出项目",
                          )
                        : null,
                    ),
                  ),
                ),
                h33(Feedback, { error: error || state.error, notice }),
                h33(
                  "div",
                  { className: "workagent-collab-workspace" },
                  conversation
                    ? h33(Chat, {
                        key: conversation.id,
                        conversation,
                        project,
                        members,
                        revision: state.revision,
                      })
                    : h33("p", null, "正在准备讨论…"),
                  files
                    ? h33(Files, {
                        key: project.id,
                        project,
                        revision: state.revision,
                        onClose: () => setFiles(false),
                      })
                    : null,
                ),
              )
            : h33(
                "div",
                { className: "workagent-collab-welcome" },
                icon("teams", 42),
                h33("h1", null, "一起协作"),
                h33(
                  "p",
                  null,
                  params.get("project") && !state.loading
                    ? "项目不存在，或你已没有访问权限。"
                    : "共享项目、讨论和文件，需要助手时再 @ 它。",
                ),
                h33(Feedback, { error: error || state.error }),
                h33(
                  "div",
                  { className: "workagent-collab-actions" },
                  h33(
                    Button2,
                    {
                      className: "workagent-button is-primary",
                      onClick: () => setModal("create"),
                    },
                    "新建协作项目",
                  ),
                  h33(
                    Button2,
                    { onClick: () => setModal("invites") },
                    "查看邀请",
                  ),
                ),
                state.projects.some((row) => !row.hidden)
                  ? h33(
                      "div",
                      { className: "workagent-collab-project-grid" },
                      ...state.projects
                        .filter((row) => !row.hidden)
                        .map((row) =>
                          h33(
                            Button2,
                            {
                              key: row.id,
                              onClick: () =>
                                void openProject(row.id).catch((error2) =>
                                  setError(errorText(error2)),
                                ),
                            },
                            icon("workspace"),
                            row.name,
                          ),
                        ),
                    )
                  : null,
              ),
          modal === "create"
            ? h33(CreateProject, { onClose: () => setModal("") })
            : null,
          modal === "invites"
            ? h33(Invitations, {
                onClose: () => {
                  setModal("");
                  if (
                    params.has("token") ||
                    params.has("invite") ||
                    params.has("view")
                  )
                    go(route(project?.id, conversation?.id));
                },
              })
            : null,
          modal === "members" && project
            ? h33(Members, {
                project,
                members,
                revision: state.revision,
                onClose: () => setModal(""),
              })
            : null,
          modal === "assistant" && project
            ? h33(AssistantSettings, {
                project,
                revision: state.revision,
                onClose: () => setModal(""),
              })
            : null,
          ["rename", "discussion"].includes(modal) && project
            ? h33(
                Dialog,
                {
                  title: modal === "rename" ? "重命名项目" : "新建讨论",
                  onClose: () => setModal(""),
                },
                h33(
                  "form",
                  {
                    className: "workagent-collab-form",
                    onSubmit: (event) => {
                      event.preventDefault();
                      void perform(async () => {
                        if (modal === "rename")
                          await mutate2(
                            `shared-projects/${enc(project.id)}`,
                            { name: name.trim() },
                            "PATCH",
                          );
                        else {
                          const value = await mutate2("shared-conversations", {
                            project_id: project.id,
                            name: name.trim(),
                            operation_id: discussionOperation.current,
                          });
                          go(route(project.id, value.conversation.id));
                        }
                      }, "已保存。");
                    },
                  },
                  h33(
                    "label",
                    null,
                    "名称",
                    h33(Input2, {
                      "aria-label":
                        modal === "rename" ? "项目名称" : "讨论名称",
                      value: name,
                      onChange: (event) => setName(event.target.value),
                      required: true,
                      maxLength: 128,
                    }),
                  ),
                  modal === "discussion"
                    ? h33(PersonalTaskButton, {
                        project,
                        onClose: () => setModal(""),
                      })
                    : null,
                  h33(
                    "footer",
                    null,
                    h33(Button2, { onClick: () => setModal("") }, "取消"),
                    h33(
                      Button2,
                      {
                        type: "submit",
                        className: "workagent-button is-primary",
                        disabled: busy,
                      },
                      busy ? "保存中…" : "保存",
                    ),
                  ),
                ),
              )
            : null,
        );
      }
      function Hero({ onExit, initial = "" }) {
        const state = useShared(),
          [projectId, setProjectId] = React37.useState(""),
          [creating2, setCreating] = React37.useState(false),
          [pending, setPending] = React37.useState(null);
        const project = state.projects.find((row) => row.id === projectId),
          conversation = state.conversations.find(
            (row) =>
              row.project_id === projectId &&
              !row.hidden &&
              row.kind !== "personal_task",
          ),
          members = useMembers(project, state.revision);
        async function send(input) {
          if (!project) {
            setPending(input);
            setCreating(true);
            throw new Error("先创建协作项目，消息将保留并在创建后发送。");
          }
          const target =
            conversation ||
            (await mutate2(`shared-projects/${enc(project.id)}/discussion`, {}))
              .conversation;
          const result = await sendDiscussion(input, target);
          await refresh();
          go(route(project.id, target.id));
          return result;
        }
        return h33(
          "div",
          { className: "workagent-collab-hero" },
          h33(Composer, {
            key: projectId || "new",
            conversation,
            members,
            initial,
            projectId,
            onSend: send,
          }),
          h33(
            "div",
            { className: "workagent-project-row" },
            h33(
              "select",
              {
                "aria-label": "协作项目",
                value: projectId,
                onChange: (event) => setProjectId(event.target.value),
              },
              h33("option", { value: "" }, "新建协作项目…"),
              ...state.projects
                .filter((row) => !row.hidden)
                .map((row) =>
                  h33("option", { key: row.id, value: row.id }, row.name),
                ),
            ),
            h33(Button2, { onClick: () => setCreating(true) }, "创建项目"),
            h33(
              "label",
              { className: "workagent-team-toggle" },
              h33("input", {
                type: "checkbox",
                checked: true,
                onChange: onExit,
              }),
              "协作模式",
            ),
          ),
          creating2
            ? h33(CreateProject, {
                onClose: () => setCreating(false),
                onCreated: async (value) => {
                  if (pending) {
                    await sendDiscussion(pending, value.conversation);
                    setPending(null);
                  }
                  await refresh();
                  go(route(value.project.id, value.conversation.id));
                },
              })
            : null,
        );
      }
      return Object.assign(Page, {
        Sidebar,
        Hero,
        Invitations,
        CreateProject,
        Composer,
        AssistantMembers,
        AssistantSettings,
        Chat,
        useShared,
        refresh,
        openProject,
        route,
        errorText,
      });
    }

    // src/features/conversations/composer.js
    var import_react24 = __toESM(require("react"), 1);
    var import_react25 = require("react");
    function submitComposerOnEnter(event, submit) {
      if (
        event.key !== "Enter" ||
        event.shiftKey ||
        event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === 229
      )
        return;
      event.preventDefault();
      if (submit) submit(event);
      (
        event.currentTarget.form || event.currentTarget.closest("form")
      )?.requestSubmit();
    }
    function ComposerInput(props) {
      return (0, import_react25.createElement)(workbench.FileComposer, props);
    }
    function ComposerForm({
      children,
      className,
      showSettings = true,
      ...props
    }) {
      const [expanded, setExpanded] = import_react24.default.useState(false);
      const formRef = import_react24.default.useRef(null);
      import_react24.default.useLayoutEffect(() => {
        const form = formRef.current;
        const container = form.parentElement;
        const measure = () =>
          container.style.setProperty(
            "--workagent-composer-height",
            `${form.getBoundingClientRect().height}px`,
          );
        const observer = new ResizeObserver(measure);
        observer.observe(form);
        measure();
        const viewport = window.visualViewport;
        const keyboard = () => {
          const offset =
            viewport &&
            window.matchMedia("(max-width: 760px)").matches &&
            viewport.scale === 1 &&
            form.contains(document.activeElement)
              ? Math.max(
                  0,
                  window.innerHeight - viewport.height - viewport.offsetTop,
                )
              : 0;
          container.style.setProperty(
            "--workagent-keyboard-offset",
            `${offset}px`,
          );
        };
        viewport?.addEventListener("resize", keyboard);
        viewport?.addEventListener("scroll", keyboard);
        form.addEventListener("focusin", keyboard);
        return () => {
          observer.disconnect();
          container.style.removeProperty("--workagent-composer-height");
          viewport?.removeEventListener("resize", keyboard);
          viewport?.removeEventListener("scroll", keyboard);
          form.removeEventListener("focusin", keyboard);
          container.style.removeProperty("--workagent-keyboard-offset");
        };
      }, []);
      return (0, import_react25.createElement)(
        "form",
        {
          ...props,
          ref: formRef,
          className: `${className} workagent-compact-composer`,
          "data-options-open": expanded,
        },
        children,
        showSettings
          ? (0, import_react25.createElement)(
              "button",
              {
                type: "button",
                className: "workagent-composer-settings",
                "aria-label": "模型与权限设置",
                "aria-expanded": expanded,
                // Focusing this button must not move it between pointer down/up.
                onPointerDown: (event) => {
                  if (event.button === 0) event.preventDefault();
                },
                onClick: () => setExpanded(!expanded),
              },
              (0, import_react25.createElement)(Icon, {
                name: "settings",
                size: 18,
              }),
            )
          : null,
      );
    }

    // src/features/files/moves.js
    function createFileMoves({
      React: React37,
      request: request2,
      h: h33,
      friendlyError: friendlyError2,
    }) {
      const mime = "application/x-workagent-project-files";
      const contains = (parent, path) =>
        path.toLowerCase() === parent.toLowerCase() ||
        path.toLowerCase().startsWith(parent.toLowerCase() + "/");
      const join = (directory, name) =>
        [directory, name].filter(Boolean).join("/");
      function useFileMoves2({
        root,
        workspaceId,
        dirtyFiles,
        onCompleted,
        onError,
      }) {
        const [checked, setChecked] = React37.useState([]);
        const [picker, setPicker] = React37.useState(null);
        const [target, setTarget] = React37.useState("");
        const [folders, setFolders] = React37.useState([]);
        const [folderName, setFolderName] = React37.useState("");
        const [hover, setHover] = React37.useState(null);
        const [operations, setOperations] = React37.useState([]);
        const [conflict, setConflict] = React37.useState(null);
        const [busy, setBusy] = React37.useState(false);
        const seen = React37.useRef(null);
        const callback = React37.useRef(onCompleted);
        callback.current = onCompleted;
        const drag = React37.useRef(null);
        const accept = (op) => {
          const key = `${op.state}:${op.applied}`;
          if (seen.current?.get(op.id) !== key && op.applied)
            callback.current(op.moves.slice(0, op.applied));
          seen.current?.set(op.id, key);
          setOperations((rows) => [
            ...rows.filter((row) => row.id !== op.id),
            op,
          ]);
        };
        React37.useEffect(() => {
          let live = true;
          const poll = async () => {
            try {
              const rows = await request2(`${root}/move`);
              if (!live || !Array.isArray(rows)) return;
              if (seen.current)
                for (const op of rows) {
                  if (
                    seen.current.get(op.id) !== `${op.state}:${op.applied}` &&
                    op.applied
                  )
                    callback.current(op.moves.slice(0, op.applied));
                }
              seen.current = new Map(
                rows.map((op) => [op.id, `${op.state}:${op.applied}`]),
              );
              setOperations(rows);
            } catch (error) {
              if (live) onError(friendlyError2(error.message));
            }
          };
          void poll();
          const timer = setInterval(poll, 2e3);
          return () => {
            live = false;
            clearInterval(timer);
          };
        }, [root]);
        React37.useEffect(() => {
          if (!picker) return;
          const controller = new AbortController();
          request2(`${root}/files?path=${encodeURIComponent(target)}`, {
            signal: controller.signal,
          })
            .then((rows) => {
              if (!controller.signal.aborted)
                setFolders(rows.filter((row) => row.kind === "directory"));
            })
            .catch((error) => {
              if (!controller.signal.aborted)
                onError(friendlyError2(error.message));
            });
          return () => controller.abort();
        }, [root, picker, target]);
        const submit = async (moves, keepBoth = false) => {
          if (busy) return;
          setBusy(true);
          onError("");
          try {
            const result = await request2(`${root}/move`, {
              method: "POST",
              body: JSON.stringify({
                moves,
                ...(keepBoth ? { conflict: "rename" } : {}),
              }),
            });
            accept(result);
            setPicker(null);
            setChecked([]);
            setConflict(null);
            if (result.state === "failed")
              onError(friendlyError2(result.error));
          } catch (error) {
            if (error.message === "destination_exists") setConflict(moves);
            else onError(friendlyError2(error.message));
          } finally {
            setBusy(false);
          }
        };
        const moveTo = (entries, directory) => {
          const top = entries.filter(
            (entry) =>
              !entries.some(
                (other) => other !== entry && contains(other.path, entry.path),
              ),
          );
          const moves = top
            .map((entry) => ({
              source: entry.path,
              destination: join(directory, entry.name),
              fileId: entry.fileId,
            }))
            .filter((m) => m.source !== m.destination);
          if (moves.length) void submit(moves);
          else onError("文件已在此文件夹中。");
        };
        const action = async (op, kind) => {
          try {
            accept(
              await request2(`${root}/move`, {
                method: "POST",
                body: JSON.stringify({ action: kind, id: op.id }),
              }),
            );
          } catch (error) {
            onError(friendlyError2(error.message));
          }
        };
        const destinationProps = (path) => ({
          "data-move-target": path,
          onDragOver: (event) => {
            if (!event.dataTransfer.types.includes(mime)) return;
            event.preventDefault();
            event.stopPropagation();
            const invalid = drag.current?.some((row) =>
              contains(row.path, path),
            );
            event.dataTransfer.dropEffect = invalid ? "none" : "move";
            setHover(invalid ? null : path);
          },
          onDragLeave: (event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setHover(null);
          },
          onDrop: (event) => {
            if (!event.dataTransfer.types.includes(mime)) return;
            event.preventDefault();
            event.stopPropagation();
            setHover(null);
            try {
              const payload = JSON.parse(event.dataTransfer.getData(mime));
              if (payload.workspaceId !== workspaceId)
                throw new Error("只能在当前项目内移动文件。");
              moveTo(payload.entries, path);
            } catch (error) {
              onError(friendlyError2(error.message));
            }
          },
        });
        const open = (entry) => {
          setTarget("");
          setFolderName("");
          setPicker(
            entry
              ? checked.some((row) => row.path === entry.path)
                ? checked
                : [entry]
              : checked,
          );
        };
        const button = (label, onClick, disabled = false) =>
          h33(
            "button",
            {
              type: "button",
              className: "workagent-button",
              onClick,
              disabled,
            },
            label,
          );
        const pending = operations.filter((op) => op.state === "queued");
        const last = operations.filter((op) => op.state === "completed").at(-1);
        return {
          open,
          submit,
          hover,
          checked,
          rowProps: (entry) => ({
            draggable: !busy,
            "data-file-path": entry.path,
            onDragStart: (event) => {
              const entries = checked.some((row) => row.path === entry.path)
                ? checked
                : [entry];
              drag.current = entries;
              event.dataTransfer.setData(
                mime,
                JSON.stringify({ workspaceId, entries }),
              );
              event.dataTransfer.effectAllowed = "move";
            },
            onDragEnd: () => {
              drag.current = null;
              setHover(null);
            },
            ...(entry.kind === "directory" ? destinationProps(entry.path) : {}),
          }),
          destinationProps,
          checkbox: (entry) =>
            h33("input", {
              type: "checkbox",
              "aria-label": `选择 ${entry.name}`,
              checked: checked.some((row) => row.path === entry.path),
              onChange: (event) =>
                setChecked((rows) =>
                  event.target.checked
                    ? [...rows, entry]
                    : rows.filter((row) => row.path !== entry.path),
                ),
            }),
          controls: h33(
            React37.Fragment,
            null,
            checked.length
              ? h33(
                  "div",
                  { className: "workagent-move-selection" },
                  `已选择 ${checked.length} 项`,
                  button("移动到…", () => open()),
                  button("取消选择", () => setChecked([])),
                )
              : null,
            ...pending.map((op) =>
              h33(
                "div",
                {
                  key: op.id,
                  role: "status",
                  className: "workagent-file-notice",
                },
                h33("span", null, "已安排移动，等待任务结束或文件编辑保存。"),
                button("取消移动", () => action(op, "cancel")),
              ),
            ),
            last
              ? h33(
                  "div",
                  { role: "status", className: "workagent-file-notice" },
                  `已移动 ${last.moves.length} 项到 ${last.moves[0].destination.split("/").slice(0, -1).join(" / ") || "根目录"}`,
                  button("撤销移动", () => action(last, "undo")),
                )
              : null,
            ...operations
              .filter((op) => op.state === "failed")
              .slice(-1)
              .map((op) =>
                h33(
                  "p",
                  { role: "alert", key: op.id },
                  `移动未完成（已移动 ${op.applied}/${op.moves.length} 项）：${friendlyError2(op.error)}`,
                ),
              ),
            conflict
              ? h33(
                  "div",
                  { role: "alert", className: "workagent-file-action-form" },
                  "目标文件夹已有同名文件，原文件会保留。",
                  button("保留两份", () => submit(conflict, true), busy),
                  button("取消", () => setConflict(null)),
                )
              : null,
            picker
              ? h33(
                  "section",
                  {
                    role: "dialog",
                    "aria-label": "移动到文件夹",
                    className: "workagent-move-picker",
                  },
                  h33("strong", null, `移动 ${picker.length} 项到…`),
                  h33(
                    "nav",
                    { "aria-label": "目标文件夹" },
                    button("根目录", () => setTarget("")),
                    ...target
                      .split("/")
                      .filter(Boolean)
                      .map((part, i, parts) =>
                        button(part, () =>
                          setTarget(parts.slice(0, i + 1).join("/")),
                        ),
                      ),
                  ),
                  h33(
                    "div",
                    { className: "workagent-move-folder-list" },
                    ...folders.map((folder) =>
                      button(
                        `📁 ${folder.name}`,
                        () => setTarget(folder.path),
                        picker.some((entry) =>
                          contains(entry.path, folder.path),
                        ),
                      ),
                    ),
                  ),
                  h33(
                    "div",
                    { className: "workagent-move-new-folder" },
                    h33("input", {
                      "aria-label": "新文件夹名称",
                      value: folderName,
                      placeholder: "新文件夹名称",
                      onChange: (event) => setFolderName(event.target.value),
                    }),
                    button("新建文件夹", async () => {
                      if (
                        !folderName.trim() ||
                        /[\\/:*?"<>|]/.test(folderName) ||
                        [".", ".."].includes(folderName.trim())
                      )
                        return onError("请输入有效文件夹名称。");
                      try {
                        const path = join(target, folderName.trim());
                        await request2(`${root}/directories`, {
                          method: "POST",
                          body: JSON.stringify({ path }),
                        });
                        setFolderName("");
                        setTarget(path);
                      } catch (error) {
                        onError(friendlyError2(error.message));
                      }
                    }),
                  ),
                  dirtyFiles.size
                    ? h33(
                        "p",
                        null,
                        "有未保存编辑时，移动将在保存或关闭编辑后进行。",
                      )
                    : null,
                  button("取消", () => setPicker(null)),
                  button(
                    "移动到这里",
                    () => moveTo(picker, target),
                    busy ||
                      picker.some((entry) => contains(entry.path, target)),
                  ),
                )
              : null,
          ),
        };
      }
      return { useFileMoves: useFileMoves2 };
    }

    // src/features/files/trash.js
    function createFileTrash({
      React: React37,
      request: request2,
      h: h33,
      Icon: Icon2,
      Button: Button2,
      FileIconButton: FileIconButton2,
      FileTreeRow: FileTreeRow2,
      friendlyError: friendlyError2,
      fileSize: fileSize2,
    }) {
      const storageSize = (size) =>
        size >= 1024 ** 3
          ? `${(size / 1024 ** 3).toFixed(1)} GB`
          : fileSize2(size);
      const dateLabel = (value) =>
        new Date(value).toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
      const expiresLabel = (value) => {
        const days = (Date.parse(value) - Date.now()) / 864e5;
        return days <= 0
          ? "等待自动清理"
          : days < 1
            ? "不足 1 天后清理"
            : `${Math.ceil(days)} 天后清理`;
      };
      const originalLocation = (entry) =>
        entry.legacy ? "项目根目录（旧版记录）" : entry.path;
      function useFileTrash2({ root, enabled }) {
        const [data, setData] = React37.useState(null);
        const [loading, setLoading] = React37.useState(false);
        const [busy, setBusy] = React37.useState(false);
        const [error, setError] = React37.useState("");
        const [notice, setNotice] = React37.useState("");
        const [menu, setMenu] = React37.useState(null);
        const [action, setAction] = React37.useState(null);
        const pending = React37.useRef(null);
        const live = React37.useRef(false);
        const refresh = React37.useCallback(async () => {
          pending.current?.abort();
          const controller = new AbortController();
          pending.current = controller;
          setLoading(true);
          setError("");
          try {
            const value = await request2(root, { signal: controller.signal });
            if (!controller.signal.aborted) setData(value);
          } catch (reason) {
            if (!controller.signal.aborted)
              setError(friendlyError2(reason.message));
          } finally {
            if (!controller.signal.aborted) setLoading(false);
          }
        }, [root]);
        React37.useEffect(() => {
          if (!enabled) return;
          live.current = true;
          setData(null);
          setAction(null);
          setMenu(null);
          setNotice("");
          void refresh();
          const update = () => void refresh();
          window.addEventListener("focus", update);
          window.addEventListener("workagent:files-changed", update);
          window.addEventListener("workagent:shared-changed", update);
          const timer = setInterval(update, 3e4);
          return () => {
            live.current = false;
            pending.current?.abort();
            clearInterval(timer);
            window.removeEventListener("focus", update);
            window.removeEventListener("workagent:files-changed", update);
            window.removeEventListener("workagent:shared-changed", update);
          };
        }, [enabled, refresh]);
        const beginAction = (kind, entry) => {
          setMenu(null);
          setError("");
          setNotice("");
          setAction({ kind, entry });
        };
        const mutate2 = async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          const { kind, entry } = action;
          try {
            const endpoint2 = `${root}/${encodeURIComponent(entry.id)}`;
            await request2(
              kind === "restore" ? `${endpoint2}/restore` : endpoint2,
              {
                method: kind === "restore" ? "POST" : "DELETE",
              },
            );
            if (!live.current) return;
            setAction(null);
            setData((value) => ({
              ...value,
              entries: value.entries.filter((row) => row.id !== entry.id),
            }));
            setNotice(
              kind === "restore"
                ? `已恢复“${entry.name}”`
                : `已永久删除“${entry.name}”`,
            );
            window.dispatchEvent(new Event("workagent:files-changed"));
          } catch (reason) {
            if (live.current)
              setError(
                reason.message === "file_exists"
                  ? "原位置已有同名文件。请先在项目文件中重命名或移走同名文件，再恢复。"
                  : reason.status === 404
                    ? "此文件已被恢复或清理，请刷新回收站。"
                    : friendlyError2(reason.message),
              );
          } finally {
            if (live.current) setBusy(false);
          }
        };
        const content = h33(
          React37.Fragment,
          null,
          h33(
            "section",
            {
              className: "workagent-trash-summary",
              "aria-label": "回收站保留规则",
            },
            h33(
              "div",
              { className: "workagent-trash-summary-heading" },
              h33("strong", null, "文件恢复"),
              h33("span", null, `保留 ${data?.retentionDays || 7} 天`),
            ),
            h33(
              "p",
              null,
              `删除后最多保留 ${data?.retentionDays || 7} 天。共享空间不足时，按删除时间从早到晚自动清理。`,
            ),
            data
              ? h33(
                  React37.Fragment,
                  null,
                  h33(
                    "div",
                    { className: "workagent-trash-capacity" },
                    h33("span", null, "所有成员共享回收空间"),
                    h33(
                      "span",
                      null,
                      `${storageSize(data.usedBytes)} / ${storageSize(data.limitBytes)}`,
                    ),
                  ),
                  h33("progress", {
                    "aria-label": "共享回收空间使用量",
                    value: data.usedBytes,
                    max: data.limitBytes,
                  }),
                )
              : null,
          ),
          error
            ? h33(
                "p",
                { role: "alert", className: "workagent-file-notice is-error" },
                error,
              )
            : null,
          notice
            ? h33(
                "p",
                { role: "status", className: "workagent-file-notice" },
                notice,
              )
            : null,
          action
            ? h33(
                "form",
                {
                  className: "workagent-file-action-form",
                  "aria-label":
                    action.kind === "restore" ? "恢复文件" : "永久删除文件",
                  onSubmit: mutate2,
                },
                h33(
                  "strong",
                  null,
                  action.kind === "restore" ? "恢复文件" : "永久删除文件",
                ),
                h33(
                  "p",
                  null,
                  action.kind === "restore"
                    ? `将“${action.entry.name}”${action.entry.kind === "directory" ? "及其内容" : ""}恢复到${action.entry.legacy ? "项目根目录" : "原位置"}？`
                    : `永久删除“${action.entry.name}”${action.entry.kind === "directory" ? "及其内容" : ""}？此操作无法撤销。`,
                ),
                action.kind === "restore"
                  ? h33(
                      "p",
                      { className: "workagent-trash-restore-path" },
                      originalLocation(action.entry),
                    )
                  : null,
                h33(
                  "div",
                  null,
                  h33(
                    Button2,
                    { disabled: busy, onClick: () => setAction(null) },
                    "取消",
                  ),
                  h33(
                    Button2,
                    {
                      type: "submit",
                      disabled: busy,
                      ...(action.kind === "delete"
                        ? { className: "workagent-button is-danger" }
                        : {}),
                    },
                    busy
                      ? "处理中…"
                      : action.kind === "restore"
                        ? "确认恢复"
                        : "永久删除",
                  ),
                ),
              )
            : null,
          data
            ? h33(
                "div",
                { className: "workagent-trash-list-heading" },
                h33("strong", null, `本项目 · ${data.entries.length} 项`),
                h33("span", null, storageSize(data.projectUsedBytes)),
              )
            : null,
          h33(
            "div",
            {
              className: "workagent-file-tree workagent-trash-list",
              "aria-label": "当前项目回收站文件",
              "aria-busy": loading,
            },
            !data
              ? error
                ? h33(
                    "div",
                    { className: "workagent-file-panel-empty" },
                    h33(Icon2, { name: "trash", size: 32 }),
                    h33("strong", null, "暂时无法读取回收站"),
                    h33(
                      Button2,
                      { onClick: refresh, disabled: loading },
                      "重新加载",
                    ),
                  )
                : h33(
                    "p",
                    { role: "status", className: "workagent-file-notice" },
                    "正在加载回收站…",
                  )
              : data.entries.length
                ? h33(
                    "ul",
                    { className: "workagent-file-tree-list" },
                    ...data.entries.map((entry) =>
                      h33(
                        "li",
                        { key: entry.id },
                        h33(
                          FileTreeRow2,
                          {
                            className: `workagent-trash-row${menu === entry.id ? " is-selected" : ""}`,
                          },
                          h33(
                            "button",
                            {
                              type: "button",
                              className: "workagent-file-tree-name",
                              title: originalLocation(entry),
                              "aria-label": `查看 ${entry.name} 的回收信息`,
                              "aria-expanded": menu === entry.id,
                              disabled: busy,
                              onClick: () =>
                                setMenu(menu === entry.id ? null : entry.id),
                            },
                            h33(Icon2, {
                              name:
                                entry.kind === "directory"
                                  ? "workspace"
                                  : "file",
                              size: 17,
                            }),
                            h33(
                              "span",
                              { className: "workagent-trash-file-label" },
                              h33("span", null, entry.name),
                              h33(
                                "small",
                                null,
                                entry.legacy
                                  ? "旧版记录 · 恢复至根目录"
                                  : entry.path,
                              ),
                            ),
                          ),
                          h33("small", null, storageSize(entry.size)),
                          h33(FileIconButton2, {
                            name: "more",
                            label: `操作 ${entry.name}`,
                            "aria-expanded": menu === entry.id,
                            disabled: busy,
                            onClick: () =>
                              setMenu(menu === entry.id ? null : entry.id),
                          }),
                        ),
                        h33(
                          "div",
                          { className: "workagent-trash-file-time" },
                          h33(
                            "time",
                            { dateTime: entry.deletedAt },
                            `${dateLabel(entry.deletedAt)} 删除`,
                          ),
                          h33(
                            "span",
                            { title: `${dateLabel(entry.expiresAt)} 自动清理` },
                            expiresLabel(entry.expiresAt),
                          ),
                        ),
                        menu === entry.id
                          ? h33(
                              "div",
                              {
                                className: "workagent-file-row-menu",
                                "aria-label": `${entry.name} 的操作`,
                              },
                              h33(
                                "button",
                                {
                                  type: "button",
                                  disabled: busy,
                                  onClick: () => beginAction("restore", entry),
                                },
                                "恢复",
                              ),
                              h33(
                                "button",
                                {
                                  type: "button",
                                  disabled: busy,
                                  className: "workagent-trash-delete",
                                  onClick: () => beginAction("delete", entry),
                                },
                                "永久删除",
                              ),
                            )
                          : null,
                      ),
                    ),
                  )
                : h33(
                    "div",
                    { className: "workagent-file-panel-empty" },
                    h33(Icon2, { name: "trash", size: 32 }),
                    h33("strong", null, "本项目回收站为空"),
                    h33(
                      "p",
                      null,
                      "项目中删除的文件会暂存在这里，可在清理前恢复。",
                    ),
                  ),
          ),
        );
        return { content, refresh, busy, loading };
      }
      return { useFileTrash: useFileTrash2 };
    }

    // src/features/files/manager.js
    var import_react26 = __toESM(require("react"), 1);
    var import_react27 = require("react");
    var { useFileMoves } = createFileMoves({
      React: import_react26.default,
      request,
      h: import_react27.createElement,
      friendlyError,
    });
    var { useFileTrash } = createFileTrash({
      React: import_react26.default,
      request,
      h: import_react27.createElement,
      Icon,
      Button,
      FileIconButton,
      FileTreeRow,
      friendlyError,
      fileSize,
    });
    function WorkspaceFileManager({
      workspace,
      onDismiss,
      dismissLabel,
      root = `${apiRoot}/workspaces/${encodeURIComponent(workspace.id)}`,
      contentURL = fileURL,
      uploadClient = uploads,
      resolveOfficePreview,
      editable = true,
      createEmptyFile,
      trashRoot,
    }) {
      const [tree, setTree] = import_react26.default.useState({});
      const { confirm, confirmation } = useConfirm();
      const [trashOpen, setTrashOpen] = import_react26.default.useState(false);
      const trash = useFileTrash({ root: trashRoot, enabled: trashOpen });
      const [expanded, setExpanded] = import_react26.default.useState(
        /* @__PURE__ */ new Set([""]),
      );
      const [directory, setDirectory] = import_react26.default.useState("");
      const [selected, setSelected] = import_react26.default.useState(null);
      const [tabs, setTabs] = import_react26.default.useState([]);
      const [dirtyFiles, setDirtyFiles] = import_react26.default.useState(
        /* @__PURE__ */ new Set(),
      );
      const reportDirty = import_react26.default.useCallback(
        (path, value) =>
          setDirtyFiles((current) => {
            if (current.has(path) === value) return current;
            const next = new Set(current);
            if (value) next.add(path);
            else next.delete(path);
            return next;
          }),
        [],
      );
      const closeTab = async (entry) => {
        if (
          dirtyFiles.has(entry.path) &&
          !(await confirm(
            `关闭“${entry.name}”？未保存草稿会保留，重新编辑时恢复。`,
          ))
        )
          return;
        setTabs((current) =>
          current.filter((item) => item.path !== entry.path),
        );
        if (selected?.path === entry.path) setSelected(null);
        reportDirty(entry.path, false);
      };
      const [menu, setMenu] = import_react26.default.useState(null);
      const [action, setAction] = import_react26.default.useState(null);
      const [name, setName] = import_react26.default.useState("");
      const [busy, setBusy] = import_react26.default.useState(false);
      const [loading, setLoading] = import_react26.default.useState(false);
      const [error, setError] = import_react26.default.useState("");
      const [notice, setNotice] = import_react26.default.useState("");
      const [revision, setRevision] = import_react26.default.useState(0);
      const uploadInput = import_react26.default.useRef(null);
      const uploadControl = import_react26.default.useRef(null);
      const [uploadProgress, setUploadProgress] =
        import_react26.default.useState(null);
      import_react26.default.useEffect(() => {
        const openFile = (event) => {
          if (event.detail?.workspaceId !== workspace.id) return;
          setTrashOpen(false);
          const entry = event.detail.entry;
          setTabs((current) => [
            ...current.filter((item) => item.path !== entry.path),
            entry,
          ]);
          setSelected(entry);
        };
        window.addEventListener("workagent:file-open", openFile);
        return () =>
          window.removeEventListener("workagent:file-open", openFile);
      }, [workspace.id]);
      import_react26.default.useEffect(
        () => () => uploadControl.current?.abort(),
        [],
      );
      const requests = import_react26.default.useRef(/* @__PURE__ */ new Map());
      const live = import_react26.default.useRef(true);
      const expandedRef = import_react26.default.useRef(expanded);
      expandedRef.current = expanded;
      const loadDirectory = import_react26.default.useCallback(
        async (path) => {
          requests.current.get(path)?.abort();
          const controller = new AbortController();
          requests.current.set(path, controller);
          try {
            const entries = await request(
              `${root}/files?path=${encodeURIComponent(path)}`,
              { signal: controller.signal },
            );
            if (!controller.signal.aborted)
              setTree((current) => ({ ...current, [path]: entries }));
          } catch (reason) {
            if (!controller.signal.aborted)
              setError(friendlyError(reason.message));
          } finally {
            if (requests.current.get(path) === controller)
              requests.current.delete(path);
          }
        },
        [root],
      );
      const refresh = import_react26.default.useCallback(async () => {
        setLoading(true);
        await Promise.all([...expandedRef.current].map(loadDirectory));
        if (live.current) setLoading(false);
      }, [loadDirectory]);
      import_react26.default.useEffect(() => {
        live.current = true;
        void refresh();
        const update = () => {
          void refresh();
          setRevision((value) => value + 1);
        };
        window.addEventListener(SESSIONS_CHANGED_EVENT, update);
        window.addEventListener(FILES_CHANGED_EVENT, update);
        window.addEventListener("focus", update);
        return () => {
          live.current = false;
          for (const controller of requests.current.values())
            controller.abort();
          window.removeEventListener(SESSIONS_CHANGED_EVENT, update);
          window.removeEventListener(FILES_CHANGED_EVENT, update);
          window.removeEventListener("focus", update);
        };
      }, [refresh]);
      const movement = useFileMoves({
        root,
        workspaceId: workspace.id,
        dirtyFiles,
        onError: setError,
        onCompleted: (moves) => {
          const mapped = (path) => {
            for (const move of moves)
              if (path === move.source || path.startsWith(move.source + "/"))
                return move.destination + path.slice(move.source.length);
            return path;
          };
          const entry = (row) => ({
            ...row,
            path: mapped(row.path),
            name: mapped(row.path).split("/").at(-1),
          });
          for (const controller of requests.current.values())
            controller.abort();
          setTree({});
          const next = /* @__PURE__ */ new Set([
            "",
            ...[...expandedRef.current].map(mapped),
            ...moves.map((move) => fileParent(move.destination)),
          ]);
          expandedRef.current = next;
          setExpanded(next);
          setDirectory((current) => mapped(current));
          setTabs((rows) => rows.map(entry));
          setSelected((current) => (current ? entry(current) : current));
          setRevision((value) => value + 1);
          for (const path of next) void loadDirectory(path);
          window.dispatchEvent(new Event(FILES_CHANGED_EVENT));
        },
      });
      const beginAction = (kind, entry) => {
        setMenu(null);
        if (kind === "move") {
          movement.open(entry);
          return;
        }
        setError("");
        setNotice("");
        setAction({ kind, entry });
        setName(kind === "rename" ? entry.name : "");
      };
      const mutate2 = async (event) => {
        event.preventDefault();
        if (busy) return;
        const value = name.trim();
        if (
          action.kind !== "delete" &&
          (!value ||
            /[\\/:*?"<>|]/.test(value) ||
            value === "." ||
            value === "..")
        ) {
          setError("请输入有效名称。");
          return;
        }
        setBusy(true);
        setError("");
        try {
          if (action.kind === "delete") {
            if (
              [...dirtyFiles].some(
                (path) =>
                  path === action.entry.path ||
                  path.startsWith(`${action.entry.path}/`),
              )
            )
              throw new Error("请先保存或关闭此文件中的未保存编辑，再删除。");
            await request(contentURL(workspace.id, action.entry.path), {
              method: "DELETE",
            });
          } else if (action.kind === "rename") {
            const destination = [fileParent(action.entry.path), value]
              .filter(Boolean)
              .join("/");
            await movement.submit([
              {
                source: action.entry.path,
                destination,
                fileId: action.entry.fileId,
              },
            ]);
            setAction(null);
            return;
          } else {
            const path = [directory, value].filter(Boolean).join("/");
            if (action.kind === "folder")
              await request(`${root}/directories`, {
                method: "POST",
                body: JSON.stringify({ path }),
              });
            else if (createEmptyFile)
              await createEmptyFile({ directory, name: value, path });
            else
              await request(`${contentURL(workspace.id, path)}&overwrite=0`, {
                method: "PUT",
                body: "",
                headers: { "Content-Type": "application/octet-stream" },
              });
          }
          if (!live.current) return;
          const reset =
            ["rename", "move", "delete"].includes(action.kind) &&
            action.entry.kind === "directory";
          if (reset) {
            for (const controller of requests.current.values())
              controller.abort();
            setTree({});
            expandedRef.current = /* @__PURE__ */ new Set([""]);
            setExpanded(expandedRef.current);
            setDirectory("");
          }
          if (["rename", "move", "delete"].includes(action.kind)) {
            const affected = (path) =>
              path === action.entry.path ||
              path.startsWith(`${action.entry.path}/`);
            setTabs((rows) => rows.filter((entry) => !affected(entry.path)));
            if (selected && affected(selected.path)) setSelected(null);
          }
          setAction(null);
          setNotice("已完成");
          await refresh();
        } catch (reason) {
          if (live.current) setError(friendlyError(reason.message));
        } finally {
          if (live.current) setBusy(false);
        }
      };
      const upload = async (files) => {
        if (uploadControl.current || busy || !files.length) return;
        const controller = new AbortController();
        uploadControl.current = controller;
        setBusy(true);
        setError("");
        setNotice("");
        try {
          const { completed, failures } = await uploadClient.uploadFiles(
            workspace.id,
            files,
            {
              directory,
              signal: controller.signal,
              onProgress: (progress) => {
                if (live.current) setUploadProgress(progress);
              },
            },
          );
          if (live.current) {
            setNotice(completed ? `已上传 ${completed} 个文件` : "");
            setError(failures.join("；"));
            await refresh();
          }
        } finally {
          uploadControl.current = null;
          setUploadProgress(null);
          window.dispatchEvent(new Event("workagent:files-changed"));
          if (live.current) setBusy(false);
        }
      };
      const openDirectory = (entry) => {
        setDirectory(entry.path);
        setMenu(null);
        setExpanded((current) => {
          const next = new Set(current);
          if (next.has(entry.path)) next.delete(entry.path);
          else next.add(entry.path);
          return next;
        });
        if (!tree[entry.path]) void loadDirectory(entry.path);
      };
      const renderDirectory = (path, depth = 0) =>
        (0, import_react27.createElement)(
          "ul",
          { className: "workagent-file-tree-list", key: path },
          ...(tree[path] || []).map((entry) =>
            (0, import_react27.createElement)(
              "li",
              { key: entry.path },
              (0, import_react27.createElement)(
                FileTreeRow,
                {
                  ...movement.rowProps(entry),
                  className: `${selected?.path === entry.path || directory === entry.path ? "is-selected" : ""}${movement.hover === entry.path ? " is-move-target" : ""}`,
                  depth,
                },
                movement.checkbox(entry),
                (0, import_react27.createElement)(
                  "button",
                  {
                    type: "button",
                    className: "workagent-file-tree-name",
                    title: entry.path,
                    "aria-expanded":
                      entry.kind === "directory"
                        ? expanded.has(entry.path)
                        : void 0,
                    onClick: () => {
                      if (entry.kind === "directory") openDirectory(entry);
                      else {
                        setTabs((current) =>
                          current.some((item) => item.path === entry.path)
                            ? current
                            : [...current, entry],
                        );
                        setSelected(entry);
                        setDirectory(fileParent(entry.path));
                        setMenu(null);
                      }
                    },
                  },
                  (0, import_react27.createElement)(Icon, {
                    name:
                      entry.kind === "directory"
                        ? expanded.has(entry.path)
                          ? "chevronDown"
                          : "chevronRight"
                        : "file",
                    size: 16,
                  }),
                  (0, import_react27.createElement)("span", null, entry.name),
                ),
                entry.kind === "file"
                  ? (0, import_react27.createElement)(
                      "small",
                      null,
                      fileSize(entry.size),
                    )
                  : null,
                (0, import_react27.createElement)(FileIconButton, {
                  name: "more",
                  label: `操作 ${entry.name}`,
                  "aria-expanded": menu?.path === entry.path,
                  onClick: () =>
                    setMenu(menu?.path === entry.path ? null : entry),
                }),
              ),
              menu?.path === entry.path
                ? (0, import_react27.createElement)(
                    "div",
                    {
                      className: "workagent-file-row-menu",
                      "aria-label": `${entry.name} 的操作`,
                    },
                    entry.kind === "file"
                      ? (0, import_react27.createElement)(
                          "a",
                          {
                            href: contentURL(workspace.id, entry.path),
                            download: entry.name,
                          },
                          "下载",
                        )
                      : null,
                    (0, import_react27.createElement)(
                      "button",
                      {
                        type: "button",
                        onClick: () => beginAction("rename", entry),
                      },
                      "重命名",
                    ),
                    (0, import_react27.createElement)(
                      "button",
                      {
                        type: "button",
                        onClick: () => beginAction("move", entry),
                      },
                      "移动到…",
                    ),
                    (0, import_react27.createElement)(
                      "button",
                      {
                        type: "button",
                        onClick: () => beginAction("delete", entry),
                      },
                      "删除",
                    ),
                  )
                : null,
              entry.kind === "directory" && expanded.has(entry.path)
                ? tree[entry.path]
                  ? tree[entry.path].length
                    ? renderDirectory(entry.path, depth + 1)
                    : (0, import_react27.createElement)(
                        "p",
                        { className: "workagent-file-tree-empty" },
                        "空文件夹",
                      )
                  : (0, import_react27.createElement)(
                      "p",
                      { className: "workagent-file-tree-empty" },
                      "正在加载…",
                    )
                : null,
            ),
          ),
        );
      const actionLabel =
        action &&
        {
          file: "新建文件",
          folder: "新建文件夹",
          rename: "重命名文件",
          delete: "删除文件",
        }[action.kind];
      const leaveTrash = () => {
        setTrashOpen(false);
        void refresh();
      };
      return (0, import_react27.createElement)(
        "div",
        {
          className: `workagent-file-manager${selected && !trashOpen ? " has-preview" : ""}`,
          onDragEnter: (event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.stopPropagation();
          },
          onDragOver: (event) => {
            if (!event.dataTransfer.types.includes("Files")) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = busy || trashOpen ? "none" : "copy";
          },
          onDrop: (event) => {
            if (!event.dataTransfer.files.length) return;
            event.preventDefault();
            event.stopPropagation();
            if (!trashOpen) void upload([...event.dataTransfer.files]);
          },
        },
        confirmation,
        (0, import_react27.createElement)(
          "div",
          {
            className: "workagent-file-manager-content",
            hidden: !!selected && !trashOpen,
          },
          uploadProgress
            ? (0, import_react27.createElement)(
                "div",
                { className: "workagent-upload-progress" },
                uploadProgress.name,
                (0, import_react27.createElement)("progress", {
                  max: uploadProgress.size || 1,
                  value: uploadProgress.bytes,
                }),
                (0, import_react27.createElement)(
                  Button,
                  { onClick: () => uploadControl.current?.abort() },
                  "暂停上传",
                ),
              )
            : null,
          (0, import_react27.createElement)(
            "div",
            { className: "workagent-file-toolbar" },
            trashOpen
              ? (0, import_react27.createElement)(FileIconButton, {
                  name: "back",
                  label: "返回项目文件",
                  disabled: trash.busy,
                  onClick: leaveTrash,
                })
              : (0, import_react27.createElement)(
                  import_react26.default.Fragment,
                  null,
                  (0, import_react27.createElement)(FileIconButton, {
                    name: "upload",
                    label: "上传文件",
                    title: `上传文件 · 单个最大 ${UPLOAD_SIZE_LABEL}，也可拖入文件`,
                    disabled: busy,
                    onClick: () => uploadInput.current.click(),
                  }),
                  (0, import_react27.createElement)(FileIconButton, {
                    name: "file",
                    label: "新建文件",
                    disabled: busy,
                    onClick: () => beginAction("file"),
                  }),
                  (0, import_react27.createElement)(FileIconButton, {
                    name: "plus",
                    label: "新建文件夹",
                    disabled: busy,
                    onClick: () => beginAction("folder"),
                  }),
                  trashRoot
                    ? (0, import_react27.createElement)(FileIconButton, {
                        name: "trash",
                        label: "打开项目回收站",
                        disabled: busy,
                        onClick: () => {
                          setAction(null);
                          setMenu(null);
                          setTrashOpen(true);
                        },
                      })
                    : null,
                ),
            (0, import_react27.createElement)(
              "span",
              null,
              (trashOpen ? trash.busy : busy) ? "正在处理…" : "",
            ),
            (0, import_react27.createElement)(FileIconButton, {
              name: "refresh",
              label: trashOpen ? "刷新回收站" : "刷新文件",
              disabled: trashOpen ? trash.loading || trash.busy : loading,
              onClick: () => {
                if (trashOpen) {
                  void trash.refresh();
                  return;
                }
                setError("");
                void refresh();
                setRevision((value) => value + 1);
              },
            }),
            (0, import_react27.createElement)("input", {
              ref: uploadInput,
              hidden: true,
              type: "file",
              multiple: true,
              "aria-label": "选择上传文件",
              onChange: (event) => {
                const files = [...event.target.files];
                event.target.value = "";
                void upload(files);
              },
            }),
          ),
          !trashOpen
            ? (0, import_react27.createElement)(uploadClient.Panel, {
                workspaceId: workspace.id,
                onChanged: refresh,
              })
            : null,
          (0, import_react27.createElement)(
            "nav",
            {
              className: "workagent-file-breadcrumb",
              "aria-label": "当前文件目录",
            },
            (0, import_react27.createElement)(
              "button",
              {
                type: "button",
                onClick: trashOpen ? leaveTrash : () => setDirectory(""),
                disabled: trashOpen && trash.busy,
                ...(!trashOpen ? movement.destinationProps("") : {}),
                className:
                  !trashOpen && movement.hover === "" ? "is-move-target" : "",
              },
              trashOpen ? "项目文件" : "根目录",
            ),
            trashOpen
              ? (0, import_react27.createElement)(
                  "span",
                  { "aria-current": "page" },
                  " / 回收站",
                )
              : null,
            ...(trashOpen ? "" : directory)
              .split("/")
              .filter(Boolean)
              .map((part, index, parts) =>
                (0, import_react27.createElement)(
                  "button",
                  {
                    key: index,
                    type: "button",
                    onClick: () =>
                      setDirectory(parts.slice(0, index + 1).join("/")),
                  },
                  " / ",
                  part,
                ),
              ),
          ),
          !trashOpen && error
            ? (0, import_react27.createElement)(
                "p",
                { role: "alert", className: "workagent-file-notice is-error" },
                error,
              )
            : null,
          !trashOpen && notice
            ? (0, import_react27.createElement)(
                "p",
                { role: "status", className: "workagent-file-notice" },
                notice,
              )
            : null,
          !trashOpen ? movement.controls : null,
          !trashOpen && action
            ? (0, import_react27.createElement)(
                "form",
                {
                  className: "workagent-file-action-form",
                  onSubmit: mutate2,
                  "aria-label": actionLabel,
                },
                (0, import_react27.createElement)("strong", null, actionLabel),
                action.kind === "delete"
                  ? (0, import_react27.createElement)(
                      "p",
                      null,
                      `确认删除“${action.entry.name}”${action.entry.kind === "directory" ? "及其内容" : ""}？`,
                      trashRoot
                        ? "文件将移入项目回收站，最多保留 7 天；共享空间不足时将按删除时间从早到晚清理。"
                        : "",
                    )
                  : (0, import_react27.createElement)(Input, {
                      autoFocus: true,
                      "aria-label": "文件名",
                      placeholder: "输入名称",
                      value: name,
                      onChange: (event) => setName(event.target.value),
                      required: true,
                    }),
                (0, import_react27.createElement)(
                  "div",
                  null,
                  (0, import_react27.createElement)(
                    Button,
                    { disabled: busy, onClick: () => setAction(null) },
                    "取消",
                  ),
                  (0, import_react27.createElement)(
                    Button,
                    { type: "submit", disabled: busy },
                    busy
                      ? "处理中…"
                      : action.kind === "delete"
                        ? "确认删除"
                        : "保存",
                  ),
                ),
              )
            : null,
          trashOpen
            ? trash.content
            : (0, import_react27.createElement)(
                "div",
                {
                  className: "workagent-file-tree",
                  "aria-label": "项目文件树",
                },
                tree[""]
                  ? tree[""].length
                    ? renderDirectory("")
                    : (0, import_react27.createElement)(
                        "div",
                        { className: "workagent-file-panel-empty" },
                        (0, import_react27.createElement)(Icon, {
                          name: "workspace",
                          size: 32,
                        }),
                        (0, import_react27.createElement)(
                          "strong",
                          null,
                          "此项目还没有文件",
                        ),
                        (0, import_react27.createElement)(
                          "p",
                          null,
                          "拖入文件，或让助手在项目中创建文件。",
                        ),
                      )
                  : (0, import_react27.createElement)(
                      "p",
                      { role: "status" },
                      "正在加载文件…",
                    ),
              ),
        ),
        tabs.length && !trashOpen
          ? (0, import_react27.createElement)(
              "nav",
              { className: "workagent-file-tabs", "aria-label": "已打开文件" },
              ...tabs.map((entry) =>
                (0, import_react27.createElement)(
                  "span",
                  { key: entry.path },
                  (0, import_react27.createElement)(
                    "button",
                    {
                      type: "button",
                      "aria-label": `切换文件 ${entry.name}`,
                      "aria-pressed": selected?.path === entry.path,
                      onClick: () => setSelected(entry),
                      title: entry.path,
                    },
                    `${entry.name}${dirtyFiles.has(entry.path) ? " •" : ""}`,
                  ),
                  (0, import_react27.createElement)(
                    "button",
                    {
                      type: "button",
                      "aria-label": `关闭文件 ${entry.name}`,
                      onClick: () => closeTab(entry),
                    },
                    "×",
                  ),
                ),
              ),
            )
          : null,
        ...tabs.map((entry) =>
          (0, import_react27.createElement)(
            "div",
            {
              key: entry.path,
              hidden: trashOpen || selected?.path !== entry.path,
              className: "workagent-file-tab-content",
            },
            (0, import_react27.createElement)(WorkspaceFilePreview, {
              workspace,
              entry,
              active: !trashOpen && selected?.path === entry.path,
              revision,
              onDirty: reportDirty,
              onClose: () => setSelected(null),
              onDismiss,
              dismissLabel,
              contentURL,
              resolveOfficePreview,
              editable,
            }),
          ),
        ),
      );
    }

    // src/features/collaboration/page.js
    var import_react28 = __toESM(require("react"), 1);
    var SharedPage = createShared({
      React: import_react28.default,
      ComposerForm,
      closeMobileSidebar: closeMobileSidebar2,
      usePins: workbench.usePins,
      navigation,
      Icon,
      EngineMark,
      SessionAvatar,
      createUploads,
      request,
      apiRoot,
      useResource,
      Section,
      Button,
      Input,
      Select,
      Markdown,
      friendlyError,
      FileManager: WorkspaceFileManager,
      SessionReminder: workbench.SessionReminder,
      closeSidebar: closeSidebar2,
    });

    // src/ui/resize.js
    var import_react29 = __toESM(require("react"), 1);
    var import_react30 = require("react");
    function ResizeHandle({
      orientation,
      value,
      onChange,
      measure,
      label,
      min,
      max,
      className = "workagent-file-resizer",
    }) {
      const start = import_react29.default.useRef(null);
      const vertical = orientation === "vertical";
      const finish = () => {
        start.current = null;
        document.body.classList.remove("workagent-resizing");
      };
      import_react29.default.useEffect(
        () => () => {
          if (start.current) finish();
        },
        [],
      );
      const releasePointer = (event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      };
      return (0, import_react30.createElement)("div", {
        className: `${className} ${vertical ? "is-vertical" : "is-horizontal"}`,
        role: "separator",
        tabIndex: 0,
        "aria-orientation": orientation,
        "aria-label": label || (vertical ? "调整文件栏宽度" : "调整预览区高度"),
        "aria-valuenow": Math.round(value),
        "aria-valuemin": min,
        "aria-valuemax": max,
        onPointerDown: (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          start.current = measure(event);
          event.currentTarget.setPointerCapture(event.pointerId);
          document.body.classList.add("workagent-resizing");
        },
        onPointerMove: (event) => {
          if (start.current) onChange(start.current(event));
        },
        onLostPointerCapture: finish,
        onPointerUp: releasePointer,
        onPointerCancel: releasePointer,
        onKeyDown: (event) => {
          const direction = {
            ArrowLeft: 1,
            ArrowRight: -1,
            ArrowUp: -1,
            ArrowDown: 1,
          }[event.key];
          if (
            direction &&
            (vertical
              ? event.key === "ArrowLeft" || event.key === "ArrowRight"
              : event.key === "ArrowUp" || event.key === "ArrowDown")
          ) {
            event.preventDefault();
            onChange(value + direction * (vertical ? 24 : 5));
          }
        },
      });
    }

    // src/features/conversations/scroll.js
    function trackConversationScroll(list, sidebar, cache2, sessionId2, side) {
      const media = window.matchMedia("(max-width: 760px)");
      const inDocument = () => media.matches && !side;
      const drawerOpen = () => sidebar.isOpen();
      let wasOpen = drawerOpen();
      let position = cache2.get(sessionId2, "scroll") ?? 0;
      const save = (value) => {
        position = value;
        cache2.set(sessionId2, "scroll", value);
      };
      const restore = () => {
        if (inDocument()) window.scrollTo(0, drawerOpen() ? 0 : position);
        else {
          if (!side && window.scrollY) window.scrollTo(0, 0);
          list.scrollTop = position;
        }
      };
      const onDocumentScroll = () => {
        if (inDocument() && !drawerOpen()) save(window.scrollY);
      };
      const onListScroll = () => {
        if (!inDocument()) save(list.scrollTop);
      };
      const unsubscribeSidebar = sidebar.subscribe(() => {
        const open = drawerOpen();
        if (open === wasOpen) return;
        wasOpen = open;
        if (inDocument()) restore();
      });
      window.addEventListener("scroll", onDocumentScroll, { passive: true });
      list.addEventListener("scroll", onListScroll, { passive: true });
      media.addEventListener("change", restore);
      restore();
      return () => {
        unsubscribeSidebar();
        window.removeEventListener("scroll", onDocumentScroll);
        list.removeEventListener("scroll", onListScroll);
        media.removeEventListener("change", restore);
        if (inDocument()) window.scrollTo(0, 0);
      };
    }

    // src/features/conversations/resources.js
    var sessionId = (endpoint2) => endpoint2.split("/")[5];
    var cache = {
      get: (endpoint2) =>
        conversationCache.get(sessionId(endpoint2), endpoint2),
      set: (endpoint2, value) =>
        conversationCache.set(sessionId(endpoint2), endpoint2, value),
      remove: (endpoint2) => conversationCache.remove(sessionId(endpoint2)),
    };
    function useSessionResource(endpoint2, select) {
      return useResource(endpoint2, select, endpoint2 ? cache : void 0);
    }

    // src/ui/message-actions.js
    var import_react31 = __toESM(require("react"), 1);
    var import_react32 = require("react");
    async function copyMessageText(text) {
      if (navigator.clipboard && window.isSecureContext)
        return navigator.clipboard.writeText(text);
      const field = document.createElement("textarea");
      field.value = text;
      field.style.cssText = "position:fixed;left:-9999px;top:0";
      const focused = document.activeElement;
      document.body.append(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      focused?.focus();
      if (!copied) throw new Error("复制失败，请重试");
    }
    function MessageActions({ message, disabled, onEdit, onFork }) {
      const [copyState, setCopyState] = import_react31.default.useState("");
      import_react31.default.useEffect(() => {
        if (!copyState) return;
        const timer = setTimeout(() => setCopyState(""), 2e3);
        return () => clearTimeout(timer);
      }, [copyState]);
      const action = (name, icon, onClick, unavailable = false) =>
        (0, import_react32.createElement)(
          Button,
          {
            className: "workagent-button workagent-message-action",
            disabled: unavailable,
            "aria-label": name,
            "data-tooltip": name,
            onClick,
          },
          (0, import_react32.createElement)(Icon, { name: icon, size: 16 }),
        );
      return (0, import_react32.createElement)(
        "footer",
        { className: "workagent-message-actions" },
        onEdit ? action("编辑", "edit", onEdit, disabled) : null,
        onFork ? action("分支", "branch", onFork, disabled) : null,
        action(
          copyState || "复制",
          copyState === "已复制" ? "check" : "copy",
          async () => {
            try {
              await copyMessageText(message.text);
              setCopyState("已复制");
            } catch {
              setCopyState("复制失败，请重试");
            }
          },
        ),
        (0, import_react32.createElement)(
          "span",
          { className: "workagent-sr-only", role: "status" },
          copyState,
        ),
      );
    }

    // src/features/conversations/page.js
    var import_react33 = __toESM(require("react"), 1);
    var import_react34 = require("react");
    function ConversationMessageTarget({ sessionId: sessionId2 }) {
      const routeSearch = navigation.useSearch();
      const locateMessage = import_react33.default.useCallback((messageId) => {
        const escaped = globalThis.CSS?.escape
          ? globalThis.CSS.escape(messageId)
          : messageId.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
        let target = document.querySelector(
          `[data-message-id="${escaped}"], #message-${escaped}`,
        );
        if (!target) return false;
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("workagent-message-highlight");
        globalThis.setTimeout(
          () => target.classList.remove("workagent-message-highlight"),
          3e3,
        );
        return true;
      }, []);
      import_react33.default.useEffect(() => {
        const messageId = new URLSearchParams(routeSearch).get("message");
        if (!messageId) return;
        let attempts = 0;
        const timer = globalThis.setInterval(() => {
          attempts += 1;
          if (locateMessage(messageId) || attempts >= 40)
            globalThis.clearInterval(timer);
        }, 100);
        return () => globalThis.clearInterval(timer);
      }, [sessionId2, routeSearch, locateMessage]);
      return null;
    }
    function RuntimeConversation({
      sessionId: sessionId2,
      side = false,
      onSideChat,
      sideHeader,
    }) {
      const busyEnter = useBusyEnter();
      const submitGesture = import_react33.default.useRef(false);
      const routeParams = new URLSearchParams(navigation.useSearch());
      const id = encodeURIComponent(sessionId2);
      const [sessionState] = useSessionResource(`${apiRoot}/sessions/${id}`);
      const ctx = import_react33.default.useContext(RuntimeServices);
      const standard = hasStandardSessions(ctx);
      const native =
        standard && ["codex", "kimi"].includes(sessionState.rows[0]?.engine);
      const legacy = !standard || sessionState.rows[0]?.engine === "harness";
      const nativeState = useNativeConversation(ctx, sessionId2, native);
      const [legacyQueueState, reloadQueue] = useSessionResource(
        legacy ? `${apiRoot}/sessions/${id}/queue` : null,
      );
      const [legacyMessageState, reloadMessages] = useSessionResource(
        legacy ? `${apiRoot}/sessions/${id}/messages` : null,
      );
      const messageState = native
        ? {
            loading: nativeState.loading,
            rows: nativeState.value?.messages ?? [],
          }
        : legacyMessageState;
      const messageList = import_react33.default.useRef(null);
      import_react33.default.useLayoutEffect(() => {
        if (messageState.loading) return;
        const list = messageList.current;
        if (!list) return;
        return trackConversationScroll(
          list,
          sidebarState(),
          conversationCache,
          sessionId2,
          side,
        );
      }, [sessionId2, messageState.loading, side]);
      const queueState = native
        ? { rows: nativeState.value?.metadata?.queue ?? [] }
        : legacyQueueState;
      const receipts = messageDelivery.useRows(sessionId2);
      const scrollReceipt = import_react33.default.useRef(null);
      const knownIds = /* @__PURE__ */ new Set([
        ...messageState.rows.map((row) => row.id),
        ...queueState.rows.map((row) => row.messageId),
      ]);
      const pending = receipts.filter((row) => !knownIds.has(row.id));
      const visibleMessages = [
        ...messageState.rows,
        ...pending.filter((row) => !row.queued),
      ];
      const visibleQueue = [
        ...queueState.rows,
        ...pending
          .filter((row) => row.queued)
          .map((row) => ({ ...row, messageId: row.id, content: row.text })),
      ];
      import_react33.default.useEffect(() => {
        messageDelivery.reconcile(
          sessionId2,
          messageState.rows,
          queueState.rows,
        );
      }, [sessionId2, messageState.rows, queueState.rows, receipts]);
      import_react33.default.useLayoutEffect(() => {
        if (!scrollReceipt.current) return;
        const target = messageList.current?.querySelector(
          `[data-message-id="${scrollReceipt.current}"]`,
        );
        if (target) {
          target.scrollIntoView({ block: "nearest" });
          scrollReceipt.current = null;
        }
      }, [receipts]);
      const [input, setInput] = workbench.useDraft(
        sessionId2,
        sessionState.rows[0]?.id === sessionId2,
      );
      const historyCursor = import_react33.default.useRef({
        index: -1,
        saved: "",
      });
      const retryDraft = import_react33.default.useRef(null);
      const currentInput = import_react33.default.useRef(input);
      currentInput.current = input;
      const [draft, setDraft] = import_react33.default.useState("");
      const [busy, setBusy] = import_react33.default.useState(false);
      const [progress, setProgress] = import_react33.default.useState("");
      const [error, setError] = import_react33.default.useState("");
      const [submitting, setSubmitting] =
        import_react33.default.useState(false);
      const [forkTarget, setForkTarget] = import_react33.default.useState(null);
      const [attachmentsBusy, setAttachmentsBusy] =
        import_react33.default.useState(false);
      const [editing, setEditing] = import_react33.default.useState(null);
      const [editContent, setEditContent] = import_react33.default.useState("");
      const session = native
        ? { ...sessionState.rows[0], ...nativeState.value?.metadata }
        : sessionState.rows[0];
      const activityRevision = import_react33.default.useRef(0);
      import_react33.default.useEffect(() => {
        if (!native) return;
        const value = nativeState.value;
        if (value) {
          setBusy(value.activity.state !== "idle");
          setDraft(value.draft || "");
          setProgress(
            value.activity.state === "retrying"
              ? "模型服务暂不可用，正在自动重试…"
              : value.activeTool
                ? "正在执行工具…"
                : value.progress || "",
          );
          if (value.activity.message)
            setError(friendlyError(value.activity.message));
          else if (value.lastEvent?.type === "turn.started") setError("");
          if (
            [
              "turn.started",
              "turn.retrying",
              "turn.completed",
              "turn.failed",
              "turn.cancelled",
              "session.metadata",
            ].includes(value.lastEvent?.type)
          )
            window.dispatchEvent(new window.Event(SESSIONS_CHANGED_EVENT));
        }
        if (nativeState.error) setError(friendlyError(nativeState.error));
      }, [native, nativeState.value, nativeState.error]);
      const syncActivity = import_react33.default.useCallback(async () => {
        if (native) return nativeState.reload();
        if (!legacy) return;
        const revision = activityRevision.current;
        try {
          const current = await request(`${apiRoot}/sessions/${id}`);
          if (revision !== activityRevision.current || !current.activity)
            return;
          void reloadQueue();
          const active = current.activity.state !== "idle";
          setBusy(active);
          setProgress(
            current.activity.state === "retrying"
              ? "模型服务暂不可用，正在自动重试…"
              : "",
          );
          if (!active) {
            setDraft("");
            if (current.activity.message)
              setError(friendlyError(current.activity.message));
            void reloadMessages();
          }
        } catch {
          setProgress("连接中断，正在重新连接…");
        }
      }, [id, reloadMessages, native, legacy, nativeState.reload]);
      import_react33.default.useEffect(() => {
        if (!busy || !legacy) return;
        const timer = setInterval(() => void syncActivity(), 5e3);
        return () => clearInterval(timer);
      }, [busy, syncActivity, legacy]);
      import_react33.default.useEffect(() => {
        if (!legacy || typeof EventSource === "undefined") return void 0;
        const stream = new EventSource(`${apiRoot}/sessions/${id}/events`);
        stream.onopen = () => void syncActivity();
        stream.onmessage = (event) => {
          let value;
          try {
            value = JSON.parse(event.data);
          } catch {
            return;
          }
          activityRevision.current += 1;
          if (
            [
              "turn.started",
              "turn.retrying",
              "turn.completed",
              "turn.failed",
              "turn.cancelled",
            ].includes(value.type)
          )
            window.dispatchEvent(new window.Event(SESSIONS_CHANGED_EVENT));
          if (value.type === "turn.started") {
            setBusy(true);
            setProgress("");
            setError("");
          }
          if (value.type === "turn.retrying") {
            setBusy(true);
            setProgress(
              /high demand|overloaded/i.test(value.message || "")
                ? "模型服务繁忙，正在自动重试…"
                : "模型连接暂时中断，正在自动重试…",
            );
          }
          if (value.type === "assistant.delta") {
            setProgress("");
            setDraft((current) => current + (value.delta || ""));
          }
          if (value.type === "tool.started") setProgress("正在执行工具…");
          if (value.type === "tool.completed") setProgress("");
          if (value.type === "assistant.completed") {
            setDraft("");
            void reloadMessages();
          }
          if (value.type === "queue.changed") void reloadQueue();
          if (value.type === "message.created") void reloadMessages();
          if (value.type === "turn.completed") {
            setBusy(false);
            setDraft("");
            setProgress("");
            void reloadMessages();
          }
          if (value.type === "turn.failed") {
            setBusy(false);
            setDraft("");
            setError(friendlyError(value.message));
            void reloadMessages();
          }
          if (value.type === "turn.cancelled") {
            setBusy(false);
            setDraft("");
          }
        };
        stream.onerror = () => {
          setProgress("连接中断，正在重新连接…");
          void syncActivity();
        };
        return () => stream.close();
      }, [id, legacy]);
      const [questionReplies, setQuestionReplies] =
        import_react33.default.useState({
          sessionId: sessionId2,
          rows: [],
        });
      const questionMessages = [
        ...visibleMessages,
        ...(questionReplies.sessionId === sessionId2
          ? questionReplies.rows
          : []
        ).filter(
          (row) => !visibleMessages.some((message) => message.id === row.id),
        ),
      ];
      const answerQuestion = async (question, content) => {
        setSubmitting(true);
        try {
          const { message } = await request(
            `${apiRoot}/sessions/${id}/question-reply`,
            {
              method: "POST",
              body: JSON.stringify({ questionId: question.id, content }),
            },
          );
          setQuestionReplies((current) => ({
            sessionId: sessionId2,
            rows: [
              ...(current.sessionId === sessionId2 ? current.rows : []).filter(
                (row) => row.id !== message.id,
              ),
              message,
            ],
          }));
          if (native) void nativeState.reload().catch(() => {});
          else void reloadMessages();
        } finally {
          setSubmitting(false);
        }
      };
      const send = async (event, questionReply, retry) => {
        event.preventDefault();
        const accelerated = submitGesture.current;
        submitGesture.current = false;
        const content = retry?.text ?? questionReply ?? input.trim();
        if (!content || submitting || attachmentsBusy) return;
        if (!questionReply && !side && /^\/?btw(?:\s|$)/i.test(content)) {
          setSubmitting(true);
          try {
            await onSideChat(content.replace(/^\/?btw\s*/i, ""));
            setInput("");
          } catch (cause) {
            setError(friendlyError(cause.message));
          } finally {
            setSubmitting(false);
          }
          return;
        }
        const behavior = accelerated
          ? busyEnter === "queue"
            ? "steer"
            : "queue"
          : busyEnter;
        const queued = busy && !questionReply && behavior === "queue";
        const steering = busy && !queued;
        const receipt =
          retry ??
          (retryDraft.current?.text === content ? retryDraft.current : null);
        const messageId = receipt?.id ?? `message-ui-${crypto.randomUUID()}`;
        const row = {
          id: messageId,
          sessionId: sessionId2,
          role: "user",
          text: content,
          createdAt:
            receipt?.createdAt ?? /* @__PURE__ */ new Date().toISOString(),
          queued,
          status: "sending",
          error: "",
        };
        scrollReceipt.current = messageId;
        messageDelivery.update(sessionId2, row);
        retryDraft.current = null;
        setSubmitting(true);
        activityRevision.current += 1;
        setBusy(true);
        setProgress("");
        if (!busy) setDraft("");
        setError("");
        if (!questionReply && (!retry || currentInput.current === content))
          setInput("");
        try {
          if (native)
            await nativeSessionAction(
              ctx,
              sessionId2,
              "prompt",
              [{ type: "text", text: content }],
              steering ? "steer" : "queue",
              messageId,
            );
          else
            await request(
              `${apiRoot}/sessions/${id}/${queued ? "queue" : steering ? "steer" : "turns"}`,
              {
                method: "POST",
                body: JSON.stringify({
                  content,
                  messageId,
                }),
              },
            );
          messageDelivery.update(sessionId2, {
            ...row,
            status: queued ? "queued" : "sent",
          });
          if (native) await nativeState.reload();
          else await Promise.all([reloadMessages(), reloadQueue()]);
        } catch (cause) {
          messageDelivery.update(sessionId2, {
            ...row,
            status: "failed",
            error: friendlyError(cause.message),
          });
          if (!questionReply && !currentInput.current) {
            retryDraft.current = row;
            setInput(content);
          }
          if (!busy) setBusy(false);
          setError("");
          void syncActivity();
          if (questionReply) throw cause;
        } finally {
          setSubmitting(false);
        }
      };
      const updateQueue = async (messageId, action) => {
        if (submitting) return;
        setSubmitting(true);
        setError("");
        try {
          if (native && action !== "send")
            await nativeSessionAction(
              ctx,
              sessionId2,
              "updateQueue",
              messageId,
              {
                kind: action,
              },
            );
          else
            await request(`${apiRoot}/sessions/${id}/queue`, {
              method: "POST",
              body: JSON.stringify({ messageId, action }),
            });
          if (native) await nativeState.reload();
          else {
            void reloadMessages();
            void syncActivity();
          }
        } catch (cause) {
          setError(friendlyError(cause.message));
        } finally {
          void reloadQueue();
          setSubmitting(false);
        }
      };
      const fork = async (messageId, replacementContent, confirmed = false) => {
        if (!confirmed && window.matchMedia("(max-width: 760px)").matches) {
          setForkTarget({ messageId, replacementContent });
          return;
        }
        if (submitting) return;
        setSubmitting(true);
        setError("");
        try {
          const branch = await request(`${apiRoot}/sessions/${id}/fork`, {
            method: "POST",
            body: JSON.stringify({ messageId, replacementContent }),
          });
          navigation.navigate(
            `/?frontend=dsh&session=${encodeURIComponent(branch.id)}`,
          );
        } catch (cause) {
          setError(friendlyError(cause.message));
        } finally {
          setSubmitting(false);
        }
      };
      const cancel = async () => {
        try {
          if (native) await nativeSessionAction(ctx, sessionId2, "cancel");
          else
            await request(`${apiRoot}/sessions/${id}/cancel`, {
              method: "POST",
            });
          activityRevision.current += 1;
          setProgress("正在停止…");
          void syncActivity();
        } catch (cause) {
          setError(friendlyError(cause.message));
        }
      };
      const staleSharedTask =
        !side &&
        routeParams.get("workagent") === "shared" &&
        routeParams.get("session") === sessionId2 &&
        !sessionState.loading &&
        Boolean(sessionState.error) &&
        !sessionState.rows.length;
      return (0, import_react34.createElement)(
        "section",
        { className: `workagent-conversation${side ? " is-side-chat" : ""}` },
        forkTarget
          ? (0, import_react34.createElement)(
              Dialog,
              {
                title: "从这里创建分支？",
                onClose: () => setForkTarget(null),
              },
              (0, import_react34.createElement)(
                "div",
                { className: "workagent-fork-content" },
                (0, import_react34.createElement)(Icon, {
                  name: "branch",
                  size: 28,
                }),
                (0, import_react34.createElement)(
                  "p",
                  null,
                  "将保留到这条消息为止的上下文，在新对话中继续探索。当前对话会保留。",
                ),
                (0, import_react34.createElement)(
                  "div",
                  { className: "workagent-actions" },
                  (0, import_react34.createElement)(
                    Button,
                    { autoFocus: true, onClick: () => setForkTarget(null) },
                    "继续当前对话",
                  ),
                  (0, import_react34.createElement)(
                    Button,
                    {
                      className: "workagent-button is-primary",
                      onClick: () => {
                        const target = forkTarget;
                        setForkTarget(null);
                        void fork(
                          target.messageId,
                          target.replacementContent,
                          true,
                        );
                      },
                    },
                    "创建分支",
                  ),
                ),
              ),
            )
          : null,
        side
          ? sideHeader
          : (0, import_react34.createElement)(
              "header",
              { className: "workagent-conversation-title" },
              session
                ? (0, import_react34.createElement)(SessionAvatar, { session })
                : null,
              (0, import_react34.createElement)(
                "div",
                null,
                (0, import_react34.createElement)(
                  "strong",
                  null,
                  session
                    ? session.workspaceId?.startsWith("shared:")
                      ? (0, import_react34.createElement)(PersonalTaskTitle, {
                          session,
                        })
                      : displaySessionTitle(session.title)
                    : "正在加载会话…",
                ),
                session
                  ? (0, import_react34.createElement)(
                      "span",
                      null,
                      `${displayPresetName(session.preset?.resolvedSnapshot?.name || session.preset?.presetId || session.engine)} · 当前会话`,
                    )
                  : null,
              ),
            ),
        staleSharedTask
          ? (0, import_react34.createElement)(StalePersonalTask, {
              sessionId: sessionId2,
            })
          : null,
        (0, import_react34.createElement)(
          "div",
          {
            className: "workagent-message-list",
            "aria-live": "polite",
            ref: messageList,
          },
          (0, import_react34.createElement)(ConversationMessageTarget, {
            sessionId: sessionId2,
          }),
          messageState.loading
            ? (0, import_react34.createElement)(
                "p",
                { className: "workagent-muted" },
                "正在加载消息…",
              )
            : visibleMessages.length === 0 && !visibleQueue.length && !draft
              ? (0, import_react34.createElement)(
                  "div",
                  { className: "workagent-conversation-empty" },
                  side
                    ? (0, import_react34.createElement)(
                        "div",
                        { className: "workagent-side-empty-icon" },
                        (0, import_react34.createElement)(Icon, {
                          name: "chatgpt",
                          size: 24,
                        }),
                      )
                    : null,
                  (0, import_react34.createElement)(
                    "strong",
                    null,
                    side ? "顺便问一句" : "从这里继续对话",
                  ),
                  (0, import_react34.createElement)(
                    "span",
                    null,
                    side
                      ? "另开一个话题，和主对话分开记录。"
                      : "消息和回复会保存在当前对话中。",
                  ),
                )
              : null,
          ...questionMessages.map((message) =>
            message.role === "assistant" && message.kind === "question"
              ? (0, import_react34.createElement)(
                  workbench.Question,
                  {
                    key: message.id,
                    id: message.id,
                    sessionId: sessionId2,
                    answered: questionMessages.some(
                      (row) =>
                        row.role === "user" && row.replyTo?.id === message.id,
                    ),
                    disabled: submitting || attachmentsBusy,
                    onReply: (content) => answerQuestion(message, content),
                  },
                  (0, import_react34.createElement)(
                    Markdown,
                    { workspaceId: session?.workspaceId },
                    message.text,
                  ),
                  (0, import_react34.createElement)(MessageActions, {
                    message,
                    disabled: submitting,
                  }),
                )
              : (0, import_react34.createElement)(
                  "article",
                  {
                    key: message.id,
                    className: `workagent-message is-${message.role}`,
                    "data-message-id": message.id,
                  },
                  message.role === "assistant"
                    ? (0, import_react34.createElement)(SessionAvatar, {
                        session,
                      })
                    : null,
                  message.replyTo
                    ? (0, import_react34.createElement)(
                        "button",
                        {
                          type: "button",
                          className: "workagent-reply-reference",
                          title: message.replyTo.text,
                          onClick: () => {
                            const target = document.getElementById(
                              `workagent-question-${message.replyTo.id}`,
                            );
                            if (!target) return;
                            const details = target.querySelector("details");
                            if (details) details.open = true;
                            target.scrollIntoView({
                              block: "nearest",
                              behavior: "smooth",
                            });
                          },
                        },
                        `↩ 回复补充问题 · ${message.replyTo.text}`,
                      )
                    : null,
                  (0, import_react34.createElement)(
                    Markdown,
                    { workspaceId: session?.workspaceId },
                    message.text,
                  ),
                  message.status
                    ? (0, import_react34.createElement)(
                        "footer",
                        {
                          className: "workagent-message-delivery",
                          role: message.status === "failed" ? "alert" : void 0,
                          "data-delivery-status": message.status,
                        },
                        message.status === "sending"
                          ? "发送中…"
                          : message.status === "failed"
                            ? "发送失败"
                            : null,
                        message.status === "failed"
                          ? (0, import_react34.createElement)(
                              import_react33.default.Fragment,
                              null,
                              (0, import_react34.createElement)(
                                "span",
                                null,
                                message.error,
                              ),
                              (0, import_react34.createElement)(
                                Button,
                                {
                                  disabled: submitting,
                                  onClick: (event) =>
                                    send(event, void 0, message),
                                },
                                "重试发送",
                              ),
                            )
                          : null,
                      )
                    : (0, import_react34.createElement)(MessageActions, {
                        message,
                        disabled: submitting,
                        onEdit:
                          message.role === "user" && !side
                            ? () => {
                                setEditing(message.id);
                                setEditContent(message.text);
                              }
                            : void 0,
                        onFork:
                          message.role === "assistant" && !side
                            ? () => void fork(message.id)
                            : void 0,
                      }),
                  editing === message.id
                    ? (0, import_react34.createElement)(
                        "form",
                        {
                          className: "workagent-message-editor",
                          onSubmit: (event) => {
                            event.preventDefault();
                            if (editContent.trim())
                              void fork(message.id, editContent.trim());
                          },
                        },
                        (0, import_react34.createElement)(ComposerInput, {
                          "aria-label": "编辑消息",
                          workspaceId: session?.workspaceId,
                          autoFocus: true,
                          value: editContent,
                          onChange: (event) =>
                            setEditContent(event.target.value),
                          onKeyDown: submitComposerOnEnter,
                        }),
                        (0, import_react34.createElement)(
                          "small",
                          null,
                          `${busy ? "运行中的原任务会先停止。" : ""}从这条消息前重新继续，原会话保留。此操作不会回滚已修改的文件。`,
                        ),
                        (0, import_react34.createElement)(
                          "div",
                          { className: "workagent-actions" },
                          (0, import_react34.createElement)(
                            Button,
                            {
                              type: "submit",
                              disabled: submitting || !editContent.trim(),
                            },
                            submitting ? "正在重发…" : "保存并重发",
                          ),
                          (0, import_react34.createElement)(
                            Button,
                            {
                              disabled: submitting,
                              onClick: () => setEditing(null),
                            },
                            "取消编辑",
                          ),
                        ),
                      )
                    : null,
                ),
          ),
          visibleQueue.length
            ? (0, import_react34.createElement)(
                "div",
                {
                  className: "workagent-message-queue",
                  "aria-label": "待发送消息",
                },
                (0, import_react34.createElement)(
                  "small",
                  null,
                  `排队消息（${visibleQueue.length}）`,
                ),
                ...visibleQueue.map((row) =>
                  (0, import_react34.createElement)(
                    "article",
                    {
                      key: row.messageId,
                      className:
                        "workagent-message is-user workagent-queued-message",
                      "data-message-id": row.messageId,
                    },
                    (0, import_react34.createElement)(
                      "div",
                      null,
                      (0, import_react34.createElement)(
                        Markdown,
                        { workspaceId: session?.workspaceId },
                        row.content,
                      ),
                      (0, import_react34.createElement)(
                        "small",
                        { "data-delivery-status": row.status || "queued" },
                        row.status === "sending"
                          ? "发送中…"
                          : row.status === "failed"
                            ? "发送失败"
                            : "排队中",
                      ),
                      row.error
                        ? (0, import_react34.createElement)(
                            "small",
                            { className: "workagent-error" },
                            friendlyError(row.error),
                          )
                        : null,
                    ),
                    row.status === "failed"
                      ? (0, import_react34.createElement)(
                          Button,
                          {
                            disabled: submitting,
                            onClick: (event) => send(event, void 0, row),
                          },
                          "重试发送",
                        )
                      : null,
                    (0, import_react34.createElement)(
                      Button,
                      {
                        className: "workagent-queue-icon",
                        "aria-label": busy ? "立即追加" : "发送排队消息",
                        title: busy ? "立即追加到当前任务" : "发送这条消息",
                        disabled: submitting || !!row.status,
                        onClick: () =>
                          void updateQueue(
                            row.messageId,
                            busy ? "steer" : "send",
                          ),
                      },
                      (0, import_react34.createElement)(Icon, {
                        name: busy ? "steer" : "send",
                      }),
                    ),
                    (0, import_react34.createElement)(
                      Button,
                      {
                        className: "workagent-queue-icon",
                        "aria-label": "移除排队消息",
                        title: "移除排队消息",
                        disabled: submitting || !!row.status,
                        onClick: () =>
                          void updateQueue(row.messageId, "remove"),
                      },
                      (0, import_react34.createElement)(Icon, {
                        name: "close",
                      }),
                    ),
                  ),
                ),
              )
            : null,
          (0, import_react34.createElement)(workbench.Tools, {
            tools: nativeState.value?.tools,
            workspaceId: session?.workspaceId,
          }),
          (0, import_react34.createElement)(workbench.Artifacts, {
            sessionId: id,
            workspaceId: session?.workspaceId,
            revision: messageState.rows.length,
          }),
          (0, import_react34.createElement)(workbench.Process, {
            items: nativeState.value?.processes,
          }),
          draft
            ? (0, import_react34.createElement)(
                "article",
                { className: "workagent-message is-assistant is-streaming" },
                (0, import_react34.createElement)(SessionAvatar, { session }),
                (0, import_react34.createElement)(
                  Markdown,
                  { workspaceId: session?.workspaceId, streaming: true },
                  draft,
                ),
              )
            : busy
              ? (0, import_react34.createElement)(
                  "div",
                  {
                    className: "workagent-thinking",
                    role: "status",
                    "aria-live": "polite",
                  },
                  (0, import_react34.createElement)("span", null),
                  (0, import_react34.createElement)("span", null),
                  (0, import_react34.createElement)("span", null),
                  progress ||
                    (pending.some(
                      (row) => row.status === "sending" && !row.queued,
                    )
                      ? "正在发送…"
                      : "正在思考"),
                )
              : null,
        ),
        (0, import_react34.createElement)(
          ComposerForm,
          { className: "workagent-conversation-composer", onSubmit: send },
          (0, import_react34.createElement)(workbench.ComposerTools, {
            onBusyChange: setAttachmentsBusy,
            key: sessionId2,
            session,
            input,
            setInput,
            onError: setError,
            disabled: submitting,
          }),
          (0, import_react34.createElement)(ComposerInput, {
            "aria-label": side ? "侧聊消息" : "继续对话",
            workspaceId: session?.workspaceId,
            disabled: sessionState.rows[0]?.id !== sessionId2,
            value: input,
            onChange: (event) => setInput(event.target.value),
            onKeyDown: (event) => {
              const cursor = historyCursor.current;
              const history2 = messageState.rows
                .filter((row) => row.role === "user")
                .map((row) => row.text)
                .reverse();
              if (
                event.altKey &&
                ["ArrowUp", "ArrowDown"].includes(event.key)
              ) {
                event.preventDefault();
                if (cursor.index === -1) cursor.saved = input;
                cursor.index = Math.max(
                  -1,
                  Math.min(
                    history2.length - 1,
                    cursor.index + (event.key === "ArrowUp" ? 1 : -1),
                  ),
                );
                setInput(
                  cursor.index === -1 ? cursor.saved : history2[cursor.index],
                );
                return;
              }
              submitComposerOnEnter(event, () => {
                submitGesture.current = event.ctrlKey || event.metaKey;
              });
            },
            title: "Alt + ↑/↓ 浏览历史输入；Shift + Enter 换行",
            placeholder: busy
              ? busyEnter === "queue"
                ? "输入消息…"
                : "输入补充指令，调整当前任务…"
              : side
                ? "顺便问一句…"
                : "继续聊聊…",
          }),
          (0, import_react34.createElement)(
            "div",
            { className: "workagent-conversation-composer-bar" },
            (0, import_react34.createElement)(workbench.Controls, {
              ctx,
              session,
              busy,
              cancel,
            }),
            error
              ? (0, import_react34.createElement)(
                  "span",
                  { role: "alert", className: "workagent-error" },
                  error,
                )
              : busy
                ? (0, import_react34.createElement)(
                    "span",
                    { className: "workagent-muted" },
                    busyEnter === "queue"
                      ? "消息将排队，当前任务完成后发送"
                      : session?.engine === "kimi"
                        ? "补充指令会停止当前生成，再继续执行"
                        : "补充指令会送入当前任务",
                  )
                : null,
            busy
              ? (0, import_react34.createElement)(
                  "button",
                  {
                    type: "button",
                    className: "workagent-composer-icon",
                    "aria-label": "停止",
                    title: "停止当前任务",
                    onClick: () => void cancel(),
                  },
                  (0, import_react34.createElement)(Icon, {
                    name: "stop",
                    size: 20,
                  }),
                )
              : null,
            (0, import_react34.createElement)(
              "button",
              {
                type: "submit",
                className: "workagent-composer-icon",
                "aria-label": "发送",
                title: submitting
                  ? "提交中…"
                  : busy
                    ? busyEnter === "queue"
                      ? "排队发送"
                      : "立即追加"
                    : "发送",
                disabled: !input.trim() || submitting || attachmentsBusy,
              },
              (0, import_react34.createElement)(Icon, {
                name: "send",
                size: 20,
              }),
            ),
          ),
        ),
      );
    }
    function PersonalTaskTitle({ session }) {
      const state = SharedPage.useShared();
      const row = state.conversations.find(
        (item) =>
          item.kind === "personal_task" &&
          item.runtime_session_id === session.id,
      );
      return displaySessionTitle(row?.name || session.title);
    }
    function StalePersonalTask({ sessionId: sessionId2 }) {
      const state = SharedPage.useShared();
      const [busy, setBusy] = import_react33.default.useState(false);
      const row = state.conversations.find(
        (item) =>
          item.kind === "personal_task" &&
          item.runtime_session_id === sessionId2,
      );
      const remove = async () => {
        if (!row || busy) return;
        setBusy(true);
        try {
          await request("/api/portal/shared-conversations", {
            method: "DELETE",
            body: JSON.stringify({ conversation_id: row.id }),
          });
          await SharedPage.refresh();
          navigation.navigate(SharedPage.route(row.project_id));
        } catch {
          setBusy(false);
        }
      };
      return (0, import_react34.createElement)(
        "p",
        { role: "alert", className: "workagent-error" },
        "这个个人任务的会话已删除或不可用。",
        row
          ? (0, import_react34.createElement)(
              Button,
              { disabled: busy, onClick: remove },
              busy ? "正在移除…" : "移除该记录",
            )
          : null,
      );
    }

    // src/features/conversations/workspace.js
    var import_react35 = __toESM(require("react"), 1);
    var import_react36 = require("react");
    function ConversationWorkspace({ sessionId: sessionId2 }) {
      const ctx = import_react35.default.useContext(RuntimeServices);
      const workspaceRef = import_react35.default.useRef(null);
      const [workspaceWidth, setWorkspaceWidth] =
        import_react35.default.useState(0);
      const [sideWidth, setSideWidth] = import_react35.default.useState(
        () => Number(localStorage.getItem("workagent.side-chat.width")) || null,
      );
      import_react35.default.useLayoutEffect(() => {
        const workspace = workspaceRef.current;
        const measure = () =>
          setWorkspaceWidth(workspace.getBoundingClientRect().width);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(workspace);
        return () => observer.disconnect();
      }, []);
      const sideMaxWidth = Math.max(320, workspaceWidth - 384);
      const visibleSideWidth = Math.max(
        320,
        Math.min(
          sideMaxWidth,
          sideWidth ?? Math.min(520, workspaceWidth * 0.38),
        ),
      );
      const resizeSideWidth = (value) => {
        const next = Math.max(320, Math.min(sideMaxWidth, Math.round(value)));
        setSideWidth(next);
        localStorage.setItem("workagent.side-chat.width", String(next));
      };
      const [sideId, setSideId] = import_react35.default.useState(() =>
        localStorage.getItem(`workagent.side-chat.${sessionId2}`),
      );
      const [opening, setOpening] = import_react35.default.useState(false);
      const [sideError, setSideError] = import_react35.default.useState("");
      const [deleteTarget, setDeleteTarget] =
        import_react35.default.useState(null);
      const [deleting, setDeleting] = import_react35.default.useState(false);
      const deletingRef = import_react35.default.useRef(false);
      const openingRef = import_react35.default.useRef(false);
      const [sideState, reloadSides] = useResource(
        `${apiRoot}/sessions`,
        (rows) =>
          (Array.isArray(rows) ? rows : []).filter(
            (row) =>
              row.parentSessionId === sessionId2 &&
              row.branchKind === "side_chat",
          ),
      );
      import_react35.default.useEffect(() => {
        if (
          !sideId ||
          sideState.loading ||
          sideState.error ||
          opening ||
          deleting
        )
          return;
        if (!sideState.rows.some((row) => row.id === sideId)) {
          setSideId(null);
          localStorage.removeItem(`workagent.side-chat.${sessionId2}`);
        }
      }, [sideId, sideState, opening, deleting, sessionId2]);
      const deleteSideChat = async (event) => {
        event.preventDefault();
        if (!deleteTarget || deletingRef.current) return;
        deletingRef.current = true;
        setDeleting(true);
        setSideError("");
        try {
          await request(
            `${apiRoot}/sessions/${encodeURIComponent(deleteTarget)}`,
            {
              method: "DELETE",
            },
          );
          setSideId(null);
          localStorage.removeItem(`workagent.side-chat.${sessionId2}`);
          setDeleteTarget(null);
          await reloadSides();
        } catch (error) {
          setSideError(friendlyError(error.message));
        } finally {
          deletingRef.current = false;
          setDeleting(false);
        }
      };
      const openSideChat = async (content = "", fresh = false) => {
        if (openingRef.current) throw new Error("正在打开侧聊，请稍候");
        if (deletingRef.current || deleteTarget)
          throw new Error("请先完成侧聊删除操作");
        openingRef.current = true;
        setOpening(true);
        try {
          let target = fresh ? void 0 : sideId;
          if (!target) {
            const result = await request(
              `${apiRoot}/sessions/${encodeURIComponent(sessionId2)}/side-chat`,
              {
                method: "POST",
                body: "{}",
              },
            );
            target = result.id;
            await reloadSides();
          }
          setSideId(target);
          localStorage.setItem(`workagent.side-chat.${sessionId2}`, target);
          if (content) {
            const current = await request(
              `${apiRoot}/sessions/${encodeURIComponent(target)}`,
            );
            if (
              hasStandardSessions(ctx) &&
              ["codex", "kimi"].includes(current.engine)
            )
              await nativeSessionAction(
                ctx,
                target,
                "prompt",
                [{ type: "text", text: content }],
                current.activity?.state === "running" ||
                  current.activity?.state === "retrying"
                  ? "steer"
                  : "queue",
              );
            else
              await request(
                `${apiRoot}/sessions/${encodeURIComponent(target)}/${current.activity?.state === "running" || current.activity?.state === "retrying" ? "steer" : "turns"}`,
                {
                  method: "POST",
                  body: JSON.stringify({ content }),
                },
              );
          }
        } finally {
          openingRef.current = false;
          setOpening(false);
        }
      };
      return (0, import_react36.createElement)(
        "div",
        {
          className: `workagent-conversation-workspace${sideId ? " has-side-chat" : ""}`,
          ref: workspaceRef,
          style: { "--workagent-side-chat-width": `${visibleSideWidth}px` },
        },
        (0, import_react36.createElement)(RuntimeConversation, {
          key: sessionId2,
          sessionId: sessionId2,
          onSideChat: openSideChat,
        }),
        opening
          ? (0, import_react36.createElement)(
              "span",
              { role: "status", className: "workagent-side-opening" },
              "正在打开侧聊…",
            )
          : null,
        sideId
          ? (0, import_react36.createElement)(ResizeHandle, {
              orientation: "vertical",
              label: "调整侧聊宽度",
              className: "workagent-side-resizer",
              value: visibleSideWidth,
              min: 320,
              max: Math.floor(sideMaxWidth),
              onChange: resizeSideWidth,
              measure: (event) => {
                const initial = event.clientX;
                const actualWidth =
                  event.currentTarget.nextElementSibling.getBoundingClientRect()
                    .width;
                return (move) => actualWidth + initial - move.clientX;
              },
            })
          : null,
        sideId
          ? (0, import_react36.createElement)(
              "aside",
              { className: "workagent-side-chat", "aria-label": "侧聊 BTW" },
              (0, import_react36.createElement)(RuntimeConversation, {
                key: sideId,
                sessionId: sideId,
                side: true,
                sideHeader: (0, import_react36.createElement)(
                  "header",
                  {
                    className:
                      "workagent-conversation-title workagent-side-header",
                  },
                  (0, import_react36.createElement)(
                    "div",
                    { className: "workagent-side-toolbar" },
                    (0, import_react36.createElement)(
                      "div",
                      { className: "workagent-side-heading" },
                      (0, import_react36.createElement)("strong", null, "侧聊"),
                      (0, import_react36.createElement)(
                        "span",
                        { className: "workagent-side-badge" },
                        "BTW",
                      ),
                    ),
                    (0, import_react36.createElement)(
                      "nav",
                      {
                        className: "workagent-side-actions",
                        "aria-label": "侧聊操作",
                      },
                      (0, import_react36.createElement)(
                        Button,
                        {
                          className: "workagent-side-action",
                          "aria-label": "新侧聊",
                          title: "新建侧聊",
                          disabled: opening || deleting,
                          onClick: () => {
                            setSideError("");
                            void openSideChat("", true).catch((error) =>
                              setSideError(friendlyError(error.message)),
                            );
                          },
                        },
                        (0, import_react36.createElement)(Icon, {
                          name: "plus",
                          size: 17,
                        }),
                      ),
                      (0, import_react36.createElement)(
                        Button,
                        {
                          className: "workagent-side-action is-delete",
                          "aria-label": "删除侧聊",
                          title: "删除侧聊",
                          disabled: opening || deleting,
                          onClick: () => {
                            setSideError("");
                            setDeleteTarget(sideId);
                          },
                        },
                        (0, import_react36.createElement)(Icon, {
                          name: "trash",
                          size: 17,
                        }),
                      ),
                    ),
                  ),
                  sideState.rows.length > 1
                    ? (0, import_react36.createElement)(
                        "div",
                        { className: "workagent-side-picker" },
                        (0, import_react36.createElement)(Select, {
                          "aria-label": "选择侧聊",
                          disabled: opening || deleting,
                          value: sideId,
                          onChange: (event) => {
                            setSideId(event.target.value);
                            localStorage.setItem(
                              `workagent.side-chat.${sessionId2}`,
                              event.target.value,
                            );
                          },
                          options: sideState.rows.map((row, index) => [
                            row.id,
                            `${index + 1}. ${displaySessionTitle(row.title)}`,
                          ]),
                        }),
                        (0, import_react36.createElement)(Icon, {
                          name: "chevronDown",
                          size: 14,
                        }),
                      )
                    : (0, import_react36.createElement)(
                        "span",
                        { className: "workagent-side-caption" },
                        "和主对话分开记录",
                      ),
                  sideError && !deleteTarget
                    ? (0, import_react36.createElement)(
                        "span",
                        { role: "alert", className: "workagent-error" },
                        sideError,
                      )
                    : null,
                ),
              }),
            )
          : null,
        deleteTarget
          ? (0, import_react36.createElement)(
              Dialog,
              {
                as: "form",
                role: "alertdialog",
                title: "删除这个侧聊？",
                "aria-label": "确认删除侧聊",
                closeDisabled: deleting,
                onSubmit: deleteSideChat,
                onClose: () => {
                  setDeleteTarget(null);
                  setSideError("");
                },
              },
              (0, import_react36.createElement)(
                "p",
                null,
                "侧聊及其消息将被删除，主对话不受影响。再次打开会创建新的侧聊。",
              ),
              sideError
                ? (0, import_react36.createElement)(
                    "p",
                    { role: "alert", className: "workagent-error" },
                    sideError,
                  )
                : null,
              (0, import_react36.createElement)(
                "div",
                { className: "workagent-actions" },
                (0, import_react36.createElement)(
                  Button,
                  {
                    autoFocus: true,
                    disabled: deleting,
                    onClick: () => {
                      setDeleteTarget(null);
                      setSideError("");
                    },
                  },
                  "取消",
                ),
                (0, import_react36.createElement)(
                  Button,
                  {
                    type: "submit",
                    className: "workagent-button is-danger",
                    disabled: deleting,
                  },
                  deleting ? "正在删除…" : "确认删除",
                ),
              ),
            )
          : null,
      );
    }

    // src/features/marketplace/detail.js
    var import_react37 = __toESM(require("react"), 1);
    var sourceLabels = {
      stock_finance_data: "沪深股票财务数据",
      yahoo_finance: "雅虎财经",
      world_bank_open_data: "世界银行开放数据",
      tianyancha: "天眼查",
      arxiv: "arXiv 论文",
      scholar: "学术论文",
      yuandian_law: "元典法律",
      wind: "Wind 金融数据",
      imf: "国际货币基金组织（IMF）",
      gildata: "恒生聚源",
      sec_edgar: "美国证券交易委员会（SEC）",
      sp_data: "标普全球（S&P）",
      china_nda: "国家数据局",
      china_nbs: "国家统计局",
      china_standards: "国家标准",
      who: "世界卫生组织（WHO）",
      fao: "联合国粮农组织（FAO）",
      unsd: "联合国统计司（UNSD）",
      ecb: "欧洲中央银行（ECB）",
      eurostat: "欧盟统计局",
      unicef: "联合国儿童基金会（UNICEF）",
      oecd: "经济合作与发展组织（OECD）",
      fred: "美联储经济数据（FRED）",
      xhcj: "新华财经",
      caixin: "财新",
    };
    function MarketplaceDetail({ row, request: request2, explain, onClose }) {
      const [state, setState] = import_react37.default.useState({
        loading: true,
        value: null,
        error: "",
      });
      const [revision, setRevision] = import_react37.default.useState(0);
      import_react37.default.useEffect(() => {
        const controller = new AbortController();
        setState({ loading: true, value: null, error: "" });
        request2(`/api/portal/marketplace?id=${encodeURIComponent(row.id)}`, {
          signal: controller.signal,
          cache: "no-store",
        })
          .then((value) => {
            if (!controller.signal.aborted)
              setState({ loading: false, value, error: "" });
          })
          .catch((cause) => {
            if (!controller.signal.aborted)
              setState({
                loading: false,
                value: null,
                error: explain(cause.message),
              });
          });
        return () => controller.abort();
      }, [row.id, revision]);
      const entry = state.value?.entry;
      const quota = state.value?.professionalDatabase;
      return (0, import_react37.createElement)(
        Dialog,
        {
          title: `${row.name} · 详情`,
          onClose,
          className: "workagent-market-detail",
        },
        state.loading
          ? (0, import_react37.createElement)(
              "p",
              { role: "status" },
              "正在加载详情与调用次数…",
            )
          : null,
        state.error
          ? (0, import_react37.createElement)(
              "p",
              { role: "alert", className: "workagent-error" },
              `详情加载失败：${state.error}`,
            )
          : null,
        entry
          ? (0, import_react37.createElement)(
              import_react37.default.Fragment,
              null,
              (0, import_react37.createElement)(
                "p",
                { className: "workagent-muted" },
                `版本 ${entry.version} · ${entry.publisher}`,
              ),
              (0, import_react37.createElement)(
                "p",
                { className: "workagent-release-notes" },
                entry.description,
              ),
              entry.releaseNotes
                ? (0, import_react37.createElement)(
                    "p",
                    { className: "workagent-release-notes" },
                    `更新说明：${entry.releaseNotes}`,
                  )
                : null,
            )
          : null,
        quota
          ? (0, import_react37.createElement)(
              "section",
              { "aria-label": "我的专业数据库调用次数" },
              (0, import_react37.createElement)("h3", null, "我的调用次数"),
              (0, import_react37.createElement)(
                "p",
                { className: "workagent-muted" },
                "数据通过 Kimi 专业数据服务查询，实际可用数据取决于上游授权。",
              ),
              quota.configured && quota.upstream_ready === false
                ? (0, import_react37.createElement)(
                    "div",
                    { role: "status" },
                    (0, import_react37.createElement)(
                      "strong",
                      null,
                      "服务待授权",
                    ),
                    (0, import_react37.createElement)(
                      "p",
                      null,
                      "管理员尚需完成 Kimi 服务授权。授权完成前无法查询，不扣调用次数；账户额度可预先配置。",
                    ),
                  )
                : null,
              (0, import_react37.createElement)(
                "p",
                { className: "workagent-muted" },
                !quota.configured
                  ? "尚未配置调用额度，请联系管理员。"
                  : !quota.enabled
                    ? "未开通，当前不可调用。请联系管理员开通专业数据库。"
                    : "已开通 · 所有项目共用当前账户的调用次数。",
              ),
              quota.configured
                ? (0, import_react37.createElement)(
                    import_react37.default.Fragment,
                    null,
                    (0, import_react37.createElement)(
                      "div",
                      { className: "workagent-market-quota-grid" },
                      ...[
                        [
                          "今日",
                          quota.daily_remaining,
                          quota.daily_limit,
                          quota.daily_used,
                        ],
                        [
                          "本月",
                          quota.monthly_remaining,
                          quota.monthly_limit,
                          quota.monthly_used,
                        ],
                      ].map(([period, remaining, total, used]) =>
                        (0, import_react37.createElement)(
                          "section",
                          {
                            key: period,
                            className: "workagent-market-quota",
                            "aria-label": `${period}调用次数`,
                          },
                          (0, import_react37.createElement)("h4", null, period),
                          (0, import_react37.createElement)(
                            "p",
                            null,
                            "剩余调用次数 / 总可调用次数",
                          ),
                          (0, import_react37.createElement)(
                            "p",
                            { className: "workagent-market-quota-count" },
                            (0, import_react37.createElement)(
                              "strong",
                              null,
                              remaining,
                            ),
                            " / ",
                            total,
                          ),
                          (0, import_react37.createElement)(
                            "p",
                            { className: "workagent-muted" },
                            `已用 ${used} 次`,
                          ),
                        ),
                      ),
                    ),
                    quota.enabled &&
                      (quota.daily_remaining === 0 ||
                        quota.monthly_remaining === 0)
                      ? (0, import_react37.createElement)(
                          "p",
                          null,
                          "当前可用次数为 0，暂时无法调用。可等待额度重置或联系管理员调整次数。",
                        )
                      : null,
                    (0, import_react37.createElement)(
                      "p",
                      { className: "workagent-muted" },
                      "每日 00:00、每月 1 日 00:00 按北京时间（Asia/Shanghai）重置对应周期的已用次数；每日与每月上限同时生效。",
                    ),
                    (0, import_react37.createElement)(
                      "p",
                      { className: "workagent-muted" },
                      quota.counting_rule,
                    ),
                    (0, import_react37.createElement)(
                      "h4",
                      null,
                      "允许的数据源",
                    ),
                    (0, import_react37.createElement)(
                      "p",
                      { className: "workagent-market-sources" },
                      quota.allowed_sources.length
                        ? quota.allowed_sources
                            .map((source) => sourceLabels[source] || source)
                            .join("、")
                        : "未授权任何数据源，当前不可调用。",
                    ),
                  )
                : null,
            )
          : null,
        (0, import_react37.createElement)(
          "div",
          { className: "workagent-dialog-actions" },
          (0, import_react37.createElement)(
            Button,
            {
              disabled: state.loading,
              onClick: () => setRevision((value) => value + 1),
            },
            state.loading ? "正在刷新…" : "刷新详情与调用次数",
          ),
        ),
      );
    }

    // src/features/marketplace/marketplace.js
    function createMarketplace({
      React: React37,
      h: h33,
      request: request2,
      Section: Section2,
      Button: Button2,
      Card: Card2,
      Field: Field2,
      Input: Input2,
      useResource: useResource2,
      Status: Status2,
      friendlyError: friendlyError2,
      PublishForm,
    }) {
      const endpoint2 = "/api/portal/marketplace",
        kinds = { skill: "技能", mcp: "MCP", assistant: "助手" };
      const explain = (message) =>
        ({
          market_update_session_busy: "相关任务正在执行，请完成后再更新。",
          market_credentials_required: "这个版本需要连接凭据，请填写后重试。",
          project_owner_required: "只有项目负责人可以调整订阅。",
          market_skill_revoked: "此版本已被管理员撤销。",
          project_capability_unavailable:
            "项目订阅的版本暂不可用，请联系负责人。",
          market_security_update_pending:
            "管理员正在处理安全更新，请稍后重试。",
          professional_database_disabled: "请联系管理员开通专业数据库。",
          professional_database_unavailable:
            "专业数据库服务暂不可用，请稍后重试。",
        })[message] || friendlyError2(message);
      function MarketplaceSection2() {
        const [catalog, refresh] = useResource2(
            endpoint2,
            (v) => v.entries || [],
          ),
          [projects] = useResource2(
            "/api/portal/shared-projects",
            (v) => v.projects || [],
          );
        const [personalProjects] = useResource2("/api/runtime/v1/workspaces");
        const [project, setProject] = React37.useState(
          () => new URLSearchParams(location.search).get("marketProject") || "",
        );
        const [subscriptions, setSubscriptions] = React37.useState([]),
          [canManage, setCanManage] = React37.useState(false);
        const [query, setQuery] = React37.useState(""),
          [kind, setKind] = React37.useState("all"),
          [busy, setBusy] = React37.useState(""),
          [error, setError] = React37.useState(""),
          [notice, setNotice] = React37.useState("");
        const [publishing, setPublishing] = React37.useState(null),
          [history2, setHistory] = React37.useState(null),
          [detail, setDetail] = React37.useState(null),
          [credentials, setCredentials] = React37.useState(null);
        const projectURL = project
          ? project.startsWith("personal:")
            ? `/api/portal/projects/${encodeURIComponent(project.slice(9))}/capabilities`
            : `/api/portal/shared-projects/${encodeURIComponent(project)}/capabilities`
          : "";
        async function reloadProject() {
          if (!projectURL) {
            setSubscriptions([]);
            setCanManage(true);
            return;
          }
          const value = await request2(projectURL);
          setSubscriptions(value.subscriptions || []);
          setCanManage(value.canManage);
        }
        React37.useEffect(() => {
          let alive = true;
          setError("");
          setSubscriptions([]);
          setCanManage(!project);
          if (projectURL)
            request2(projectURL)
              .then((v) => {
                if (alive) {
                  setSubscriptions(v.subscriptions || []);
                  setCanManage(v.canManage);
                }
              })
              .catch((e) => {
                if (alive) setError(explain(e.message));
              });
          return () => {
            alive = false;
          };
        }, [projectURL]);
        const currentFor = (row) =>
          project
            ? subscriptions.find((s) => s.entry.seriesId === row.seriesId)
                ?.entry
            : row.selectedId
              ? { id: row.selectedId, version: row.installedVersion }
              : null;
        async function versions(row) {
          setError("");
          try {
            const v = await request2(
              `${endpoint2}/versions?seriesId=${encodeURIComponent(row.seriesId)}`,
            );
            setHistory({ row, versions: v.versions });
          } catch (e) {
            setError(explain(e.message));
          }
        }
        async function apply2(row, operation, secrets) {
          setBusy(row.id);
          setError("");
          setNotice("");
          try {
            const path = project
              ? projectURL
              : `${endpoint2}/${operation === "install" ? "install" : "update"}`;
            const result = await request2(path, {
              method: "POST",
              body: JSON.stringify({
                id: row.id,
                ...(secrets ? { credentials: secrets } : {}),
              }),
            });
            const failure = result.results?.find((v) => !v.success);
            if (failure) throw new Error(failure.error);
            await refresh();
            await reloadProject();
            setCredentials(null);
            setHistory(null);
            setNotice(
              project
                ? "项目订阅已保存，后续执行将使用选定版本。其他项目保持自己的版本。"
                : operation === "install"
                  ? "已获取。可在助手设置中选择这项能力。"
                  : "版本已切换，原会话和历史保留。项目订阅保持原版本。",
            );
          } catch (e) {
            if (e.message === "market_credentials_required" && !secrets) {
              try {
                const detail2 = await request2(
                  `${endpoint2}?id=${encodeURIComponent(row.id)}`,
                );
                setCredentials({ ...detail2, row, operation });
              } catch (cause) {
                setError(explain(cause.message));
              }
            } else setError(explain(e.message));
          } finally {
            setBusy("");
          }
        }
        async function updateAll() {
          setBusy("all");
          setError("");
          setNotice("");
          try {
            let results = [];
            if (project) {
              for (const s of subscriptions.filter((v) => v.updateAvailable)) {
                try {
                  await request2(projectURL, {
                    method: "POST",
                    body: JSON.stringify({ id: s.latest.id }),
                  });
                  results.push({ success: true });
                } catch (e) {
                  results.push({
                    success: false,
                    error: `${s.entry.name}：${explain(e.message)}`,
                  });
                }
              }
            } else {
              const v = await request2(`${endpoint2}/update`, {
                method: "POST",
                body: JSON.stringify({ all: true }),
              });
              results = v.results || [];
            }
            await refresh();
            await reloadProject();
            const failed = results.filter((v) => !v.success);
            setNotice(
              `已更新 ${results.filter((v) => v.success).length} 项${failed.length ? `，${failed.length} 项未完成，请分别打开处理。` : "。"}`,
            );
            if (failed.length)
              setError(failed.map((v) => explain(v.error)).join("；"));
          } catch (e) {
            setError(explain(e.message));
          } finally {
            setBusy("");
          }
        }
        async function unsubscribe(row) {
          setBusy(row.id);
          setError("");
          try {
            await request2(
              `${projectURL}?seriesId=${encodeURIComponent(row.seriesId)}`,
              { method: "DELETE" },
            );
            await reloadProject();
            setNotice("已取消项目订阅，个人安装和其他项目不受影响。");
          } catch (e) {
            setError(explain(e.message));
          } finally {
            setBusy("");
          }
        }
        const rows = catalog.rows.filter(
          (r) =>
            (!project || r.kind !== "assistant") &&
            (kind === "all" || r.kind === kind) &&
            `${r.name} ${r.description} ${r.publisher}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        );
        const updateCount = project
          ? subscriptions.filter((s) => s.updateAvailable).length
          : catalog.rows.filter((r) => r.updateAvailable).length;
        const action = (row) => {
          const current = currentFor(row);
          return h33(
            Button2,
            {
              disabled: !!busy || !canManage,
              onClick: () =>
                apply2(
                  row,
                  current && current.id !== row.id ? "update" : "install",
                ),
            },
            busy === row.id
              ? "处理中…"
              : current?.id === row.id
                ? "当前版本"
                : current
                  ? (
                      project
                        ? subscriptions.find(
                            (s) => s.entry.seriesId === row.seriesId,
                          )?.updateAvailable
                        : row.updateAvailable
                    )
                    ? "更新"
                    : "使用此版本"
                  : project
                    ? "订阅此版本"
                    : "获取",
          );
        };
        return h33(
          Section2,
          { title: "市场" },
          h33(
            "div",
            { className: "workagent-market-toolbar" },
            h33("input", {
              type: "search",
              "aria-label": "搜索市场",
              placeholder: "搜索技能、MCP 或助手",
              value: query,
              onChange: (e) => setQuery(e.target.value),
            }),
            h33(
              Button2,
              { onClick: () => setPublishing(publishing ? null : {}) },
              publishing ? "收起发布" : "发布到市场",
            ),
          ),
          h33(
            "label",
            { className: "workagent-market-scope" },
            "能力使用范围",
            h33(
              "select",
              {
                "aria-label": "能力使用范围",
                value: project,
                disabled: !!busy,
                onChange: (e) => {
                  setProject(e.target.value);
                  setHistory(null);
                  setCredentials(null);
                },
              },
              h33("option", { value: "" }, "我的能力"),
              h33(
                "option",
                { value: "personal:default" },
                "个人项目 · 默认项目",
              ),
              ...personalProjects.rows
                .filter((p) => p.id !== "default")
                .map((p) =>
                  h33(
                    "option",
                    { key: `personal:${p.id}`, value: `personal:${p.id}` },
                    `个人项目 · ${p.name}`,
                  ),
                ),
              ...projects.rows.map((p) =>
                h33(
                  "option",
                  { key: p.id, value: p.id },
                  `协作项目 · ${p.name}`,
                ),
              ),
            ),
          ),
          h33(
            "p",
            { className: "workagent-muted" },
            project
              ? "项目固定使用订阅时选定的版本，不会自动升级。所有成员可查看，负责人可更新。这里订阅技能与 MCP；助手可在项目成员中添加。"
              : "新版本只会提示，由你决定是否升级；可在版本记录中回退。管理员安全处置除外。",
          ),
          h33(
            Button2,
            {
              disabled: !!busy || !canManage || !updateCount,
              onClick: updateAll,
            },
            busy === "all"
              ? "正在更新…"
              : `一键更新${updateCount ? `（${updateCount}）` : ""}`,
          ),
          h33(
            "nav",
            { className: "workagent-tabs", "aria-label": "市场分类" },
            ...[["all", "全部"], ...Object.entries(kinds)].map(
              ([value, label]) =>
                h33(
                  Button2,
                  {
                    key: value,
                    "aria-pressed": kind === value,
                    onClick: () => setKind(value),
                  },
                  label,
                ),
            ),
          ),
          publishing
            ? h33(PublishForm, {
                entry: publishing.id ? publishing : void 0,
                onPublished: async () => {
                  setPublishing(null);
                  await refresh();
                  setNotice("版本已发布，用户可自行选择更新。");
                },
              })
            : null,
          error
            ? h33("p", { role: "alert", className: "workagent-error" }, error)
            : null,
          notice ? h33("p", { role: "status" }, notice) : null,
          h33(Status2, { state: catalog }),
          ...rows.map((row) => {
            const current = currentFor(row);
            return h33(
              Card2,
              {
                key: row.id,
                title: row.name,
                detail: `${kinds[row.kind]} · 最新 ${row.version} · ${row.publisher}`,
              },
              h33("p", null, row.description),
              h33(
                "p",
                null,
                current
                  ? `当前${project ? "订阅" : "安装"}：${current.version}`
                  : "尚未获取",
              ),
              row.releaseNotes
                ? h33(
                    "p",
                    { className: "workagent-release-notes" },
                    row.releaseNotes,
                  )
                : null,
              row.skills?.length
                ? h33("p", null, `包含技能：${row.skills.join("、")}`)
                : null,
              row.mcp?.length
                ? h33("p", null, `包含 MCP：${row.mcp.join("、")}`)
                : null,
              action(row),
              row.kind === "mcp"
                ? h33(Button2, { onClick: () => setDetail(row) }, "详情")
                : null,
              h33(
                Button2,
                { disabled: !!busy, onClick: () => versions(row) },
                "版本记录",
              ),
              project && current && canManage
                ? h33(
                    Button2,
                    { disabled: !!busy, onClick: () => unsubscribe(row) },
                    "取消订阅",
                  )
                : null,
              row.canDelete
                ? h33(
                    Button2,
                    { disabled: !!busy, onClick: () => setPublishing(row) },
                    "发布新版本",
                  )
                : null,
              row.canDelete
                ? h33(
                    Button2,
                    {
                      disabled: !!busy,
                      onClick: async () => {
                        setBusy(row.id);
                        try {
                          await request2(
                            `${endpoint2}?id=${encodeURIComponent(row.id)}`,
                            { method: "DELETE" },
                          );
                          await refresh();
                          setNotice("此版本已下架，已安装的副本仍可使用。");
                        } catch (e) {
                          setError(explain(e.message));
                        } finally {
                          setBusy("");
                        }
                      },
                    },
                    "下架此版本",
                  )
                : null,
            );
          }),
          project
            ? subscriptions
                .filter(
                  (s) =>
                    !catalog.rows.some((r) => r.seriesId === s.entry.seriesId),
                )
                .map((s) =>
                  h33(
                    Card2,
                    {
                      key: s.entry.id,
                      title: s.entry.name,
                      detail: `项目订阅 ${s.entry.version}${s.entry.revoked ? " · 已撤销" : " · 已下架"}`,
                    },
                    canManage
                      ? h33(
                          Button2,
                          { onClick: () => unsubscribe(s.entry) },
                          "取消订阅",
                        )
                      : null,
                  ),
                )
            : null,
          !catalog.loading && !rows.length
            ? h33("p", null, "暂无匹配内容，可以发布自己的能力。")
            : null,
          detail
            ? h33(MarketplaceDetail, {
                key: `detail:${detail.id}`,
                row: detail,
                request: request2,
                explain,
                onClose: () => setDetail(null),
              })
            : null,
          history2
            ? h33(
                "section",
                {
                  className: "workagent-market-history",
                  "aria-label": "版本记录",
                },
                h33("h3", null, `${history2.row.name} · 版本记录`),
                h33(
                  Button2,
                  { onClick: () => setHistory(null) },
                  "关闭版本记录",
                ),
                ...history2.versions.map((v) =>
                  h33(
                    Card2,
                    {
                      key: v.id,
                      title: v.version,
                      detail: new Date(v.createdAt).toLocaleString(),
                    },
                    h33(
                      "p",
                      { className: "workagent-release-notes" },
                      v.releaseNotes || "此版本尚未填写更新说明。",
                    ),
                    h33(
                      Button2,
                      {
                        disabled:
                          !!busy ||
                          !canManage ||
                          currentFor(history2.row)?.id === v.id,
                        onClick: () =>
                          apply2(
                            v,
                            currentFor(history2.row) ? "update" : "install",
                          ),
                      },
                      currentFor(history2.row)?.id === v.id
                        ? "当前版本"
                        : `使用 ${v.version}`,
                    ),
                  ),
                ),
              )
            : null,
          credentials
            ? h33(
                "form",
                {
                  className: "workagent-market-credentials",
                  onSubmit: (e) => {
                    e.preventDefault();
                    const form = new FormData(e.currentTarget),
                      values = {};
                    for (const m of credentials.bundle.mcp) {
                      values[m.id] = {};
                      for (const name of m.credentialNames)
                        values[m.id][name] = String(
                          form.get(`${m.id}:${name}`) || "",
                        );
                    }
                    apply2(credentials.row, credentials.operation, values);
                  },
                },
                h33("h3", null, `配置 ${credentials.row.name}`),
                ...credentials.bundle.mcp.flatMap((m) =>
                  m.credentialNames.map((name) =>
                    h33(
                      Field2,
                      { key: `${m.id}:${name}`, label: `${m.name} · ${name}` },
                      h33(Input2, {
                        name: `${m.id}:${name}`,
                        type: "password",
                        autoComplete: "new-password",
                        required: true,
                      }),
                    ),
                  ),
                ),
                h33(
                  Button2,
                  { type: "submit", disabled: !!busy },
                  "保存并继续",
                ),
                h33(Button2, { onClick: () => setCredentials(null) }, "取消"),
              )
            : null,
        );
      }
      return { MarketplaceSection: MarketplaceSection2 };
    }

    // src/features/marketplace/page.js
    var import_react38 = __toESM(require("react"), 1);
    var import_react39 = require("react");
    var marketKinds = { skill: "技能", mcp: "MCP", assistant: "助手" };
    var market = createMarketplace({
      React: import_react38.default,
      h: import_react39.createElement,
      request,
      Section,
      Button,
      Card,
      Field,
      Input,
      useResource,
      Status,
      friendlyError,
      PublishForm: MarketPublishForm,
    });
    function MarketplaceSection() {
      return (0, import_react39.createElement)(market.MarketplaceSection);
    }
    function MarketPublishForm({ onPublished, entry }) {
      const [kind, setKind] = import_react38.default.useState(
        entry?.kind || "skill",
      );
      const [sourceId, setSourceId] = import_react38.default.useState("");
      const [query, setQuery] = import_react38.default.useState("");
      const [error, setError] = import_react38.default.useState("");
      const [busy, setBusy] = import_react38.default.useState(false);
      const [skills] = useResource(`${apiRoot}/skills`);
      const [mcp] = useResource(`${apiRoot}/mcp-servers`);
      const [assistants] = usePresets();
      const state = { skill: skills, mcp, assistant: assistants }[kind];
      const options = state.rows.filter(
        (row) =>
          (row.source === "user" ||
            (kind === "skill" && row.source === "market")) &&
          `${row.name} ${row.id}`.toLowerCase().includes(query.toLowerCase()),
      );
      const selected = state.rows.find((row) => row.id === sourceId);
      return (0, import_react39.createElement)(
        "form",
        {
          className: "workagent-market-publish",
          onSubmit: async (event) => {
            event.preventDefault();
            setError("");
            setBusy(true);
            const values = new FormData(event.currentTarget);
            try {
              await request("/api/portal/marketplace", {
                method: "POST",
                body: JSON.stringify({
                  kind,
                  sourceId,
                  name: String(values.get("name")),
                  description: String(values.get("description")),
                  version: String(values.get("version")),
                  seriesId: entry?.seriesId || "",
                  releaseNotes: String(values.get("releaseNotes") || ""),
                }),
              });
              await onPublished();
            } catch (cause) {
              setError(friendlyError(cause.message));
            } finally {
              setBusy(false);
            }
          },
        },
        (0, import_react39.createElement)("h3", null, "发布到共享市场"),
        (0, import_react39.createElement)(
          "p",
          null,
          "所选内容和助手绑定的技能、MCP 配置会随版本共享给其他成员。连接密钥由获取者自行填写。",
        ),
        (0, import_react39.createElement)(
          Field,
          { label: "发布类型" },
          (0, import_react39.createElement)(Select, {
            value: kind,
            disabled: !!entry || busy,
            onChange: (e) => {
              setKind(e.target.value);
              setSourceId("");
              setQuery("");
            },
            options: Object.entries(marketKinds),
          }),
        ),
        (0, import_react39.createElement)(
          Field,
          { label: "搜索已安装内容" },
          (0, import_react39.createElement)(Input, {
            type: "search",
            value: query,
            onChange: (e) => setQuery(e.target.value),
          }),
        ),
        (0, import_react39.createElement)(
          Field,
          { label: "发布内容" },
          (0, import_react39.createElement)(Select, {
            value: sourceId,
            required: true,
            onChange: (e) => setSourceId(e.target.value),
            options: [
              ["", "请选择"],
              ...options.map((row) => [row.id, row.name]),
            ],
          }),
        ),
        selected
          ? (0, import_react39.createElement)(
              "div",
              { key: selected.id, className: "workagent-market-fields" },
              (0, import_react39.createElement)(
                Field,
                { label: "市场名称" },
                (0, import_react39.createElement)(Input, {
                  name: "name",
                  required: true,
                  maxLength: 240,
                  defaultValue: entry?.name || selected.name,
                }),
              ),
              (0, import_react39.createElement)(
                Field,
                { label: "版本" },
                (0, import_react39.createElement)(Input, {
                  name: "version",
                  required: true,
                  pattern: "[0-9]+\\.[0-9]+\\.[0-9]+",
                  defaultValue: entry?.version
                    ? entry.version
                        .split(".")
                        .map((part, index) =>
                          index === 2 ? Number(part) + 1 : part,
                        )
                        .join(".")
                    : "1.0.0",
                }),
              ),
              (0, import_react39.createElement)(
                Field,
                { label: "说明" },
                (0, import_react39.createElement)("textarea", {
                  name: "description",
                  required: true,
                  maxLength: 4096,
                  defaultValue: selected.description || "",
                }),
              ),
              (0, import_react39.createElement)(
                Field,
                { label: "本版本更新说明" },
                (0, import_react39.createElement)("textarea", {
                  name: "releaseNotes",
                  maxLength: 12e3,
                  required: true,
                  placeholder: "说明新增能力、修复内容、兼容性及升级注意事项",
                }),
              ),
              kind === "assistant"
                ? (0, import_react39.createElement)(
                    "p",
                    null,
                    `将一并打包 ${selected.skillIds?.length || 0} 个技能及其依赖、${selected.mcpServerIds?.length || 0} 个直接绑定的 MCP。`,
                  )
                : null,
            )
          : null,
        error
          ? (0, import_react39.createElement)(
              "p",
              { role: "alert", className: "workagent-error" },
              error,
            )
          : null,
        (0, import_react39.createElement)(
          Button,
          { type: "submit", disabled: busy || !selected },
          busy ? "正在发布…" : "发布",
        ),
      );
    }

    // src/features/notifications/page.js
    var import_react40 = __toESM(require("react"), 1);
    var import_react41 = require("react");
    function CompletionNotificationSettings() {
      const routeSearch = navigation.useSearch();
      const endpoint2 = `${apiRoot}/completion-notifications`;
      const [state, refresh] = useResource(endpoint2);
      const saved = state.rows[0];
      const [draft, setDraft] = import_react40.default.useState(null);
      const [error, setError] = import_react40.default.useState("");
      const [saving, setSaving] = import_react40.default.useState(false);
      const [notice, setNotice] = import_react40.default.useState("");
      import_react40.default.useEffect(() => {
        if (saved)
          setDraft({
            enabled: saved.enabled,
            targetId: saved.targetId,
            attachFiles: saved.attachFiles === true,
          });
      }, [saved]);
      const update = (values) => {
        setNotice("");
        setDraft((current) => ({ ...current, ...values }));
      };
      const save = async (event) => {
        event.preventDefault();
        setSaving(true);
        setError("");
        try {
          await request(endpoint2, {
            method: "PUT",
            body: JSON.stringify(draft),
          });
          await refresh();
          setNotice("提醒设置已保存");
        } catch (error2) {
          setError(error2.message);
        } finally {
          setSaving(false);
        }
      };
      const retry = async (id) => {
        setSaving(true);
        setError("");
        try {
          await request(`${endpoint2}/retry`, {
            method: "POST",
            body: JSON.stringify({ id }),
          });
          await refresh();
        } catch (error2) {
          setError(error2.message);
        } finally {
          setSaving(false);
        }
      };
      return (0, import_react41.createElement)(
        Section,
        { title: "消息提醒" },
        (0, import_react41.createElement)(workbench.Notifications),
        new URLSearchParams(routeSearch).get("session")
          ? (0, import_react41.createElement)(workbench.SessionReminder, {
              sessionId: new URLSearchParams(routeSearch).get("session"),
            })
          : null,
        (0, import_react41.createElement)(
          "p",
          { className: "workagent-muted" },
          "开启后，网页对话和定时任务完成时，会把最终回复和产物下载链接推送到选定的 IM 聊天。渠道内的对话仍在原聊天回复，不重复提醒。",
        ),
        (0, import_react41.createElement)(Status, { state }),
        draft &&
          (0, import_react41.createElement)(
            "form",
            {
              className: "workagent-form workagent-completion-form",
              onSubmit: save,
            },
            (0, import_react41.createElement)(
              "label",
              { className: "workagent-inline" },
              (0, import_react41.createElement)(Switch, {
                "aria-label": "任务完成提醒",
                checked: draft.enabled,
                onChange: (enabled) => update({ enabled }),
              }),
              "任务完成提醒",
            ),
            (0, import_react41.createElement)(
              "label",
              null,
              (0, import_react41.createElement)("input", {
                type: "checkbox",
                checked: draft.attachFiles,
                onChange: (event) =>
                  update({ attachFiles: event.target.checked }),
              }),
              "同时发送产物文件（支持文件的渠道，单个不超过 50 MiB）",
            ),
            (0, import_react41.createElement)(
              Field,
              { label: "接收聊天" },
              (0, import_react41.createElement)(
                "select",
                {
                  "aria-label": "接收聊天",
                  value: draft.targetId,
                  onChange: (event) => update({ targetId: event.target.value }),
                },
                (0, import_react41.createElement)(
                  "option",
                  { value: "" },
                  "请选择接收聊天",
                ),
                ...(saved?.targets || []).map((target) =>
                  (0, import_react41.createElement)(
                    "option",
                    {
                      key: target.id,
                      value: target.id,
                      disabled: !target.connected,
                    },
                    `${target.label}${target.connected ? "" : "（未连接）"}`,
                  ),
                ),
                draft.targetId &&
                  !(saved?.targets || []).some(
                    (target) => target.id === draft.targetId,
                  )
                  ? (0, import_react41.createElement)(
                      "option",
                      { value: draft.targetId },
                      "原接收聊天已不可用，请重新选择",
                    )
                  : null,
              ),
            ),
            !(saved?.targets || []).length &&
              (0, import_react41.createElement)(
                "p",
                { className: "workagent-muted" },
                "请先在“消息渠道”连接账号，并在接收聊天中给机器人发送一条消息，再刷新聊天列表。",
              ),
            (0, import_react41.createElement)(
              Button,
              { type: "button", onClick: refresh },
              "刷新聊天列表",
            ),
            (0, import_react41.createElement)(
              "p",
              { className: "workagent-muted" },
              "产物链接需要登录当前 WorkAgent 账号后下载。",
            ),
            (0, import_react41.createElement)(
              Button,
              { type: "submit", disabled: saving },
              saving ? "保存中…" : "保存提醒设置",
            ),
            error &&
              (0, import_react41.createElement)(
                "p",
                { role: "alert", className: "workagent-error" },
                error,
              ),
            notice &&
              (0, import_react41.createElement)(
                "p",
                { role: "status" },
                notice,
              ),
          ),
        (0, import_react41.createElement)("h3", null, "最近推送"),
        (0, import_react41.createElement)(
          Button,
          { type: "button", onClick: refresh },
          "刷新推送记录",
        ),
        !(saved?.deliveries || []).length &&
          (0, import_react41.createElement)(
            "p",
            { className: "workagent-muted" },
            "暂无推送记录",
          ),
        ...(saved?.deliveries || []).map((delivery) =>
          (0, import_react41.createElement)(
            "div",
            { key: delivery.id, className: "workagent-card" },
            (0, import_react41.createElement)("strong", null, delivery.title),
            (0, import_react41.createElement)(
              "p",
              null,
              `${delivery.targetLabel} · ${{ pending: "等待发送", sending: "发送中", sent: "已发送", failed: "发送失败", cancelled: "已取消" }[delivery.status]}`,
            ),
            delivery.error &&
              (0, import_react41.createElement)(
                "p",
                { className: "workagent-error" },
                delivery.error,
              ),
            delivery.status === "failed" &&
              (0, import_react41.createElement)(
                Button,
                {
                  disabled: saving || !draft?.enabled,
                  onClick: () => retry(delivery.id),
                },
                "重试推送",
              ),
          ),
        ),
      );
    }
    function NotificationsPage() {
      const endpoint2 = "/api/portal/me/notifications";
      const [state, refresh] = useResource(
        endpoint2,
        (value) => value.notifications || [],
      );
      const [error, setError] = import_react40.default.useState("");
      const unread = state.rows.filter((row) => !row.read_at).length;
      const open = async (row) => {
        try {
          if (!row.read_at)
            await request(`${endpoint2}/${encodeURIComponent(row.id)}/read`, {
              method: "POST",
            });
          await request(
            `${endpoint2}/${encodeURIComponent(row.id)}/acknowledge`,
            {
              method: "POST",
            },
          );
          await refresh();
          if (row.deep_link) navigation.navigate(row.deep_link);
        } catch (reason) {
          setError(reason.message);
        }
      };
      return (0, import_react41.createElement)(
        Section,
        { title: "通知" },
        (0, import_react41.createElement)(
          "p",
          { className: "workagent-muted" },
          `未读 ${unread} 条`,
        ),
        error
          ? (0, import_react41.createElement)(
              "p",
              { role: "alert", className: "workagent-error" },
              error,
            )
          : null,
        (0, import_react41.createElement)(Status, { state }),
        ...state.rows.map((row) =>
          (0, import_react41.createElement)(
            Card,
            { key: row.id, title: row.title || row.kind, detail: row.message },
            (0, import_react41.createElement)(
              Button,
              { onClick: () => open(row) },
              row.deep_link ? "打开并标记已读" : "标记已读",
            ),
          ),
        ),
      );
    }
    function TopNotificationButton() {
      const [state] = useResource(
        "/api/portal/me/notifications",
        (value) => value.notifications || [],
      );
      const unread = state.rows.filter((row) => !row.read_at).length;
      return (0, import_react41.createElement)(
        "button",
        {
          type: "button",
          className: "workagent-top-notifications",
          title: "通知",
          "aria-label": unread ? `通知，${unread} 条未读` : "通知",
          onClick: () => navigation.toggleNotifications(),
        },
        (0, import_react41.createElement)(Icon, {
          name: "notifications",
          size: 19,
        }),
        unread
          ? (0, import_react41.createElement)(
              "span",
              { className: "workagent-badge" },
              unread,
            )
          : null,
      );
    }
    function NotificationFooter({ wide }) {
      const [state] = useResource(
        "/api/portal/me/notifications",
        (value) => value.notifications || [],
      );
      const unread = state.rows.filter((row) => !row.read_at).length;
      return (0, import_react41.createElement)(
        "button",
        {
          type: "button",
          className: "workagent-footer",
          "data-kind": "notifications",
          title: "通知",
          "aria-label": "通知",
          onClick: () => navigation.toggleNotifications(),
        },
        (0, import_react41.createElement)(Icon, { name: "notifications" }),
        wide ? (0, import_react41.createElement)("span", null, "通知") : null,
        unread > 0
          ? (0, import_react41.createElement)(
              "span",
              { className: "workagent-badge" },
              unread,
            )
          : null,
      );
    }

    // src/features/projects/state.js
    var WORKSPACE_PICK_KEY = "workagent.hero.workspace";
    var HERO_WORKSPACE_EVENT = "workagent:hero-workspace";
    var PROJECTS_CHANGED_EVENT = "workagent:projects-changed";
    function startProjectConversation(project) {
      localStorage.setItem(WORKSPACE_PICK_KEY, project.id);
      navigation.navigate(
        `/?frontend=dsh&project=${encodeURIComponent(project.id)}`,
      );
    }
    var announceProjectsChanged = () =>
      window.dispatchEvent(new window.Event(PROJECTS_CHANGED_EVENT));

    // src/features/projects/page.js
    var import_react42 = __toESM(require("react"), 1);
    var import_react43 = require("react");
    function WorkspacesPage() {
      const endpoint2 = `${apiRoot}/workspaces`;
      const [state, refresh] = useResource(endpoint2);
      const [selectedId, setSelectedId] = import_react42.default.useState(null);
      const [error, setError] = import_react42.default.useState("");
      const [query, setQuery] = import_react42.default.useState("");
      const [creating2, setCreating] = import_react42.default.useState(false);
      const [showCreate, setShowCreate] =
        import_react42.default.useState(false);
      const visibleProjects = state.rows.filter((workspace) =>
        displayWorkspaceName(workspace.name)
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
      );
      import_react42.default.useEffect(() => {
        const update = () => void refresh();
        window.addEventListener(PROJECTS_CHANGED_EVENT, update);
        return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, update);
      }, [refresh]);
      const createProject = async (event) => {
        event.preventDefault();
        if (creating2) return;
        const form = event.currentTarget;
        const values = new FormData(form);
        const name = String(values.get("name") || "").trim();
        if (!name) {
          setError("请输入项目名称。");
          return;
        }
        setCreating(true);
        setError("");
        try {
          const project = await request(endpoint2, {
            method: "POST",
            body: JSON.stringify({ name, scope: "personal" }),
          });
          await refresh();
          announceProjectsChanged();
          form.reset();
          setShowCreate(false);
          setQuery("");
          setSelectedId(project.id);
        } catch (reason) {
          setError(friendlyError(reason.message));
        } finally {
          setCreating(false);
        }
      };
      return (0, import_react43.createElement)(
        Section,
        { title: "项目" },
        (0, import_react43.createElement)(
          "div",
          { className: "workagent-project-intro" },
          (0, import_react43.createElement)(
            "div",
            null,
            (0, import_react43.createElement)("h2", null, "所有项目"),
            (0, import_react43.createElement)(
              "p",
              null,
              "文件与对话，在这里井然有序。",
            ),
          ),
          (0, import_react43.createElement)(
            "span",
            { className: "workagent-project-count" },
            `${state.rows.length} 个项目`,
          ),
        ),
        (0, import_react43.createElement)(
          "div",
          { className: "workagent-project-toolbar" },
          (0, import_react43.createElement)(
            "div",
            { className: "workagent-project-search" },
            (0, import_react43.createElement)(Icon, {
              name: "search",
              size: 18,
            }),
            (0, import_react43.createElement)(Input, {
              "aria-label": "搜索项目",
              placeholder: "搜索项目名称…",
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }),
            query
              ? (0, import_react43.createElement)(
                  Button,
                  { "aria-label": "清除项目搜索", onClick: () => setQuery("") },
                  (0, import_react43.createElement)(Icon, {
                    name: "close",
                    size: 16,
                  }),
                )
              : null,
          ),
          (0, import_react43.createElement)(
            Button,
            {
              className: "workagent-button workagent-project-new",
              variant: "primary",
              onClick: () => {
                setError("");
                setShowCreate(true);
              },
            },
            (0, import_react43.createElement)(Icon, { name: "plus", size: 16 }),
            "新建项目",
          ),
        ),
        showCreate
          ? (0, import_react43.createElement)(
              "form",
              {
                className: "workagent-form workagent-project-create",
                onSubmit: createProject,
              },
              (0, import_react43.createElement)(
                Field,
                { label: "新项目名称" },
                (0, import_react43.createElement)(Input, {
                  name: "name",
                  autoFocus: true,
                  required: true,
                  maxLength: 120,
                  placeholder: "给项目起个名字",
                  onKeyDown: (event) => {
                    if (event.key === "Escape" && !creating2) {
                      event.stopPropagation();
                      setShowCreate(false);
                    }
                  },
                }),
              ),
              (0, import_react43.createElement)(
                Button,
                { disabled: creating2, onClick: () => setShowCreate(false) },
                "取消",
              ),
              (0, import_react43.createElement)(
                Button,
                {
                  className: "workagent-button workagent-project-new",
                  variant: "primary",
                  type: "submit",
                  disabled: creating2,
                },
                creating2 ? "正在创建…" : "创建项目",
              ),
            )
          : null,
        error
          ? (0, import_react43.createElement)(
              "p",
              { role: "alert", className: "workagent-error" },
              error,
            )
          : null,
        state.loading || state.error
          ? (0, import_react43.createElement)(Status, { state })
          : state.rows.length === 0
            ? (0, import_react43.createElement)(
                "div",
                { className: "workagent-project-empty" },
                (0, import_react43.createElement)(Icon, {
                  name: "workspace",
                  size: 36,
                }),
                (0, import_react43.createElement)(
                  "strong",
                  null,
                  "创建你的第一个项目",
                ),
                (0, import_react43.createElement)(
                  "p",
                  null,
                  "给项目起个名字，将相关文件与对话放在一起。",
                ),
              )
            : null,
        !state.loading && state.rows.length > 0 && visibleProjects.length === 0
          ? (0, import_react43.createElement)(
              "div",
              { className: "workagent-project-empty" },
              (0, import_react43.createElement)(Icon, {
                name: "search",
                size: 28,
              }),
              (0, import_react43.createElement)(
                "strong",
                null,
                "没有找到匹配的项目",
              ),
              (0, import_react43.createElement)(
                "p",
                null,
                "试试其他名称，或清除搜索查看所有项目。",
              ),
            )
          : null,
        (0, import_react43.createElement)(
          "div",
          { className: "workagent-grid workagent-workspace-grid" },
          ...visibleProjects.map((workspace) =>
            (0, import_react43.createElement)(
              import_react42.default.Fragment,
              { key: workspace.id },
              (0, import_react43.createElement)(
                Card,
                {
                  key: workspace.id,
                  className: `workagent-workspace-card${selectedId === workspace.id ? " is-selected" : ""}`,
                  title: (0, import_react43.createElement)(
                    "span",
                    null,
                    (0, import_react43.createElement)(Icon, {
                      name: "workspace",
                      size: 18,
                    }),
                    displayWorkspaceName(workspace.name),
                  ),
                  detail:
                    workspace.scope === "team" ? "团队共享项目" : "个人项目",
                },
                (0, import_react43.createElement)(
                  Button,
                  {
                    onClick: () => setSelectedId(workspace.id),
                    "aria-expanded": selectedId === workspace.id,
                  },
                  "管理文件",
                  (0, import_react43.createElement)(Icon, {
                    name: "chevronRight",
                    size: 14,
                  }),
                ),
                (0, import_react43.createElement)(
                  Button,
                  { onClick: () => startProjectConversation(workspace) },
                  (0, import_react43.createElement)(Icon, {
                    name: "plus",
                    size: 14,
                  }),
                  "新建会话",
                ),
              ),
              selectedId === workspace.id
                ? (0, import_react43.createElement)(
                    "section",
                    {
                      className: "workagent-project-files",
                      "aria-label": "项目文件",
                    },
                    (0, import_react43.createElement)(
                      "header",
                      { className: "workagent-files-panel-header" },
                      (0, import_react43.createElement)(
                        "strong",
                        null,
                        displayWorkspaceName(workspace.name),
                      ),
                      (0, import_react43.createElement)(FileIconButton, {
                        name: "close",
                        label: "收起项目文件",
                        onClick: () => setSelectedId(null),
                      }),
                    ),
                    (0, import_react43.createElement)(WorkspaceFileManager, {
                      key: workspace.id,
                      workspace,
                      onDismiss: () => setSelectedId(null),
                      dismissLabel: "收起项目文件",
                    }),
                  )
                : null,
            ),
          ),
        ),
      );
    }

    // src/features/system/settings.js
    var import_react44 = __toESM(require("react"), 1);
    var import_react45 = require("react");
    var CHAT_PAGE_KEY = "workagent.chat-page-url";
    function ChatPageSettings() {
      const [address, setAddress] = import_react44.default.useState(
        () => localStorage.getItem(CHAT_PAGE_KEY) || "",
      );
      const [notice, setNotice] = import_react44.default.useState("");
      const [error, setError] = import_react44.default.useState("");
      const save = (event) => {
        event.preventDefault();
        setNotice("");
        setError("");
        try {
          const value = address.trim();
          if (value) {
            if (!value.startsWith("/") && !/^https?:\/\//i.test(value))
              throw new Error("请填写以 HTTP、HTTPS 或 / 开头的聊天网页地址。");
            const url = new URL(value, location.origin);
            if (!/^https?:$/.test(url.protocol) || url.username || url.password)
              throw new Error(
                "请填写 HTTP 或 HTTPS 网页地址，不要在地址中包含账号密码。",
              );
            localStorage.setItem(CHAT_PAGE_KEY, url.href);
          } else localStorage.removeItem(CHAT_PAGE_KEY);
          setNotice("已保存，点击侧栏的聊天模式即可打开。");
        } catch (reason) {
          setError(
            reason instanceof TypeError
              ? "请输入有效的聊天网页地址。"
              : reason.message,
          );
        }
      };
      return (0, import_react45.createElement)(
        import_react44.default.Fragment,
        null,
        (0, import_react45.createElement)("h3", null, "聊天模式"),
        (0, import_react45.createElement)(
          "p",
          null,
          "填写独立聊天网页的完整地址，例如旧版 WorkAgent 的 /chatgpt/ 地址。留空使用本站入口。此设置仅保存在当前浏览器。",
        ),
        (0, import_react45.createElement)(
          "form",
          { className: "workagent-form", onSubmit: save },
          (0, import_react45.createElement)(
            Field,
            { label: "聊天网页地址" },
            (0, import_react45.createElement)(Input, {
              "aria-label": "聊天网页地址",
              value: address,
              placeholder: "/chatgpt/",
              onChange: (event) => {
                setAddress(event.target.value);
                setNotice("");
                setError("");
              },
            }),
          ),
          (0, import_react45.createElement)(
            Button,
            { type: "submit", style: { alignSelf: "end" } },
            "保存聊天地址",
          ),
        ),
        error
          ? (0, import_react45.createElement)("p", { role: "alert" }, error)
          : null,
        notice
          ? (0, import_react45.createElement)("p", { role: "status" }, notice)
          : null,
      );
    }
    function SystemSettings() {
      const { confirm, confirmation } = useConfirm();
      const [storage, refreshStorage] = useResource(
        "/api/system/storage",
        (value) => [value],
      );
      const [status, refreshStatus] = useResource(
        "/api/system/status",
        (value) => [value],
      );
      const [preferences, refreshPreferences] = useResource(
        `${apiRoot}/runtime-settings`,
        (value) => [value],
      );
      const [error, setError] = import_react44.default.useState("");
      const [notice, setNotice] = import_react44.default.useState("");
      const [busy, setBusy] = import_react44.default.useState(false);
      return (0, import_react45.createElement)(
        Section,
        { title: "系统与帮助" },
        confirmation,
        (0, import_react45.createElement)(ChatPageSettings),
        (0, import_react45.createElement)(
          "div",
          { className: "workagent-settings-heading" },
          (0, import_react45.createElement)("h3", null, "存储空间"),
          (0, import_react45.createElement)(
            Button,
            {
              onClick: refreshStorage,
              "aria-label": "刷新磁盘用量",
              title: "刷新磁盘用量",
            },
            (0, import_react45.createElement)(Icon, {
              name: "refresh",
              size: 16,
            }),
          ),
        ),
        storage.error
          ? (0, import_react45.createElement)(
              "p",
              { role: "alert" },
              "暂时无法读取磁盘配额，请刷新或联系管理员。",
            )
          : null,
        (0, import_react45.createElement)(
          "div",
          { className: "workagent-storage-grid" },
          ...["personal", "shared"].map((kind) => {
            const quota = storage.rows[0]?.[kind];
            return (0, import_react45.createElement)(
              "article",
              { key: kind, className: "workagent-storage-card" },
              (0, import_react45.createElement)(Icon, {
                name: kind === "personal" ? "workspace" : "shared",
                size: 20,
              }),
              (0, import_react45.createElement)(
                "span",
                null,
                kind === "personal" ? "个人空间" : "共享空间",
              ),
              (0, import_react45.createElement)(
                "strong",
                null,
                quota ? (quota.usedBytes / 1024 ** 3).toFixed(2) + " GiB" : "—",
              ),
              (0, import_react45.createElement)(
                "small",
                null,
                quota?.enabled
                  ? "共 " + (quota.limitBytes / 1024 ** 3).toFixed(2) + " GiB"
                  : "尚未配置配额",
              ),
              quota?.enabled
                ? (0, import_react45.createElement)("progress", {
                    max: quota.limitBytes || 1,
                    value: quota.usedBytes,
                    "aria-label":
                      kind === "personal" ? "个人空间用量" : "共享空间用量",
                  })
                : null,
            );
          }),
        ),
        (0, import_react45.createElement)(
          "div",
          { className: "workagent-settings-heading" },
          (0, import_react45.createElement)("h3", null, "运行状态"),
          (0, import_react45.createElement)(
            Button,
            {
              onClick: refreshStatus,
              "aria-label": "刷新运行状态",
              title: "刷新运行状态",
            },
            (0, import_react45.createElement)(Icon, {
              name: "refresh",
              size: 16,
            }),
          ),
        ),
        (0, import_react45.createElement)(
          "div",
          { className: "workagent-system-status" },
          ...(status.rows[0]?.components || []).map((row) =>
            (0, import_react45.createElement)(
              "div",
              { key: row.id },
              (0, import_react45.createElement)(
                "span",
                null,
                {
                  portal: "平台",
                  notifications: "消息提醒",
                  audit: "活动记录",
                  userhost: "员工服务",
                  harness: "任务运行环境",
                }[row.id] || row.id,
              ),
              (0, import_react45.createElement)(
                "span",
                {
                  className: "workagent-status-label",
                  "data-status": row.status,
                },
                (0, import_react45.createElement)("i", { "aria-hidden": true }),
                {
                  healthy: "正常",
                  unavailable: "暂不可用",
                  unhealthy: "异常",
                  disabled: "未启用",
                  unknown: "待确认",
                }[row.status] || row.status,
              ),
            ),
          ),
        ),
        (0, import_react45.createElement)(
          "a",
          { href: "/api/system/diagnostics", download: true },
          "下载诊断报告",
        ),
        (0, import_react45.createElement)(
          Button,
          {
            disabled: busy,
            onClick: async () => {
              if (
                !(await confirm(
                  "重启当前员工的任务运行环境？正在执行的工作会中断。",
                ))
              )
                return;
              setBusy(true);
              setError("");
              try {
                await request("/api/system/runtime/restart", {
                  method: "POST",
                });
                setNotice("已提交重启，请稍后刷新运行状态。");
              } catch (reason) {
                setError(friendlyError(reason.message));
              } finally {
                setBusy(false);
              }
            },
          },
          "重启运行环境",
        ),
        preferences.rows[0]
          ? (0, import_react45.createElement)(
              "form",
              {
                className: "workagent-form",
                key: preferences.rows[0].turnTimeoutSeconds,
                onSubmit: async (event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  setBusy(true);
                  setError("");
                  const ok = await mutate(
                    refreshPreferences,
                    setError,
                    `${apiRoot}/runtime-settings`,
                    "PUT",
                    { turnTimeoutSeconds: Number(form.get("timeout")) },
                  );
                  setBusy(false);
                  if (ok) setNotice("已保存，从下一轮任务开始生效。");
                },
              },
              (0, import_react45.createElement)(
                Field,
                { label: "任务时限（秒）" },
                (0, import_react45.createElement)(Input, {
                  name: "timeout",
                  type: "number",
                  min: 0,
                  max: 86400,
                  required: true,
                  defaultValue: preferences.rows[0].turnTimeoutSeconds,
                }),
              ),
              (0, import_react45.createElement)(
                "p",
                null,
                "0 表示不限制。时限包含等待确认的时间；达到时限后停止当前轮任务，适用于网页、团队、定时和消息渠道任务。",
              ),
              (0, import_react45.createElement)(
                Button,
                { type: "submit", disabled: busy },
                "保存运行设置",
              ),
            )
          : null,
        error || status.error || preferences.error
          ? (0, import_react45.createElement)(
              "p",
              { role: "alert" },
              friendlyError(error || status.error || preferences.error),
            )
          : null,
        notice
          ? (0, import_react45.createElement)("p", { role: "status" }, notice)
          : null,
        (0, import_react45.createElement)("h3", null, "使用帮助"),
        (0, import_react45.createElement)(
          "p",
          null,
          "在项目中创建对话，使用附件或 @ 文件引用资料。Shift + Enter 换行，Alt + ↑/↓ 找回历史输入，/ 打开命令与技能菜单。",
        ),
        (0, import_react45.createElement)(
          "p",
          null,
          "文件上传中断后，在文件栏的未完成上传中重新选择原文件继续。编辑冲突时保留你的草稿，重新打开文件核对后再保存。",
        ),
        (0, import_react45.createElement)(
          "p",
          null,
          "任务需要确认时可允许本次、拒绝或停止。开启桌面提醒后，后台完成和待确认时会提醒；浏览器需要授予通知权限。",
        ),
      );
    }

    // src/features/teams/page.js
    var import_react46 = __toESM(require("react"), 1);
    var import_react47 = require("react");
    function TeamsPage() {
      const { confirm, confirmation } = useConfirm();
      const endpoint2 = `${apiRoot}/teams`;
      const [state, refresh] = useResource(endpoint2);
      const [presets] = usePresets();
      const [workspaces] = useResource(`${apiRoot}/workspaces`);
      const [sessions] = useResource(`${apiRoot}/sessions`);
      const [details, setDetails] = import_react46.default.useState({});
      const [selectedTeam, setSelectedTeam] =
        import_react46.default.useState(null);
      const [teamAction, setTeamAction] = import_react46.default.useState(null);
      const [teamActionValue, setTeamActionValue] =
        import_react46.default.useState("");
      const [memberEngine, setMemberEngine] =
        import_react46.default.useState("codex");
      const [memberPresetId, setMemberPresetId] =
        import_react46.default.useState("");
      const [targetMemberId, setTargetMemberId] =
        import_react46.default.useState("");
      const [error, setError] = import_react46.default.useState("");
      import_react46.default.useEffect(() => {
        if (!selectedTeam || typeof EventSource === "undefined") return;
        const source = new EventSource(
          `${endpoint2}/${encodeURIComponent(selectedTeam.id)}/events`,
          { withCredentials: true },
        );
        const receive = (event) => {
          refresh();
          void loadDetails(selectedTeam);
          try {
            const next = JSON.parse(event.data);
            setDetails((value) => {
              const current = value[selectedTeam.id];
              if (
                !current ||
                current.events.some((item) => item.id === next.id)
              )
                return value;
              return {
                ...value,
                [selectedTeam.id]: {
                  ...current,
                  events: [...current.events, next],
                },
              };
            });
          } catch {}
        };
        for (const type of [
          "team.updated",
          "member.added",
          "member.renamed",
          "member.removed",
          "task.queued",
          "task.started",
          "task.completed",
          "task.failed",
          "task.cancelled",
          "mail.received",
        ])
          source.addEventListener(type, receive);
        return () => source.close();
      }, [selectedTeam]);
      const submit = async (event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        await mutate(refresh, setError, endpoint2, "POST", {
          name: String(values.get("name")),
          workspaceId: String(values.get("workspaceId")),
          lead: {
            name: String(values.get("lead")),
            engine: presets.rows.find(
              (row) => row.id === values.get("presetId"),
            )?.engine,
            presetId: String(values.get("presetId")),
          },
        });
      };
      const loadDetails = async (team) => {
        setSelectedTeam(team);
        try {
          const [tasks, messages, events] = await Promise.all(
            ["tasks", "messages", "events"].map((name) =>
              request(`${endpoint2}/${encodeURIComponent(team.id)}/${name}`),
            ),
          );
          setDetails((value) => ({
            ...value,
            [team.id]: { tasks, messages, events },
          }));
        } catch (reason) {
          setError(reason.message);
        }
      };
      const beginTeamAction = (kind, team) => {
        setTeamAction({ kind, team });
        setTeamActionValue("");
        setMemberEngine("codex");
        setMemberPresetId(team.members[0].presetId);
        setTargetMemberId(team.members[0].id);
      };
      const submitTeamAction = async (event) => {
        event.preventDefault();
        const value = teamActionValue.trim();
        if (!value || !teamAction) return;
        const { kind, team } = teamAction;
        const action = {
          member: {
            suffix: "members",
            refresh,
            body: {
              name: value,
              engine: memberEngine,
              presetId: memberPresetId,
            },
          },
          task: {
            suffix: "tasks",
            refresh: () => loadDetails(team),
            body: {
              memberId: targetMemberId,
              title: value,
              input: value,
            },
          },
          mail: {
            suffix: "messages",
            refresh: () => loadDetails(team),
            body: { fromMemberId: null, toMemberId: null, body: value },
          },
        }[kind];
        const saved = await mutate(
          action.refresh,
          setError,
          `${endpoint2}/${encodeURIComponent(team.id)}/${action.suffix}`,
          "POST",
          action.body,
        );
        if (saved) setTeamAction(null);
      };
      const cancelTask = (team, taskEntry) =>
        mutate(
          () => loadDetails(team),
          setError,
          `${endpoint2}/${encodeURIComponent(team.id)}/tasks/${encodeURIComponent(taskEntry.id)}/cancel`,
          "POST",
        );
      return (0, import_react47.createElement)(
        Section,
        { title: "团队" },
        confirmation,
        (0, import_react47.createElement)(
          "form",
          { className: "workagent-form", onSubmit: submit },
          ...[
            ["name", "团队名称"],
            ["lead", "负责人名称"],
          ].map(([name, label]) =>
            (0, import_react47.createElement)(
              Field,
              { label, key: name },
              (0, import_react47.createElement)(Input, {
                name,
                required: true,
              }),
            ),
          ),
          (0, import_react47.createElement)(
            Field,
            { label: "团队项目" },
            (0, import_react47.createElement)(Select, {
              name: "workspaceId",
              required: true,
              defaultValue: "",
              options: [
                ["", "选择项目"],
                ...workspaces.rows.map((row) => [row.id, row.name]),
              ],
            }),
          ),
          (0, import_react47.createElement)(
            Field,
            { label: "负责人助手" },
            (0, import_react47.createElement)(Select, {
              name: "presetId",
              required: true,
              defaultValue: "",
              options: [
                ["", "选择助手"],
                ...presets.rows
                  .filter((row) => row.enabled)
                  .map((row) => [row.id, row.name]),
              ],
            }),
          ),
          (0, import_react47.createElement)(
            "button",
            { type: "submit", className: "workagent-button" },
            "创建团队",
          ),
        ),
        error
          ? (0, import_react47.createElement)(
              "p",
              { role: "alert", className: "workagent-error" },
              error,
            )
          : null,
        (0, import_react47.createElement)(Status, { state }),
        ...state.rows.map((team, teamIndex) =>
          (0, import_react47.createElement)(
            Card,
            {
              key: `${team.id}-${teamIndex}`,
              title: team.name,
              detail: `${team.members.length} 位成员 · ${displayValue(team.sessionMode, "独立会话")}`,
            },
            (0, import_react47.createElement)(
              "div",
              { className: "workagent-team-members" },
              ...team.members.map((member, memberIndex) => {
                const session = sessions.rows.find(
                  (row) => row.id === member.sessionId,
                );
                return (0, import_react47.createElement)(
                  "article",
                  { key: member.id },
                  (0, import_react47.createElement)(
                    "strong",
                    null,
                    member.name,
                  ),
                  " · ",
                  member.role === "lead" ? "负责人" : "成员",
                  " · ",
                  displayValue(session?.activity?.state || member.status),
                  member.sessionId
                    ? (0, import_react47.createElement)(
                        "a",
                        {
                          href: `/?frontend=dsh&session=${encodeURIComponent(member.sessionId)}`,
                        },
                        "打开成员对话",
                      )
                    : null,
                  (0, import_react47.createElement)(
                    "form",
                    {
                      key: member.name,
                      className: "workagent-form",
                      onSubmit: (event) => {
                        event.preventDefault();
                        const name = String(
                          new FormData(event.currentTarget).get("name") || "",
                        ).trim();
                        if (name)
                          mutate(
                            refresh,
                            setError,
                            `${endpoint2}/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.id)}`,
                            "PATCH",
                            { name: name.trim() },
                          );
                      },
                    },
                    (0, import_react47.createElement)(
                      Field,
                      { label: "成员名称" },
                      (0, import_react47.createElement)(Input, {
                        name: "name",
                        defaultValue: member.name,
                        required: true,
                        maxLength: 120,
                      }),
                    ),
                    (0, import_react47.createElement)(
                      Button,
                      { type: "submit" },
                      "重命名成员",
                    ),
                  ),
                  member.role !== "lead"
                    ? (0, import_react47.createElement)(
                        Button,
                        {
                          disabled: member.status === "running",
                          onClick: async () => {
                            if (
                              await confirm({
                                description: `移除成员“${member.name}”？`,
                                danger: true,
                                confirmLabel: "移除成员",
                              })
                            )
                              mutate(
                                refresh,
                                setError,
                                `${endpoint2}/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.id)}`,
                                "DELETE",
                              );
                          },
                        },
                        "移除成员",
                      )
                    : null,
                  memberIndex > 1
                    ? (0, import_react47.createElement)(
                        Button,
                        {
                          onClick: () => {
                            const memberIds = team.members.map((row) => row.id);
                            [
                              memberIds[memberIndex - 1],
                              memberIds[memberIndex],
                            ] = [
                              memberIds[memberIndex],
                              memberIds[memberIndex - 1],
                            ];
                            mutate(
                              refresh,
                              setError,
                              `${endpoint2}/${encodeURIComponent(team.id)}`,
                              "PATCH",
                              { version: team.version, memberIds },
                            );
                          },
                        },
                        "上移成员",
                      )
                    : null,
                );
              }),
            ),
            (0, import_react47.createElement)(
              Button,
              { onClick: () => beginTeamAction("member", team) },
              "添加成员",
            ),
            (0, import_react47.createElement)(
              Button,
              { onClick: () => beginTeamAction("task", team) },
              "分派任务",
            ),
            (0, import_react47.createElement)(
              Button,
              { onClick: () => loadDetails(team) },
              "消息与动态",
            ),
            (0, import_react47.createElement)(
              Button,
              { onClick: () => beginTeamAction("mail", team) },
              "发送团队消息",
            ),
            details[team.id]
              ? (0, import_react47.createElement)(
                  "div",
                  { className: "workagent-stack" },
                  (0, import_react47.createElement)(
                    "span",
                    null,
                    `${details[team.id].tasks.length} 个任务 · ${details[team.id].messages.length} 条消息 · ${details[team.id].events.length} 条动态`,
                  ),
                  ...details[team.id].tasks.map((taskEntry) =>
                    (0, import_react47.createElement)(
                      "article",
                      { key: taskEntry.id },
                      (0, import_react47.createElement)(
                        "strong",
                        null,
                        `${taskEntry.title} · ${displayValue(taskEntry.status)}`,
                      ),
                      (0, import_react47.createElement)(
                        "p",
                        null,
                        `执行成员：${team.members.find((member) => member.id === taskEntry.memberId)?.name || "已移除成员"}`,
                      ),
                      taskEntry.result
                        ? (0, import_react47.createElement)(
                            Markdown,
                            null,
                            taskEntry.result,
                          )
                        : null,
                      taskEntry.error
                        ? (0, import_react47.createElement)(
                            "p",
                            { role: "alert" },
                            friendlyError(taskEntry.error),
                          )
                        : null,
                      taskEntry.sessionId
                        ? (0, import_react47.createElement)(
                            "a",
                            {
                              href: `/?frontend=dsh&session=${encodeURIComponent(taskEntry.sessionId)}`,
                            },
                            "查看执行对话",
                          )
                        : null,
                      (0, import_react47.createElement)(
                        Button,
                        {
                          key: `task-${taskEntry.id}`,
                          disabled: !["queued", "running"].includes(
                            taskEntry.status,
                          ),
                          onClick: () => cancelTask(team, taskEntry),
                        },
                        "取消任务",
                      ),
                    ),
                  ),
                  ...details[team.id].messages.map((message) =>
                    (0, import_react47.createElement)(
                      "span",
                      { key: `mail-${message.id}` },
                      message.body,
                    ),
                  ),
                  ...details[team.id].events.map((event) =>
                    (0, import_react47.createElement)(
                      "span",
                      {
                        key: `event-${event.id}`,
                        className: "workagent-muted",
                      },
                      displayValue(event.type),
                    ),
                  ),
                )
              : null,
          ),
        ),
        teamAction
          ? (0, import_react47.createElement)(
              "form",
              { className: "workagent-form", onSubmit: submitTeamAction },
              (0, import_react47.createElement)(
                Field,
                {
                  label: {
                    member: "成员名称",
                    task: "任务标题",
                    mail: "发送给团队的消息",
                  }[teamAction.kind],
                },
                (0, import_react47.createElement)(Input, {
                  "aria-label": "团队操作内容",
                  value: teamActionValue,
                  onChange: (event) => setTeamActionValue(event.target.value),
                  required: true,
                }),
              ),
              (0, import_react47.createElement)(
                Button,
                { type: "submit" },
                "确认",
              ),
              (0, import_react47.createElement)(
                Button,
                { onClick: () => setTeamAction(null) },
                "取消",
              ),
              teamAction.kind === "task"
                ? (0, import_react47.createElement)(
                    Field,
                    { label: "执行成员" },
                    (0, import_react47.createElement)(Select, {
                      value: targetMemberId,
                      onChange: (event) =>
                        setTargetMemberId(event.target.value),
                      options: teamAction.team.members.map((member) => [
                        member.id,
                        member.name,
                      ]),
                    }),
                  )
                : null,
              teamAction.kind === "member"
                ? (0, import_react47.createElement)(
                    import_react46.default.Fragment,
                    null,
                    (0, import_react47.createElement)(
                      Field,
                      { label: "成员引擎" },
                      (0, import_react47.createElement)(Select, {
                        "aria-label": "成员引擎",
                        value: memberEngine,
                        onChange: (event) => {
                          setMemberEngine(event.target.value);
                          setMemberPresetId("");
                        },
                        options: [
                          ["harness", "通用引擎"],
                          ["codex", "Codex"],
                          ["kimi", "Kimi"],
                        ],
                      }),
                    ),
                    (0, import_react47.createElement)(
                      Field,
                      { label: "成员助手" },
                      (0, import_react47.createElement)(Select, {
                        "aria-label": "成员助手",
                        value: memberPresetId,
                        onChange: (event) =>
                          setMemberPresetId(event.target.value),
                        required: true,
                        options: [
                          ["", "选择助手"],
                          ...presets.rows
                            .filter(
                              (row) =>
                                row.enabled && row.engine === memberEngine,
                            )
                            .map((row) => [row.id, row.name]),
                        ],
                      }),
                    ),
                  )
                : null,
            )
          : null,
      );
    }

    // src/app/shell.js
    var import_react48 = __toESM(require("react"), 1);
    var import_react49 = require("react");
    function BrandMark({ size = 28 }) {
      return (0, import_react49.createElement)(
        "span",
        {
          className: "workagent-brand-mark",
          style: {
            width: size,
            height: size,
          },
        },
        (0, import_react49.createElement)(
          "svg",
          {
            viewBox: "0 0 32 32",
            width: size,
            height: size,
            "aria-hidden": true,
          },
          (0, import_react49.createElement)("path", {
            d: "M7.2 7.4 10.5 23h3.2L16 13.5 18.3 23h3.2l3.3-15.6h-3.3l-1.9 10-2.2-10h-2.8l-2.2 10-1.9-10Z",
            fill: "currentColor",
          }),
        ),
      );
    }
    function BrandName() {
      return (0, import_react49.createElement)(
        "strong",
        { className: "workagent-brand-name" },
        "WorkAgent",
      );
    }
    var pages = {
      shared: SharedPage,
      teams: TeamsPage,
      assistants: PresetsSection,
      automations: AutomationsPage,
      notifications: NotificationsPage,
      workspaces: WorkspacesPage,
      marketplace: MarketplaceSection,
    };
    function WorkAgentOverlay() {
      const routeSearch = navigation.useSearch();
      const ctx = import_react48.default.useContext(RuntimeServices);
      const params = new URLSearchParams(routeSearch);
      const target = params.get("workagent");
      const sessionId2 = params.get("session");
      const personalDraft = sharedTaskProject(params);
      import_react48.default.useEffect(() => {
        if (!sessionId2 && (!target || personalDraft)) ctx?.sessions?.clear?.();
      }, [ctx, sessionId2, target, personalDraft]);
      const Page = pages[target];
      const pageRef = import_react48.default.useRef(null);
      import_react48.default.useLayoutEffect(() => {
        if (!Page || sessionId2 || personalDraft) return;
        return trackConversationScroll(
          pageRef.current,
          sidebarState(),
          createConversationCache(1),
          target,
          false,
        );
      }, [Page, target, sessionId2, personalDraft]);
      if (personalDraft || (!Page && !sessionId2)) return null;
      const labels = {
        shared: "协作",
        teams: "AI 团队",
        assistants: "助手",
        automations: "定时任务",
        notifications: "通知",
        workspaces: "项目",
        marketplace: "市场",
      };
      const label = sessionId2 || !Page ? "会话" : labels[target];
      return (0, import_react49.createElement)(
        "div",
        {
          role: "dialog",
          "aria-label": label,
          className: `workagent-overlay${target === "shared" && !sessionId2 ? " is-collaboration" : ""}`,
          ref: pageRef,
        },
        (0, import_react49.createElement)(
          "header",
          { className: "workagent-overlay-header" },
          (0, import_react49.createElement)("h1", null, label),
        ),
        (0, import_react49.createElement)(
          "main",
          { className: "workagent-overlay-content" },
          sessionId2
            ? (0, import_react49.createElement)(ConversationWorkspace, {
                key: sessionId2,
                sessionId: sessionId2,
              })
            : (0, import_react49.createElement)(Page, { key: target }),
        ),
      );
    }
    function FooterAction({ wide, kind, theme }) {
      if (kind === "notifications")
        return (0, import_react49.createElement)(NotificationFooter, { wide });
      const navigate = (page) => () =>
        navigation.navigate(`/?workagent=${page}`);
      const actions = {
        teams: ["AI 团队", navigate("teams")],
        shared: ["共享项目", navigate("shared")],
        assistants: ["助手", navigate("assistants")],
        tasks: ["定时任务", navigate("automations")],
        chatgpt: [
          "聊天模式",
          () =>
            location.assign(localStorage.getItem(CHAT_PAGE_KEY) || "/chatgpt/"),
        ],
        workspace: ["项目", navigate("workspaces")],
        theme: [
          "主题",
          () => {
            const current = theme.getTheme();
            const next =
              (current.preference || current.resolved) === "dark"
                ? "light"
                : "dark";
            theme.setTheme(next);
          },
        ],
        logout: [
          "退出登录",
          async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            workbench.clearDrafts();
            location.assign("/");
          },
        ],
      };
      const [label, action] = actions[kind];
      return (0, import_react49.createElement)(
        "button",
        {
          type: "button",
          className: "workagent-footer",
          "data-kind": kind,
          title: label,
          "aria-label": label,
          onClick: action,
        },
        (0, import_react49.createElement)(Icon, { name: kind }),
        wide ? (0, import_react49.createElement)("span", null, label) : null,
      );
    }

    // src/features/conversations/sidebar.js
    var import_react50 = __toESM(require("react"), 1);
    var import_react51 = require("react");
    function SidebarSessions() {
      const { confirm, confirmation } = useConfirm();
      const routeSearch = navigation.useSearch();
      const [workspaceState, reloadWorkspaces] = useResource(
        `${apiRoot}/workspaces`,
      );
      const [sessionState, reloadSessions] = useResource(
        `${apiRoot}/sessions`,
        (value) =>
          (Array.isArray(value) ? value : [])
            .slice()
            .sort((left, right) =>
              right.updatedAt.localeCompare(left.updatedAt),
            ),
      );
      const [teamState, reloadTeams] = useResource(`${apiRoot}/teams`);
      const pins = workbench.usePins();
      const projectPins = workbench.usePins("workagent.project-pins.v1");
      const [batchMode, setBatchMode] = import_react50.default.useState(false);
      const [selectedIds, setSelectedIds] = import_react50.default.useState([]);
      const [batchBusy, setBatchBusy] = import_react50.default.useState(false);
      const [batchError, setBatchError] = import_react50.default.useState("");
      async function deleteSelected() {
        if (
          !selectedIds.length ||
          !(await confirm(`删除选中的 ${selectedIds.length} 个对话及消息？`))
        )
          return;
        setBatchBusy(true);
        const failed = [];
        for (const id of selectedIds) {
          try {
            await request(`${apiRoot}/sessions/${encodeURIComponent(id)}`, {
              method: "DELETE",
            });
          } catch (reason) {
            failed.push({ id, error: friendlyError(reason.message) });
          }
        }
        setSelectedIds(failed.map((item) => item.id));
        setBatchError(
          failed.length
            ? failed
                .map(
                  (item) =>
                    `${sessionState.rows.find((row) => row.id === item.id)?.title || item.id}：${item.error}`,
                )
                .join("；")
            : "",
        );
        setBatchBusy(false);
        reloadSessions();
        if (
          selectedIds.includes(activeSession) &&
          !failed.some((item) => item.id === activeSession)
        )
          navigation.navigate("/?frontend=dsh");
      }
      const [query, setQuery] = import_react50.default.useState("");
      const [searching, setSearching] = import_react50.default.useState(false);
      const [collapsed, setCollapsed] = import_react50.default.useState({});
      const [sectionsCollapsed, setSectionsCollapsed] =
        import_react50.default.useState(() => ({
          projects:
            localStorage.getItem("workagent.sidebar.projects-collapsed") ===
            "true",
          sessions:
            localStorage.getItem("workagent.sidebar.sessions-collapsed") ===
            "true",
        }));
      const sectionToggle = (section, label) =>
        (0, import_react51.createElement)(
          "button",
          {
            type: "button",
            className: "workagent-sidebar-section-toggle",
            "aria-label": `${sectionsCollapsed[section] ? "展开" : "收起"}${label}`,
            "aria-expanded": !sectionsCollapsed[section],
            onClick: () => {
              const next = !sectionsCollapsed[section];
              localStorage.setItem(
                `workagent.sidebar.${section}-collapsed`,
                String(next),
              );
              setSectionsCollapsed((value) => ({ ...value, [section]: next }));
              if (section === "projects" && next) {
                setSearching(false);
                setQuery("");
              }
            },
          },
          (0, import_react51.createElement)(Icon, {
            name: sectionsCollapsed[section] ? "chevronRight" : "chevronDown",
            size: 13,
          }),
          (0, import_react51.createElement)("span", null, label),
        );
      const [action, setAction] = import_react50.default.useState(null);
      const [actionBusy, setActionBusy] =
        import_react50.default.useState(false);
      const [sessionMenu, setSessionMenu] =
        import_react50.default.useState(null);
      const [projectMenu, setProjectMenu] =
        import_react50.default.useState(null);
      const [reminderSession, setReminderSession] =
        import_react50.default.useState(null);
      const [actionValue, setActionValue] = import_react50.default.useState("");
      const [error, setError] = import_react50.default.useState("");
      const activeSession = new URLSearchParams(routeSearch).get("session");
      import_react50.default.useEffect(() => {
        const closeOnEscape = (event) => {
          if (
            event.key === "Escape" &&
            window.innerWidth <= 760 &&
            !document.querySelector('[role="dialog"]')
          )
            closeMobileSidebar2();
        };
        window.addEventListener("keydown", closeOnEscape);
        return () => window.removeEventListener("keydown", closeOnEscape);
      }, []);
      const [, setSeenRevision] = import_react50.default.useState(0);
      const openedSession = import_react50.default.useRef(null);
      const markSeen = (session) => {
        if (session.lastTurn)
          localStorage.setItem(
            SESSION_SEEN_PREFIX + session.id,
            session.lastTurn.id,
          );
        setSeenRevision((value) => value + 1);
      };
      import_react50.default.useEffect(() => {
        const session = sessionState.rows.find(
          (item) => item.id === activeSession,
        );
        if (!session || openedSession.current === activeSession) return;
        openedSession.current = activeSession;
        markSeen(session);
      }, [sessionState.rows, activeSession]);
      import_react50.default.useEffect(() => {
        let disposed = false;
        let timer;
        let pending = false;
        let rerun = false;
        const update = async () => {
          clearTimeout(timer);
          if (disposed) return;
          if (pending) {
            rerun = true;
            return;
          }
          pending = true;
          try {
            await reloadSessions();
          } finally {
            pending = false;
            if (!disposed) {
              timer = setTimeout(update, rerun ? 0 : 2500);
              rerun = false;
            }
          }
        };
        const syncSeen = (event) => {
          if (event.key === null || event.key?.startsWith(SESSION_SEEN_PREFIX))
            setSeenRevision((value) => value + 1);
        };
        timer = setTimeout(update, 2500);
        window.addEventListener(SESSIONS_CHANGED_EVENT, update);
        window.addEventListener("focus", update);
        window.addEventListener("storage", syncSeen);
        document.addEventListener("visibilitychange", update);
        return () => {
          disposed = true;
          clearTimeout(timer);
          window.removeEventListener(SESSIONS_CHANGED_EVENT, update);
          window.removeEventListener("focus", update);
          window.removeEventListener("storage", syncSeen);
          document.removeEventListener("visibilitychange", update);
        };
      }, [reloadSessions]);
      import_react50.default.useEffect(() => {
        const update = () => void reloadWorkspaces();
        window.addEventListener(PROJECTS_CHANGED_EVENT, update);
        return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, update);
      }, [reloadWorkspaces]);
      const sessions = sessionState.rows
        .filter(
          (session) =>
            session.branchKind !== "side_chat" &&
            !session.workspaceId?.startsWith("shared:"),
        )
        .slice()
        .sort((a, b) => {
          const left = pins.pins.indexOf(a.id),
            right = pins.pins.indexOf(b.id);
          return (left < 0 ? Infinity : left) - (right < 0 ? Infinity : right);
        })
        .filter(
          (session) =>
            !/^Reply exactly with legacy-message-\d+$/i.test(session.title),
        )
        .filter((session) =>
          displaySessionTitle(session.title)
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
        );
      const selectProject = (project) => {
        localStorage.setItem(WORKSPACE_PICK_KEY, project.id);
        window.dispatchEvent(
          new window.CustomEvent(HERO_WORKSPACE_EVENT, {
            detail: project.id,
          }),
        );
      };
      const toggleSearch = () => {
        if (searching) setQuery("");
        setSearching(!searching);
      };
      const beginAction = (kind, target) => {
        setAction({ kind, target });
        setActionValue(
          kind === "rename-project"
            ? displayWorkspaceName(target.name)
            : kind === "rename-session"
              ? displaySessionTitle(target.title)
              : "",
        );
        setError("");
      };
      const submitAction = async (event) => {
        event.preventDefault();
        if (!action || actionBusy) return;
        setActionBusy(true);
        try {
          if (action.kind === "rename-project") {
            await request(
              `${apiRoot}/workspaces/${encodeURIComponent(action.target.id)}`,
              {
                method: "PATCH",
                body: JSON.stringify({ name: actionValue.trim() }),
              },
            );
            await reloadWorkspaces();
            announceProjectsChanged();
          } else if (action.kind === "rename-session") {
            await request(
              `${apiRoot}/sessions/${encodeURIComponent(action.target.id)}`,
              {
                method: "PATCH",
                body: JSON.stringify({ title: actionValue.trim() }),
              },
            );
            await reloadSessions();
          } else if (action.kind === "delete-session") {
            await request(
              `${apiRoot}/sessions/${encodeURIComponent(action.target.id)}`,
              { method: "DELETE" },
            );
            await reloadSessions();
            if (activeSession === action.target.id)
              navigation.navigate("/?frontend=dsh");
          } else if (action.kind === "delete-project") {
            const relatedSessions = sessionState.rows.filter(
              (session) => session.workspaceId === action.target.id,
            );
            const relatedTeams = teamState.rows.filter(
              (team) => team.workspaceId === action.target.id,
            );
            await Promise.all(
              relatedSessions.map((session) =>
                request(
                  `${apiRoot}/sessions/${encodeURIComponent(session.id)}`,
                  {
                    method: "DELETE",
                  },
                ),
              ),
            );
            await Promise.all(
              relatedTeams.map((team) =>
                request(`${apiRoot}/teams/${encodeURIComponent(team.id)}`, {
                  method: "DELETE",
                }),
              ),
            );
            await request(
              `${apiRoot}/workspaces/${encodeURIComponent(action.target.id)}`,
              { method: "DELETE" },
            );
            await Promise.all([
              reloadWorkspaces(),
              reloadSessions(),
              reloadTeams(),
            ]);
            announceProjectsChanged();
            if (relatedSessions.some((session) => session.id === activeSession))
              navigation.navigate("/?frontend=dsh");
          }
          setAction(null);
        } catch (cause) {
          setError(friendlyError(cause.message));
        } finally {
          setActionBusy(false);
        }
      };
      const projectRows = sortProjectsByChat(
        workspaceState.rows,
        sessionState.rows,
        projectPins.pins,
      );
      const projectIds = new Set(projectRows.map((project) => project.id));
      const unassignedSessions = sessions.filter(
        (session) => !projectIds.has(session.workspaceId),
      );
      const renderSession = (session) => {
        const running = ["running", "retrying"].includes(
          session.activity?.state,
        );
        const unread =
          session.lastTurn &&
          localStorage.getItem(SESSION_SEEN_PREFIX + session.id) !==
            session.lastTurn.id;
        const status = running
          ? "正在运行"
          : unread
            ? session.lastTurn.status === "failed"
              ? "运行失败，未读"
              : session.lastTurn.status === "cancelled"
                ? "已停止，未读"
                : "已完成，未读"
            : "";
        return (0, import_react51.createElement)(SidebarRow, {
          key: session.id,
          title: displaySessionTitle(session.title),
          icon: (0, import_react51.createElement)(SessionAvatar, { session }),
          selected: session.id === activeSession,
          status: (0, import_react51.createElement)(SidebarStatus, {
            running,
            unread,
            label: status,
          }),
          onOpen: () => {
            markSeen(session);
            navigation.navigate(`/?session=${encodeURIComponent(session.id)}`);
          },
          rowProps: {
            draggable: pins.pins.includes(session.id),
            onDragStart: (event) =>
              event.dataTransfer.setData("text/workagent-session", session.id),
            onDragOver: (event) => {
              if (pins.pins.includes(session.id)) event.preventDefault();
            },
            onDrop: (event) => {
              event.preventDefault();
              pins.move(
                event.dataTransfer.getData("text/workagent-session"),
                session.id,
              );
            },
          },
          leading: batchMode
            ? (0, import_react51.createElement)("input", {
                type: "checkbox",
                "aria-label": `选择对话 ${displaySessionTitle(session.title)}`,
                checked: selectedIds.includes(session.id),
                disabled: batchBusy,
                onChange: (event) =>
                  setSelectedIds((ids) =>
                    event.target.checked
                      ? [...ids, session.id]
                      : ids.filter((id) => id !== session.id),
                  ),
              })
            : null,
          actions: (0, import_react51.createElement)(
            import_react50.default.Fragment,
            null,
            (0, import_react51.createElement)(SidebarAction, {
              icon: "pin",
              label: `${pins.pins.includes(session.id) ? "取消置顶" : "置顶"} ${displaySessionTitle(session.title)}`,
              "aria-pressed": pins.pins.includes(session.id),
              onClick: () => pins.toggle(session.id),
            }),
            (0, import_react51.createElement)(SidebarAction, {
              label: `编辑对话 ${displaySessionTitle(session.title)}`,
              title: "对话操作",
              "aria-haspopup": "dialog",
              onClick: () => setSessionMenu(session),
            }),
          ),
        });
      };
      return (0, import_react51.createElement)(
        "div",
        { className: "workagent-sidebar-browser" },
        confirmation,
        (0, import_react51.createElement)(workbench.Notifications, {
          sessions: sessionState.rows,
          settings: false,
        }),
        (0, import_react51.createElement)("button", {
          type: "button",
          className: "workagent-mobile-backdrop",
          "aria-label": "收起导航菜单",
          tabIndex: -1,
          onClick: closeMobileSidebar2,
        }),
        (0, import_react51.createElement)(
          SidebarHeader,
          { heading: sectionToggle("projects", "项目") },
          (0, import_react51.createElement)(
            "div",
            { className: "workagent-batch-actions" },
            (0, import_react51.createElement)(
              Button,
              {
                disabled: batchBusy,
                "aria-label": batchMode ? "结束多选" : "多选对话",
                title: batchMode ? "结束多选" : "多选对话",
                "aria-pressed": batchMode,
                onClick: () => {
                  setBatchMode((value) => !value);
                  setSelectedIds([]);
                  setBatchError("");
                },
              },
              (0, import_react51.createElement)(Icon, {
                name: batchMode ? "close" : "list",
                size: 15,
              }),
            ),
            batchMode
              ? (0, import_react51.createElement)(
                  import_react50.default.Fragment,
                  null,
                  (0, import_react51.createElement)(
                    Button,
                    {
                      disabled: batchBusy,
                      onClick: () =>
                        setSelectedIds(sessions.map((row) => row.id)),
                    },
                    "全选当前列表",
                  ),
                  (0, import_react51.createElement)(
                    Button,
                    {
                      disabled: batchBusy || !selectedIds.length,
                      onClick: deleteSelected,
                    },
                    batchBusy ? "删除中…" : `删除选中（${selectedIds.length}）`,
                  ),
                )
              : null,
            batchError
              ? (0, import_react51.createElement)(
                  "p",
                  { role: "alert", className: "workagent-error" },
                  batchError,
                )
              : null,
          ),
          sectionsCollapsed.projects
            ? null
            : (0, import_react51.createElement)(
                "div",
                { className: "workagent-sidebar-heading-actions" },
                (0, import_react51.createElement)(
                  "button",
                  {
                    type: "button",
                    "aria-label": searching ? "关闭搜索" : "搜索对话",
                    title: searching ? "关闭搜索" : "搜索对话",
                    "aria-pressed": searching,
                    onClick: toggleSearch,
                  },
                  (0, import_react51.createElement)(Icon, {
                    name: searching ? "close" : "search",
                    size: 15,
                  }),
                ),
                (0, import_react51.createElement)(
                  "button",
                  {
                    type: "button",
                    "aria-label": "管理项目",
                    title: "管理项目",
                    onClick: () =>
                      navigation.navigate("/?workagent=workspaces"),
                  },
                  (0, import_react51.createElement)(Icon, {
                    name: "plus",
                    size: 15,
                  }),
                ),
              ),
        ),
        searching
          ? (0, import_react51.createElement)(SidebarSearch, {
              "aria-label": "搜索对话",
              value: query,
              onChange: (event) => setQuery(event.target.value),
              placeholder: "搜索对话…",
              autoFocus: true,
            })
          : null,
        (0, import_react51.createElement)(
          "div",
          { className: "workagent-sidebar-projects" },
          workspaceState.loading && !sectionsCollapsed.projects
            ? (0, import_react51.createElement)(
                "span",
                { className: "workagent-sidebar-empty" },
                "加载中…",
              )
            : null,
          ...(sectionsCollapsed.projects ? [] : projectRows).map((project) => {
            const projectSessions = sessions.filter(
              (session) => session.workspaceId === project.id,
            );
            const isCollapsed = Boolean(collapsed[project.id]);
            return (0, import_react51.createElement)(
              SidebarGroup,
              {
                key: project.id,
                title: displayWorkspaceName(project.name),
                icon: (0, import_react51.createElement)(Icon, {
                  name: "workspace",
                  size: 15,
                }),
                expanded: !isCollapsed,
                onToggle: () => {
                  selectProject(project);
                  setCollapsed((value) => ({
                    ...value,
                    [project.id]: !value[project.id],
                  }));
                },
                pinned: projectPins.pins.includes(project.id),
                badge:
                  project.scope === "team"
                    ? (0, import_react51.createElement)("small", null, "共享")
                    : null,
                actions: (0, import_react51.createElement)(
                  import_react50.default.Fragment,
                  null,
                  (0, import_react51.createElement)(SidebarAction, {
                    icon: "plus",
                    label: `在 ${displayWorkspaceName(project.name)} 中新建会话`,
                    title: "在此项目中新建会话",
                    onClick: () => startProjectConversation(project),
                  }),
                  (0, import_react51.createElement)(SidebarAction, {
                    label: `项目操作 ${displayWorkspaceName(project.name)}`,
                    "aria-haspopup": "dialog",
                    title: "置顶或管理项目",
                    onClick: () => setProjectMenu(project),
                  }),
                ),
              },
              projectSessions.length === 0
                ? (0, import_react51.createElement)(
                    "span",
                    { className: "workagent-sidebar-empty" },
                    query ? "没有匹配的对话" : "暂无对话",
                  )
                : projectSessions.map(renderSession),
            );
          }),
          (0, import_react51.createElement)(
            "section",
            { className: "workagent-sidebar-unassigned" },
            (0, import_react51.createElement)(
              "div",
              { className: "workagent-sidebar-subheading" },
              sectionToggle("sessions", "对话"),
            ),
            sectionsCollapsed.sessions
              ? null
              : (0, import_react51.createElement)(
                  "div",
                  {
                    className:
                      "workagent-sidebar-project-sessions workagent-sidebar-standalone",
                  },
                  ...unassignedSessions.map(renderSession),
                ),
          ),
        ),
        sessionState.loading && !sectionsCollapsed.sessions
          ? (0, import_react51.createElement)(
              "span",
              { className: "workagent-sidebar-empty" },
              "加载中…",
            )
          : null,
        error && !action?.kind.endsWith("-session")
          ? (0, import_react51.createElement)(
              "span",
              { role: "alert", className: "workagent-error" },
              error,
            )
          : null,
        sessionMenu
          ? (0, import_react51.createElement)(ConversationMenu, {
              title: displaySessionTitle(sessionMenu.title),
              projectName: displayWorkspaceName(
                workspaceState.rows.find(
                  (workspace) => workspace.id === sessionMenu.workspaceId,
                )?.name || "未归属",
              ),
              pinned: pins.pins.includes(sessionMenu.id),
              onPin: () => {
                pins.toggle(sessionMenu.id);
                setSessionMenu(null);
              },
              onReminder: () => {
                setReminderSession(sessionMenu);
                setSessionMenu(null);
              },
              onManage: () => {
                const target = sessionMenu;
                setSessionMenu(null);
                beginAction("rename-session", target);
              },
              onClose: () => setSessionMenu(null),
            })
          : null,
        projectMenu
          ? (0, import_react51.createElement)(
              Dialog,
              {
                title: displayWorkspaceName(projectMenu.name),
                "aria-label": "项目操作",
                onClose: () => setProjectMenu(null),
              },
              (0, import_react51.createElement)(
                ActionList,
                null,
                (0, import_react51.createElement)(
                  Button,
                  {
                    onClick: () => {
                      projectPins.toggle(projectMenu.id);
                      setProjectMenu(null);
                    },
                  },
                  (0, import_react51.createElement)(Icon, { name: "pin" }),
                  projectPins.pins.includes(projectMenu.id)
                    ? "取消置顶"
                    : "置顶项目",
                ),
                (0, import_react51.createElement)(
                  Button,
                  {
                    onClick: () => {
                      const target = projectMenu;
                      setProjectMenu(null);
                      beginAction("rename-project", target);
                    },
                  },
                  (0, import_react51.createElement)(Icon, { name: "edit" }),
                  "管理",
                ),
              ),
            )
          : null,
        reminderSession
          ? (0, import_react51.createElement)(
              Dialog,
              { title: "消息提醒", onClose: () => setReminderSession(null) },
              (0, import_react51.createElement)(
                "small",
                null,
                `项目：${displayWorkspaceName(workspaceState.rows.find((workspace) => workspace.id === reminderSession.workspaceId)?.name || "未归属")} · 对话：${displaySessionTitle(reminderSession.title)}`,
              ),
              (0, import_react51.createElement)(workbench.SessionReminder, {
                sessionId: reminderSession.id,
                onSaved: () => setReminderSession(null),
              }),
            )
          : null,
        action?.kind.endsWith("-session")
          ? (0, import_react51.createElement)(ConversationManagementDialog, {
              name: actionValue,
              onNameChange: setActionValue,
              onSave: submitAction,
              onDelete: submitAction,
              onRequestDelete: () =>
                beginAction("delete-session", action.target),
              onClose: () => setAction(null),
              busy: actionBusy,
              error,
              deleting: action.kind === "delete-session",
            })
          : action
            ? (0, import_react51.createElement)(
                Dialog,
                {
                  title: action.kind.startsWith("rename")
                    ? "重命名"
                    : "确认删除",
                  as: "form",
                  onClose: () => setAction(null),
                  onSubmit: submitAction,
                },
                action.kind.startsWith("rename")
                  ? (0, import_react51.createElement)(Input, {
                      autoFocus: true,
                      value: actionValue,
                      onChange: (event) => setActionValue(event.target.value),
                      required: true,
                      maxLength: 120,
                    })
                  : (0, import_react51.createElement)(
                      "p",
                      null,
                      action.kind === "delete-project"
                        ? "项目及其对话将移入可恢复的回收目录。"
                        : "删除后，这个对话将不再显示。",
                    ),
                (0, import_react51.createElement)(
                  "div",
                  { className: "workagent-actions" },
                  (0, import_react51.createElement)(
                    Button,
                    {
                      type: "submit",
                      disabled:
                        action.kind.startsWith("rename") && !actionValue.trim(),
                    },
                    action.kind.startsWith("rename") ? "保存" : "删除",
                  ),
                  action.kind.startsWith("rename")
                    ? (0, import_react51.createElement)(
                        Button,
                        {
                          className: "workagent-button is-danger",
                          onClick: () =>
                            beginAction(
                              action.kind === "rename-project"
                                ? "delete-project"
                                : "delete-session",
                              action.target,
                            ),
                        },
                        "删除",
                      )
                    : null,
                  (0, import_react51.createElement)(
                    Button,
                    { onClick: () => setAction(null) },
                    "取消",
                  ),
                ),
              )
            : null,
      );
    }

    // src/app/sidebar.js
    var import_react52 = __toESM(require("react"), 1);
    var import_react53 = require("react");
    var sidebarUI = {
      Row: SidebarRow,
      Group: SidebarGroup,
      Header: SidebarHeader,
      Action: SidebarAction,
      Search: SidebarSearch,
      Status: SidebarStatus,
      Dialog,
      ActionList,
    };
    var sidebarTabs = /* @__PURE__ */ (() => {
      let tabs = [];
      const listeners = /* @__PURE__ */ new Set();
      return {
        version: 1,
        officialTree: SidebarSessions,
        sessionFilters: [],
        getTabs: () => tabs,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        insert: (tab) => {
          tabs = [...tabs.filter((row) => row.id !== tab.id), tab].sort(
            (a, b) => (a.order || 0) - (b.order || 0),
          );
          listeners.forEach((listener) => listener());
          return () => {
            tabs = tabs.filter((row) => row !== tab);
            listeners.forEach((listener) => listener());
          };
        },
        addSessionFilter: () => () => {},
      };
    })();
    function CollaborationSidebar(props) {
      const search = navigation.useSearch();
      const state = SharedPage.useShared();
      const tabs = import_react52.default.useSyncExternalStore(
        sidebarTabs.subscribe,
        sidebarTabs.getTabs,
      );
      const params = new URLSearchParams(search);
      const tab =
        params.get("workagent") === "shared"
          ? "shared"
          : params.get("sidebar") || "tasks";
      const count = state.invites.filter(
        (invite) => invite.status === "pending",
      ).length;
      const extra = tabs.find((item) => item.id === tab);
      return (0, import_react53.createElement)(
        "div",
        { className: "workagent-sidebar-sections" },
        (0, import_react53.createElement)(
          "nav",
          { className: "workagent-sidebar-tabs", "aria-label": "工作区分类" },
          ...[
            { id: "tasks", label: "任务" },
            ...tabs,
            { id: "shared", label: `协作${count ? ` ${count}` : ""}` },
          ].map((item) =>
            (0, import_react53.createElement)(
              "button",
              {
                key: item.id,
                type: "button",
                "aria-current": tab === item.id ? "page" : void 0,
                onClick: () =>
                  navigation.navigate(
                    item.id === "shared"
                      ? SharedPage.route()
                      : `/?sidebar=${encodeURIComponent(item.id)}`,
                  ),
              },
              item.label,
            ),
          ),
        ),
        tab === "shared"
          ? (0, import_react53.createElement)(SharedPage.Sidebar)
          : extra
            ? extra.render({ ...props, sidebarUI })
            : (0, import_react53.createElement)(SidebarSessions, props),
      );
    }
    CollaborationSidebar.__dshNativeTabHost = true;
    CollaborationSidebar.__dshNativeTabs = sidebarTabs;

    // src/features/agents/model-defaults.js
    var import_react54 = __toESM(require("react"), 1);
    var import_react55 = require("react");
    var MODEL_DEFAULTS_KEY = "workagent.model-defaults.v1";
    var MODEL_DEFAULTS_EVENT = "workagent:model-defaults";
    var permissionOptions = [
      ["read_only", "只读"],
      ["workspace_write", "项目内读写"],
      ["full_access", "完全访问"],
    ];
    var readModelDefaults = () => localStorage.getItem(MODEL_DEFAULTS_KEY);
    var subscribeModelDefaults = (listener) => {
      const onStorage = (event) => {
        if (event.key === MODEL_DEFAULTS_KEY || event.key === null) listener();
      };
      window.addEventListener("storage", onStorage);
      window.addEventListener(MODEL_DEFAULTS_EVENT, listener);
      return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(MODEL_DEFAULTS_EVENT, listener);
      };
    };
    function parseModelDefaults(raw) {
      try {
        const value = JSON.parse(raw);
        if (value && typeof value === "object" && !Array.isArray(value))
          return value;
      } catch {}
      return {};
    }
    function useModelDefaults() {
      const raw = import_react54.default.useSyncExternalStore(
        subscribeModelDefaults,
        readModelDefaults,
      );
      return [
        parseModelDefaults(raw),
        (key, value) => {
          const saved = parseModelDefaults(readModelDefaults());
          localStorage.setItem(
            MODEL_DEFAULTS_KEY,
            JSON.stringify({
              ...saved,
              [key]: { ...saved[key], ...value },
            }),
          );
          window.dispatchEvent(new window.Event(MODEL_DEFAULTS_EVENT));
        },
        raw,
      ];
    }
    function defaultEffort(engine, model) {
      const options = model?.reasoning || [];
      if (engine === "codex" && options.some((option) => option.id === "low"))
        return "low";
      if (engine === "kimi") {
        const lowest = [
          "off",
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
          "ultra",
        ].find((id) => options.some((option) => option.id === id));
        return lowest || options[0]?.id || "";
      }
      return (
        options.find((option) => option.id === model?.defaultReasoning)?.id ||
        options[0]?.id ||
        ""
      );
    }
    var modelDefaultsKey = (group, preset) =>
      preset?.source === "user"
        ? `assistant:${preset.id}:${preset.engine}`
        : group?.engine;
    function resolveModelDefaults(group, preferences, preset) {
      const models = group?.models || [];
      const saved = preferences[modelDefaultsKey(group, preset)];
      const preferred =
        group?.engine === "codex"
          ? ["gpt-6-astra"]
          : group?.engine === "kimi"
            ? ["kimi-code/kimi-k3", "kimi-k3", "k3"]
            : [];
      const model =
        models.find((model2) => model2.id === saved?.modelId) ||
        models.find((model2) => model2.id === preset?.modelId) ||
        models.find((model2) => preferred.includes(model2.id)) ||
        models.find((model2) => model2.isDefault) ||
        models[0];
      return {
        modelId: model?.id || "",
        thinkingEffort:
          model?.id === saved?.modelId &&
          model?.reasoning.some((option) => option.id === saved.thinkingEffort)
            ? saved.thinkingEffort
            : defaultEffort(group?.engine, model),
        permissionMode: permissionOptions.some(
          ([id]) => id === saved?.permissionMode,
        )
          ? saved.permissionMode
          : "workspace_write",
      };
    }
    function ModelDefaultsFields({ group, preset, defaults, save }) {
      const model = group.models.find(
        (model2) => model2.id === defaults.modelId,
      );
      const name = preset
        ? displayPresetName(preset.name)
        : displayValue(group.engine);
      const key = modelDefaultsKey(group, preset);
      const field = (label, props) =>
        (0, import_react55.createElement)(
          "label",
          null,
          (0, import_react55.createElement)("span", null, label),
          (0, import_react55.createElement)(Select, {
            "aria-label": `${name} ${label}`,
            ...props,
          }),
        );
      return (0, import_react55.createElement)(
        "div",
        { className: "workagent-model-defaults" },
        field("默认模型", {
          value: defaults.modelId,
          disabled: !group.models.length,
          options: group.models.length
            ? group.models.map((model2) => [model2.id, model2.name])
            : [["", "暂无可用模型"]],
          onChange: (event) => {
            const next = group.models.find(
              (model2) => model2.id === event.target.value,
            );
            save(key, {
              modelId: next.id,
              thinkingEffort: defaultEffort(group.engine, next),
            });
          },
        }),
        field("默认思考强度", {
          value: defaults.thinkingEffort,
          disabled: !model?.reasoning.length,
          options: model?.reasoning.length
            ? model.reasoning.map((option) => [
                option.id,
                reasoningLabel(option),
              ])
            : [["", "未提供思考选项"]],
          onChange: (event) =>
            save(key, {
              modelId: defaults.modelId,
              thinkingEffort: event.target.value,
            }),
        }),
        field("默认权限", {
          value: defaults.permissionMode,
          options: permissionOptions,
          onChange: (event) =>
            save(key, {
              permissionMode: event.target.value,
            }),
        }),
      );
    }

    // src/features/agents/models.js
    var import_react56 = require("react");
    function ModelsSection() {
      const [state] = useResource(`${apiRoot}/model-options`);
      const [presets] = usePresets();
      const [preferences, save] = useModelDefaults();
      const groups = [
        ...presets.rows
          .filter((preset) => preset.source === "user")
          .map((preset) => ({
            preset,
            group: state.rows.find(
              (group) => group.engine === preset.engine,
            ) || {
              engine: preset.engine,
              state: "unavailable",
              models: [],
            },
          })),
        ...state.rows.map((group) => ({ group })),
      ];
      return (0, import_react56.createElement)(
        Section,
        { title: "模型" },
        (0, import_react56.createElement)(
          "div",
          { className: "workagent-section-intro" },
          (0, import_react56.createElement)(
            "p",
            null,
            "为各助手设置新对话的默认模型、思考强度和权限。更改自动保存在当前浏览器；输入框的临时选择不会修改默认值。模型列表每次打开网页时自动更新。",
          ),
        ),
        (0, import_react56.createElement)(Status, { state }),
        presets.loading || presets.error
          ? (0, import_react56.createElement)(Status, { state: presets })
          : null,
        ...groups.map(({ group, preset }) =>
          (0, import_react56.createElement)(
            "section",
            {
              key: preset?.id || group.engine,
              className: "workagent-model-group",
              "data-preset-id": preset?.id,
            },
            (0, import_react56.createElement)(
              "header",
              null,
              (0, import_react56.createElement)(AssistantAvatar, {
                preset: preset || { engine: group.engine },
              }),
              (0, import_react56.createElement)(
                "strong",
                null,
                preset
                  ? displayPresetName(preset.name)
                  : displayValue(group.engine),
              ),
              preset
                ? (0, import_react56.createElement)(
                    "span",
                    { className: "workagent-muted" },
                    `${displayValue(group.engine)}${preset.enabled ? "" : " · 已关闭"}`,
                  )
                : null,
              (0, import_react56.createElement)(
                "span",
                { className: `workagent-status-pill is-${group.state}` },
                group.state === "ready"
                  ? `已获取 ${group.models.length} 个模型`
                  : group.state === "empty"
                    ? "暂无模型"
                    : "暂时无法获取",
              ),
            ),
            (0, import_react56.createElement)(ModelDefaultsFields, {
              group,
              preset,
              defaults: resolveModelDefaults(group, preferences, preset),
              save,
            }),
            group.state !== "ready"
              ? (0, import_react56.createElement)(
                  "p",
                  { className: "workagent-muted" },
                  "请检查助手的连接与授权后重新打开网页。",
                )
              : null,
            ...(preset ? [] : group.models).map((model) =>
              (0, import_react56.createElement)(
                "article",
                { key: model.id, className: "workagent-model-row" },
                (0, import_react56.createElement)(
                  "div",
                  null,
                  (0, import_react56.createElement)("strong", null, model.name),
                  model.id === resolveModelDefaults(group, preferences).modelId
                    ? (0, import_react56.createElement)(
                        "span",
                        { className: "workagent-default-tag" },
                        "默认",
                      )
                    : null,
                  (0, import_react56.createElement)("small", null, model.id),
                ),
                (0, import_react56.createElement)(
                  "div",
                  { className: "workagent-reasoning-tags" },
                  ...(model.reasoning.length
                    ? model.reasoning.map((option) =>
                        (0, import_react56.createElement)(
                          "span",
                          { key: option.id },
                          reasoningLabel(option),
                        ),
                      )
                    : [
                        (0, import_react56.createElement)(
                          "span",
                          { key: "none" },
                          "未提供思考选项",
                        ),
                      ]),
                ),
              ),
            ),
          ),
        ),
      );
    }

    // src/features/appearance/settings.js
    var import_react57 = __toESM(require("react"), 1);
    var import_react58 = require("react");
    var FONT_SIZE_KEY = "workagent.font-size";
    var fontSizes = [
      ["13", "紧凑"],
      ["14", "标准"],
      ["16", "大号"],
      ["18", "特大"],
    ];
    function readFontSize() {
      const value = localStorage.getItem(FONT_SIZE_KEY);
      return fontSizes.some(([size]) => size === value) ? value : "13";
    }
    function applyFontSize(value) {
      document.documentElement.dataset.workagentFontSize = value;
      document.documentElement.style.setProperty(
        "--workagent-font-scale",
        String(Number(value) / 14),
      );
    }
    function installTypography() {
      const root = document.documentElement;
      const style = root.style;
      const previous = style.getPropertyValue("--workagent-font-scale");
      const previousSize = root.dataset.workagentFontSize;
      applyFontSize(readFontSize());
      return () => {
        style.setProperty("--workagent-font-scale", previous);
        if (previousSize === void 0) delete root.dataset.workagentFontSize;
        else root.dataset.workagentFontSize = previousSize;
      };
    }
    function TypographySettings() {
      const [size, setSize] = import_react57.default.useState(readFontSize);
      return (0, import_react58.createElement)(
        "section",
        { className: "workagent-typography", "aria-label": "字体" },
        (0, import_react58.createElement)(
          "div",
          null,
          (0, import_react58.createElement)("strong", null, "字体大小"),
          (0, import_react58.createElement)(
            "p",
            null,
            "调整界面和对话文字，自动保存。",
          ),
        ),
        (0, import_react58.createElement)(Select, {
          "aria-label": "字体大小",
          value: size,
          options: fontSizes,
          onChange: (event) => {
            const value = event.target.value;
            localStorage.setItem(FONT_SIZE_KEY, value);
            applyFontSize(value);
            setSize(value);
          },
        }),
      );
    }

    // src/features/capabilities/imports.js
    function createImports({
      React: React37,
      request: request2,
      apiRoot: apiRoot2,
      Field: Field2,
      Input: Input2,
      Button: Button2,
      friendlyError: friendlyError2,
      useResource: useResource2,
    }) {
      const h33 = React37.createElement;
      function Results({ rows }) {
        return h33(
          "ul",
          null,
          ...rows.map((row, i) =>
            h33(
              "li",
              { key: i },
              `${row.name || "未命名"}：${row.error ? friendlyError2(row.error) : "已导入"}`,
            ),
          ),
        );
      }
      function SkillImport({ onImported }) {
        const [format, setFormat] = React37.useState("directory");
        const [busy, setBusy] = React37.useState(false);
        const [error, setError] = React37.useState("");
        const [result, setResult] = React37.useState([]);
        async function submit(e) {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          const files = [...form.elements.files.files];
          if (!files.length) return;
          if (
            files.reduce((total, file) => total + file.size, 0) >
            48 * 1024 * 1024
          )
            return setError("技能包不能超过 48 MB");
          data.set("format", format);
          data.set(
            "paths",
            JSON.stringify(
              files.map((file) => file.webkitRelativePath || file.name),
            ),
          );
          setBusy(true);
          setError("");
          try {
            const response = await fetch(`${apiRoot2}/imports/skill`, {
              method: "POST",
              credentials: "same-origin",
              body: data,
            });
            const value = await response.json();
            if (!response.ok) throw new Error(value.error);
            setResult([value]);
            onImported();
            if (!value.error) form.reset();
          } catch (reason) {
            setError(friendlyError2(reason.message));
          } finally {
            setBusy(false);
          }
        }
        return h33(
          "details",
          null,
          h33("summary", null, "导入本地技能"),
          h33(
            "form",
            { className: "workagent-form", onSubmit: submit },
            h33(
              Field2,
              { label: "导入技能名称" },
              h33(Input2, { name: "name", required: true, maxLength: 120 }),
            ),
            h33(
              Field2,
              { label: "技能描述" },
              h33(Input2, { name: "description", maxLength: 4e3 }),
            ),
            h33(
              Field2,
              { label: "技能来源" },
              h33(
                "select",
                { value: format, onChange: (e) => setFormat(e.target.value) },
                h33("option", { value: "directory" }, "本地目录"),
                h33("option", { value: "zip" }, "ZIP 包"),
              ),
            ),
            h33(
              Field2,
              { label: "选择技能文件" },
              h33("input", {
                key: format,
                name: "files",
                type: "file",
                required: true,
                ...(format === "directory"
                  ? { webkitdirectory: "", multiple: true }
                  : { accept: ".zip" }),
              }),
            ),
            h33(
              "p",
              null,
              "目录或 ZIP 包须包含 SKILL.md 和依赖文件，最多 48 MB。导入后可为助手启用。",
            ),
            h33(
              Button2,
              { type: "submit", disabled: busy },
              busy ? "导入中…" : "导入技能",
            ),
            error ? h33("p", { role: "alert" }, error) : null,
            h33(Results, { rows: result }),
          ),
        );
      }
      function MCPImport({ onImported }) {
        const [text, setText] = React37.useState("");
        const [busy, setBusy] = React37.useState(false);
        const [rows, setRows] = React37.useState([]);
        const [error, setError] = React37.useState("");
        async function submit(e) {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const parsed = JSON.parse(text);
            const rows2 = await request2(`${apiRoot2}/imports/mcp`, {
              method: "POST",
              body: JSON.stringify(parsed),
            });
            setRows(rows2);
            setText("");
            onImported();
          } catch (reason) {
            setError(friendlyError2(reason.message));
          } finally {
            setBusy(false);
          }
        }
        return h33(
          "details",
          null,
          h33("summary", null, "批量导入 MCP JSON"),
          h33(
            "form",
            { className: "workagent-form", onSubmit: submit },
            h33(
              Field2,
              { label: "MCP JSON 配置" },
              h33("textarea", {
                value: text,
                onChange: (e) => setText(e.target.value),
                required: true,
                rows: 8,
                autoComplete: "off",
                spellCheck: false,
                placeholder:
                  '{"mcpServers":{"example":{"command":"...","args":[]}}}',
              }),
            ),
            h33(
              "p",
              null,
              "支持 command/args/env 和 url/headers。密钥保存到当前员工的凭据库，导入记录不保留原始配置。",
            ),
            h33(
              Button2,
              { type: "submit", disabled: busy },
              busy ? "导入中…" : "导入 MCP",
            ),
            error ? h33("p", { role: "alert" }, error) : null,
            h33(Results, { rows }),
          ),
        );
      }
      function History() {
        const [state, refresh] = useResource2(`${apiRoot2}/imports`);
        return h33(
          "section",
          null,
          h33("h3", null, "能力导入记录"),
          h33(Button2, { onClick: refresh }, "刷新导入记录"),
          state.error
            ? h33("p", { role: "alert" }, friendlyError2(state.error))
            : null,
          ...state.rows
            .slice()
            .reverse()
            .map((row, i) =>
              h33(
                "p",
                { key: i },
                `${new Date(row.at).toLocaleString()} · ${row.kind} · ${row.name} · ${row.error ? friendlyError2(row.error) : "已导入"}`,
              ),
            ),
        );
      }
      return { SkillImport, MCPImport, History };
    }

    // src/features/capabilities/settings.js
    var import_react59 = __toESM(require("react"), 1);
    var import_react60 = require("react");
    function CapabilitySync({ kind, onSynced }) {
      const [state, refresh] = useResource(
        `${apiRoot}/capability-sync/status`,
        (value) => [
          ...(value.items || []),
          ...(value.error
            ? [
                {
                  key: "sync-error",
                  kind,
                  status: "unavailable",
                  name: "全局同步",
                  reason: value.error,
                },
              ]
            : []),
        ],
      );
      import_react59.default.useEffect(() => {
        const timer = setInterval(() => {
          refresh();
          onSynced();
        }, 5e3);
        return () => clearInterval(timer);
      }, [refresh, onSynced]);
      const [busy, setBusy] = import_react59.default.useState(false);
      const [error, setError] = import_react59.default.useState("");
      const sync = async () => {
        setBusy(true);
        setError("");
        try {
          await request(`${apiRoot}/capability-sync/run`, { method: "POST" });
          refresh();
          onSynced();
        } catch (reason) {
          setError(reason.message);
        } finally {
          setBusy(false);
        }
      };
      const problems = state.rows.filter(
        (row) =>
          row.kind === kind && ["unavailable", "conflict"].includes(row.status),
      );
      return (0, import_react60.createElement)(
        "div",
        { className: "workagent-capability-sync" },
        (0, import_react60.createElement)(
          "p",
          { className: "workagent-muted" },
          "自动发现本账号的全局安装，供兼容助手使用；项目安装仍留在项目。启停和同步对新会话生效。",
        ),
        (0, import_react60.createElement)(
          Button,
          { onClick: sync, disabled: busy },
          busy ? "正在同步…" : "检查新安装",
        ),
        error
          ? (0, import_react60.createElement)("p", { role: "alert" }, error)
          : null,
        ...problems.map((row) =>
          (0, import_react60.createElement)(
            "p",
            { key: row.key, role: "status" },
            `${row.name}：${row.status === "conflict" ? "存在冲突，请检查原安装与设置" : "暂不可共享"}（${row.reason}）`,
          ),
        ),
      );
    }
    function MCPSection() {
      const endpoint2 = `${apiRoot}/mcp-servers`;
      const [state, refresh] = useResource(endpoint2);
      const [error, setError] = import_react59.default.useState("");
      const [transport, setTransport] = import_react59.default.useState("http");
      const submit = async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const values = new FormData(form);
        const target = String(values.get("target") || "").trim();
        const body = {
          name: String(values.get("name") || "").trim(),
          source: "user",
          enabled: true,
          transport:
            transport === "stdio"
              ? {
                  kind: "stdio",
                  command: target,
                  args: [],
                  environmentCredentialIds: {},
                }
              : { kind: transport, url: target, headerCredentialIds: {} },
          toolPolicy: "all",
          allowedTools: [],
          oauthState: "none",
        };
        await mutate(refresh, setError, endpoint2, "POST", body);
        form.reset();
      };
      const oauth = async (row) => {
        try {
          const value = await request(
            `${endpoint2}/${encodeURIComponent(row.id)}/oauth/start`,
            {
              method: "POST",
              body: JSON.stringify({
                redirectUri: `${location.origin}/oauth/mcp/callback`,
              }),
            },
          );
          sessionStorage.setItem(
            "workagent.mcp.oauth",
            JSON.stringify({ id: row.id, ...value }),
          );
          location.assign(value.authorizationUrl);
        } catch (reason) {
          setError(reason.message);
        }
      };
      return (0, import_react60.createElement)(
        Section,
        { title: "MCP 服务" },
        (0, import_react60.createElement)(CapabilitySync, {
          kind: "mcp",
          onSynced: refresh,
        }),
        (0, import_react60.createElement)(imports.MCPImport, {
          onImported: refresh,
        }),
        (0, import_react60.createElement)(
          "form",
          { className: "workagent-form", onSubmit: submit },
          (0, import_react60.createElement)(
            Field,
            { label: "名称" },
            (0, import_react60.createElement)(Input, {
              name: "name",
              required: true,
            }),
          ),
          (0, import_react60.createElement)(
            Field,
            { label: "连接方式" },
            (0, import_react60.createElement)(Select, {
              value: transport,
              onChange: (e) => setTransport(e.target.value),
              options: [
                ["http", "HTTP"],
                ["sse", "SSE"],
                ["stdio", "命令行"],
              ],
            }),
          ),
          (0, import_react60.createElement)(
            Field,
            { label: transport === "stdio" ? "命令" : "服务地址" },
            (0, import_react60.createElement)(Input, {
              name: "target",
              required: true,
              type: transport === "stdio" ? "text" : "url",
            }),
          ),
          (0, import_react60.createElement)(
            "button",
            { className: "workagent-button", type: "submit" },
            "添加服务",
          ),
        ),
        error
          ? (0, import_react60.createElement)(
              "p",
              { role: "alert", className: "workagent-error" },
              error,
            )
          : null,
        (0, import_react60.createElement)(Status, { state }),
        ...state.rows.map((row) =>
          (0, import_react60.createElement)(
            Card,
            {
              key: row.id,
              title: row.name,
              detail: `${row.transport?.globalSource ? "Codex 全局安装 · " : ""}${displayValue(row.health, "未知状态")} · ${displayValue(row.oauthState, "无需授权")}`,
            },
            row.source === "user"
              ? (0, import_react60.createElement)(
                  Button,
                  {
                    onClick: () =>
                      mutate(
                        refresh,
                        setError,
                        `${endpoint2}/${encodeURIComponent(row.id)}`,
                        "PATCH",
                        { enabled: !row.enabled },
                      ),
                  },
                  row.enabled ? "停用" : "启用",
                )
              : null,
            row.oauthState === "needs_auth"
              ? (0, import_react60.createElement)(
                  Button,
                  { onClick: () => oauth(row) },
                  "授权",
                )
              : null,
            (0, import_react60.createElement)(
              Button,
              {
                onClick: () =>
                  mutate(
                    refresh,
                    setError,
                    `${endpoint2}/${encodeURIComponent(row.id)}/test`,
                    "POST",
                  ),
              },
              "测试连接",
            ),
            row.source === "user"
              ? (0, import_react60.createElement)(
                  Button,
                  {
                    onClick: () =>
                      mutate(
                        refresh,
                        setError,
                        `${endpoint2}/${encodeURIComponent(row.id)}`,
                        "DELETE",
                      ),
                  },
                  "删除",
                )
              : null,
          ),
        ),
      );
    }
    function SkillsSection() {
      const endpoint2 = apiRoot + "/skills";
      const [state, refresh] = useResource(endpoint2);
      const [error, setError] = import_react59.default.useState("");
      return (0, import_react60.createElement)(
        Section,
        { title: "技能" },
        (0, import_react60.createElement)(CapabilitySync, {
          kind: "skill",
          onSynced: refresh,
        }),
        (0, import_react60.createElement)(imports.SkillImport, {
          onImported: refresh,
        }),
        (0, import_react60.createElement)(
          "p",
          { className: "workagent-muted" },
          "管理已安装的技能；更多能力可在市场中获取。",
        ),
        error
          ? (0, import_react60.createElement)("p", { role: "alert" }, error)
          : null,
        (0, import_react60.createElement)(Status, { state }),
        ...state.rows.map((row) =>
          (0, import_react60.createElement)(
            Card,
            {
              key: row.id,
              title: row.name,
              detail:
                (row.referenceDirectory
                  ? `全局目录共享（${(row.compatibleEngines || ["codex", "kimi", "harness"]).map((engine) => ({ codex: "Codex", kimi: "Kimi", harness: "DSH" })[engine]).join("、")}）`
                  : displayValue(row.source)) +
                " · " +
                displayValue(row.enabled ? row.health || "ready" : "disabled"),
            },
            ["user", "market"].includes(row.source)
              ? (0, import_react60.createElement)(
                  Button,
                  {
                    onClick: () =>
                      mutate(
                        refresh,
                        setError,
                        endpoint2 + "/" + encodeURIComponent(row.id),
                        "PATCH",
                        { enabled: !row.enabled },
                      ),
                  },
                  row.enabled ? "停用" : "启用",
                )
              : null,
          ),
        ),
      );
    }
    var imports = createImports({
      React: import_react59.default,
      request,
      apiRoot,
      Field,
      Input,
      Button,
      friendlyError,
      useResource,
    });

    // src/features/conversations/home.js
    var import_react61 = __toESM(require("react"), 1);
    var import_react62 = require("react");
    function useDraftOption(key, options, defaultId, revision) {
      const [selection, setSelection] = import_react61.default.useState({
        revision,
        values: {},
      });
      const saved =
        selection.revision === revision ? selection.values[key] : void 0;
      const value =
        (
          options.find((option) => option.id === saved) ||
          options.find((option) => option.id === defaultId) ||
          options[0]
        )?.id || "";
      return [
        value,
        (value2) =>
          setSelection((previous) => ({
            revision,
            values: {
              ...(previous.revision === revision ? previous.values : {}),
              [key]: value2,
            },
          })),
      ];
    }
    function HeroWorkspaceComposer() {
      const search = navigation.useSearch();
      const projectId = sharedTaskProject(new URLSearchParams(search));
      return projectId
        ? (0, import_react62.createElement)(SharedTaskComposer, {
            key: projectId,
            projectId,
          })
        : (0, import_react62.createElement)(WorkspaceComposer);
    }
    function SharedTaskComposer({ projectId }) {
      const [state] = useResource(
        "/api/portal/shared-projects?include_hidden=true",
        (value) => value.projects || [],
      );
      const project = state.rows.find((row) => row.id === projectId);
      if (state.loading)
        return (0, import_react62.createElement)(
          "p",
          { role: "status" },
          "正在加载共享项目…",
        );
      if (state.error || !project)
        return (0, import_react62.createElement)(
          "p",
          { role: "alert", className: "workagent-error" },
          state.error
            ? friendlyError(state.error)
            : "项目不存在，或你已不再是项目成员。",
        );
      return (0, import_react62.createElement)(WorkspaceComposer, {
        sharedProject: project,
      });
    }
    function WorkspaceComposer({ sharedProject } = {}) {
      const routeSearch = navigation.useSearch();
      const [workspaceState, reloadWorkspaces] = useResource(
        `${apiRoot}/workspaces`,
      );
      const [presetState] = usePresets((value) =>
        (Array.isArray(value) ? value : []).filter((preset) => preset.enabled),
      );
      const [modelState] = useResource(`${apiRoot}/model-options`);
      const [personalProjectChoice, setProjectChoice] =
        import_react61.default.useState(
          () =>
            new URLSearchParams(routeSearch).get("project") ||
            localStorage.getItem(WORKSPACE_PICK_KEY) ||
            "none",
        );
      import_react61.default.useEffect(() => {
        setProjectChoice(
          new URLSearchParams(routeSearch).get("project") ||
            localStorage.getItem(WORKSPACE_PICK_KEY) ||
            "none",
        );
      }, [routeSearch]);
      const projectChoice = sharedProject
        ? `shared:${sharedProject.id}`
        : personalProjectChoice;
      const [presetId, setPresetId] = import_react61.default.useState(
        () => localStorage.getItem(AGENT_PICK_KEY) || "builtin-general",
      );
      const [projectName, setProjectName] = import_react61.default.useState("");
      const [preferences, , defaultsRevision] = useModelDefaults();
      const [message, setMessage] = workbench.useDraft(`home:${projectChoice}`);
      const [attachmentsBusy, setAttachmentsBusy] =
        import_react61.default.useState(false);
      const [busy, setBusy] = import_react61.default.useState(false);
      const [error, setError] = import_react61.default.useState("");
      import_react61.default.useEffect(() => {
        window.dispatchEvent(
          new window.CustomEvent(FILE_PROJECT_EVENT, {
            detail: ["none", "new"].includes(projectChoice)
              ? ""
              : projectChoice,
          }),
        );
      }, [projectChoice]);
      import_react61.default.useEffect(() => {
        const update = (event) => setPresetId(event.detail);
        window.addEventListener(HERO_AGENT_EVENT, update);
        return () => window.removeEventListener(HERO_AGENT_EVENT, update);
      }, []);
      import_react61.default.useEffect(() => {
        if (sharedProject) return;
        const update = (event) => setProjectChoice(event.detail);
        window.addEventListener(HERO_WORKSPACE_EVENT, update);
        return () => window.removeEventListener(HERO_WORKSPACE_EVENT, update);
      }, []);
      import_react61.default.useEffect(() => {
        const update = () => void reloadWorkspaces();
        window.addEventListener(PROJECTS_CHANGED_EVENT, update);
        return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, update);
      }, [reloadWorkspaces]);
      const selectedPreset =
        presetState.rows.find((preset) => preset.id === presetId) ||
        presetState.rows.find((preset) => preset.id === "builtin-general") ||
        presetState.rows[0];
      const availableProjects = workspaceState.rows;
      const modelGroup = modelState.rows.find(
        (group) => group.engine === selectedPreset?.engine,
      );
      const availableModels = modelGroup?.models || [];
      const defaults = resolveModelDefaults(
        modelGroup,
        preferences,
        selectedPreset,
      );
      const draftKey = `${selectedPreset?.id}:${selectedPreset?.engine}`;
      const [modelId, setModelId] = useDraftOption(
        draftKey,
        availableModels,
        defaults.modelId,
        defaultsRevision,
      );
      const selectedModel = availableModels.find(
        (model) => model.id === modelId,
      );
      const reasoningOptions = selectedModel?.reasoning || [];
      const [thinkingEffort, setThinkingEffort] = useDraftOption(
        `${draftKey}.${modelId}`,
        reasoningOptions,
        modelId === defaults.modelId
          ? defaults.thinkingEffort
          : defaultEffort(selectedPreset?.engine, selectedModel),
        defaultsRevision,
      );
      const [permissionMode, setPermissionMode] = useDraftOption(
        draftKey,
        permissionOptions.map(([id]) => ({ id })),
        defaults.permissionMode,
        defaultsRevision,
      );
      import_react61.default.useEffect(() => {
        if (sharedProject || workspaceState.loading) return;
        const valid = availableProjects.some(
          (project) => project.id === projectChoice,
        );
        if (!valid && projectChoice !== "new" && projectChoice !== "none")
          setProjectChoice("none");
      }, [workspaceState.loading, workspaceState.rows]);
      const selectProject = (event) => {
        const value = event.target.value;
        setProjectChoice(value);
        if (value !== "new" && value !== "none") {
          localStorage.setItem(WORKSPACE_PICK_KEY, value);
          window.dispatchEvent(
            new window.CustomEvent(HERO_WORKSPACE_EVENT, { detail: value }),
          );
        }
        setError("");
      };
      const submit = async (event) => {
        event.preventDefault();
        const content = message.trim();
        if (!content || busy || attachmentsBusy) return;
        if (!selectedPreset) {
          setError("请先选择一个助手。");
          return;
        }
        if (modelState.loading || !selectedModel) {
          setError("请先获取可用模型。");
          return;
        }
        if (projectChoice === "new" && !projectName.trim()) {
          setError("请输入新项目名称。");
          return;
        }
        setBusy(true);
        setError("");
        try {
          let project = availableProjects.find(
            (item) => item.id === projectChoice,
          );
          if (projectChoice === "new") {
            project = await request(`${apiRoot}/workspaces`, {
              method: "POST",
              body: JSON.stringify({
                name: projectName.trim(),
                scope: "personal",
              }),
            });
            await reloadWorkspaces();
            announceProjectsChanged();
          }
          const common = {
            ...(modelId ? { modelId } : {}),
            ...(thinkingEffort ? { thinkingEffort } : {}),
            permissionMode,
          };
          const options = {
            engine: selectedPreset.engine,
            title: plainSessionTitle(fileReferenceLabel(content).slice(0, 28)),
            presetId: selectedPreset.id,
            ...common,
          };
          const session = sharedProject
            ? await createPersonalTask(sharedProject, options)
            : await request(`${apiRoot}/sessions`, {
                method: "POST",
                body: JSON.stringify({
                  ...options,
                  workspace: project?.id || "default",
                }),
              });
          const receipt = {
            id: `message-ui-${crypto.randomUUID()}`,
            sessionId: session.id,
            role: "user",
            text: content,
            createdAt: /* @__PURE__ */ new Date().toISOString(),
            queued: false,
            status: "sending",
            error: "",
          };
          if (sharedProject) messageDelivery.update(session.id, receipt);
          try {
            await request(
              `${apiRoot}/sessions/${encodeURIComponent(session.id)}/turns`,
              {
                method: "POST",
                body: JSON.stringify({ content, messageId: receipt.id }),
              },
            );
            if (sharedProject)
              messageDelivery.update(session.id, {
                ...receipt,
                status: "sent",
              });
          } catch (cause) {
            if (!sharedProject) throw cause;
            messageDelivery.update(session.id, {
              ...receipt,
              status: "failed",
              error: friendlyError(cause.message),
            });
          }
          setMessage("");
          navigation.navigate(
            sharedProject
              ? personalTaskRoute(sharedProject.id, session.id)
              : `/?session=${encodeURIComponent(session.id)}`,
          );
        } catch (cause) {
          setError(friendlyError(cause.message));
        } finally {
          setBusy(false);
        }
      };
      return (0, import_react62.createElement)(
        "div",
        { className: "workagent-hero-controls" },
        (0, import_react62.createElement)(
          ComposerForm,
          { className: "workagent-hero-composer", onSubmit: submit },
          (0, import_react62.createElement)(workbench.ComposerTools, {
            key: projectChoice,
            session: {
              id: "home",
              workspaceId:
                projectChoice === "none"
                  ? "default"
                  : projectChoice === "new"
                    ? void 0
                    : projectChoice,
              preset: { resolvedSnapshot: selectedPreset || {} },
            },
            input: message,
            setInput: setMessage,
            disabled: busy,
            onError: setError,
            onBusyChange: setAttachmentsBusy,
          }),
          (0, import_react62.createElement)(ComposerInput, {
            "aria-label": "输入消息",
            workspaceId: projectChoice === "none" ? "default" : projectChoice,
            value: message,
            onChange: (event) => setMessage(event.target.value),
            onKeyDown: submitComposerOnEnter,
            placeholder: "描述你想完成的任务…",
          }),
          (0, import_react62.createElement)(
            "div",
            { className: "workagent-hero-composer-bar" },
            (0, import_react62.createElement)(
              "div",
              { className: "workagent-composer-options" },
              (0, import_react62.createElement)(
                "label",
                {
                  className: "workagent-model-choice",
                  title: selectedModel?.name || "模型",
                },
                (0, import_react62.createElement)(
                  "span",
                  {
                    className: "workagent-model-choice-label",
                    "aria-hidden": true,
                  },
                  selectedModel?.name || "模型",
                ),
                (0, import_react62.createElement)(Select, {
                  "aria-label": "模型",
                  value: modelId,
                  disabled: modelState.loading || !availableModels.length,
                  onChange: (event) => setModelId(event.target.value),
                  options: [
                    ...(!availableModels.length
                      ? [
                          [
                            "",
                            modelState.loading
                              ? "正在获取模型…"
                              : "暂无可用模型",
                          ],
                        ]
                      : []),
                    ...availableModels.map((model) => [model.id, model.name]),
                  ],
                }),
              ),
              (0, import_react62.createElement)(
                "label",
                { title: "思考级别" },
                (0, import_react62.createElement)(Select, {
                  "aria-label": "思考级别",
                  heading: "思考强度",
                  value: thinkingEffort,
                  disabled: modelState.loading || !reasoningOptions.length,
                  onChange: (event) => setThinkingEffort(event.target.value),
                  options: reasoningOptions.length
                    ? reasoningOptions.map((option) => [
                        option.id,
                        reasoningLabel(option),
                      ])
                    : [["", "未提供思考选项"]],
                }),
              ),
              (0, import_react62.createElement)(
                "label",
                { title: "权限" },
                (0, import_react62.createElement)(Select, {
                  "aria-label": "权限",
                  heading: "权限",
                  value: permissionMode,
                  onChange: (event) => setPermissionMode(event.target.value),
                  options: permissionOptions,
                }),
              ),
            ),
            (0, import_react62.createElement)(
              "button",
              {
                type: "submit",
                className: "workagent-composer-send",
                "aria-label": "发送消息",
                disabled:
                  busy ||
                  !message.trim() ||
                  !selectedPreset ||
                  (projectChoice === "new" && !projectName.trim()),
              },
              (0, import_react62.createElement)(Icon, {
                name: "send",
                size: 18,
              }),
            ),
          ),
        ),
        (0, import_react62.createElement)(
          "div",
          { className: "workagent-project-row" },
          (0, import_react62.createElement)(
            "label",
            { className: "workagent-project-select" },
            (0, import_react62.createElement)(Icon, {
              name: "workspace",
              size: 16,
            }),
            sharedProject
              ? (0, import_react62.createElement)(
                  "span",
                  {
                    className: "workagent-shared-project-name",
                    title: sharedProject.name,
                  },
                  sharedProject.name,
                )
              : (0, import_react62.createElement)(Select, {
                  "aria-label": "个人项目",
                  value: projectChoice,
                  onChange: selectProject,
                  options: [
                    ["none", "不使用项目"],
                    ...availableProjects.map((project) => [
                      project.id,
                      displayWorkspaceName(project.name),
                    ]),
                    ["new", "新建个人项目…"],
                  ],
                }),
          ),
          projectChoice === "new"
            ? (0, import_react62.createElement)(
                "div",
                { className: "workagent-project-draft" },
                (0, import_react62.createElement)(Input, {
                  className: "workagent-project-name",
                  "aria-label": "新项目名称",
                  value: projectName,
                  onChange: (event) => setProjectName(event.target.value),
                  placeholder: "个人项目名称",
                }),
                (0, import_react62.createElement)(
                  Button,
                  {
                    disabled: busy || !projectName.trim(),
                    onClick: async () => {
                      setBusy(true);
                      setError("");
                      try {
                        const project = await request(`${apiRoot}/workspaces`, {
                          method: "POST",
                          body: JSON.stringify({
                            name: projectName.trim(),
                            scope: "personal",
                          }),
                        });
                        await reloadWorkspaces();
                        setProjectChoice(project.id);
                        announceProjectsChanged();
                      } catch (reason) {
                        setError(friendlyError(reason.message));
                      } finally {
                        setBusy(false);
                      }
                    },
                  },
                  "创建项目",
                ),
              )
            : null,
          error
            ? (0, import_react62.createElement)(
                "span",
                { role: "alert", className: "workagent-error" },
                error,
              )
            : (0, import_react62.createElement)(
                "span",
                { className: "workagent-composer-hint" },
                busy
                  ? "正在创建会话…"
                  : sharedProject
                    ? "个人任务 · 仅自己可见"
                    : "Enter 发送",
              ),
        ),
      );
    }

    // src/features/files/sidebar.js
    var import_react63 = __toESM(require("react"), 1);
    var import_react64 = require("react");
    function FileSidebarPanel({
      workspaceId,
      onProjectChange,
      sessionLoading,
      sessionError,
    }) {
      const sharedProjectId = workspaceId?.startsWith("shared:")
        ? workspaceId.slice("shared:".length)
        : "";
      const [state, refresh] = useResource(
        sessionLoading
          ? null
          : sharedProjectId
            ? "/api/portal/shared-projects?include_hidden=true"
            : `${apiRoot}/workspaces`,
        (value) => (sharedProjectId ? value?.projects || [] : value),
      );
      const [open, setOpen] = import_react63.default.useState(
        () =>
          localStorage.getItem("workagent.files.open") === "true" ||
          (localStorage.getItem("workagent.files.open") === null &&
            window.innerWidth >= 1100),
      );
      const [width, setWidth] = import_react63.default.useState(
        () => Number(localStorage.getItem("workagent.files.width")) || 440,
      );
      import_react63.default.useEffect(() => {
        const openFile = (event) => {
          if (event.detail?.workspaceId === workspaceId) {
            setOpen(true);
            localStorage.setItem("workagent.files.open", "true");
          }
        };
        window.addEventListener("workagent:file-open", openFile);
        return () =>
          window.removeEventListener("workagent:file-open", openFile);
      }, [workspaceId]);
      const resizeWidth = (value) => {
        const next = Math.max(320, Math.min(window.innerWidth - 640, value));
        setWidth(next);
        localStorage.setItem("workagent.files.width", String(next));
      };
      import_react63.default.useEffect(() => {
        const update = () =>
          document.body.style.setProperty(
            "--workagent-files-width",
            `${Math.max(320, Math.min(window.innerWidth - 640, width))}px`,
          );
        update();
        window.addEventListener("resize", update);
        return () => {
          window.removeEventListener("resize", update);
          document.body.style.removeProperty("--workagent-files-width");
        };
      }, [width]);
      const toggle = (value) => {
        setOpen(value);
        localStorage.setItem("workagent.files.open", String(value));
      };
      const selectedProject = state.rows.find(
        (row) => row.id === (sharedProjectId || workspaceId),
      );
      const workspace =
        workspaceId === "default"
          ? {
              id: "default",
              name: "当前会话文件",
              directory: ".workagent-unassigned",
            }
          : selectedProject && { ...selectedProject, id: workspaceId };
      const sharedFiles = sharedProjectId
        ? {
            root: workspaceFileRoot(workspaceId),
            trashRoot: `${workspaceFileRoot(workspaceId)}/trash`,
            editable: false,
            resolveOfficePreview: async (_workspace, entry, signal) => {
              const result = await request(
                "/api/portal/shared-office-preview",
                {
                  method: "POST",
                  body: JSON.stringify({
                    project_id: sharedProjectId,
                    path: entry.path,
                  }),
                  signal,
                },
              );
              return result.url;
            },
            createEmptyFile: async ({ directory, name }) => {
              await uploads.uploadFile(
                workspaceId,
                [directory, name].filter(Boolean).join("/"),
                new File([], name, { type: "text/plain" }),
              );
            },
          }
        : {};
      import_react63.default.useEffect(() => {
        const update = () => void refresh();
        window.addEventListener(PROJECTS_CHANGED_EVENT, update);
        return () => window.removeEventListener(PROJECTS_CHANGED_EVENT, update);
      }, [refresh]);
      return (0, import_react64.createElement)(
        import_react63.default.Fragment,
        null,
        (0, import_react64.createElement)(
          "div",
          { className: "workagent-top-actions" },
          (0, import_react64.createElement)(TopNotificationButton),
          (0, import_react64.createElement)(
            "button",
            {
              type: "button",
              className: "workagent-files-toggle",
              "aria-label": open ? "收起文件侧栏" : "打开文件侧栏",
              "aria-expanded": open,
              "aria-controls": "workagent-files-panel",
              title: "项目文件",
              onClick: () => toggle(!open),
            },
            (0, import_react64.createElement)(Icon, {
              name: "workspace",
              size: 19,
            }),
          ),
        ),
        open
          ? (0, import_react64.createElement)("button", {
              type: "button",
              className: "workagent-files-backdrop",
              "aria-label": "关闭文件侧栏遮罩",
              onClick: () => toggle(false),
            })
          : null,
        (0, import_react64.createElement)(
          "aside",
          {
            id: "workagent-files-panel",
            hidden: !open,
            className: "workagent-files-panel",
            "aria-label": "项目文件侧栏",
            onKeyDown: (event) => {
              if (
                event.key === "Escape" &&
                !["INPUT", "TEXTAREA"].includes(event.target.tagName)
              )
                toggle(false);
            },
          },
          (0, import_react64.createElement)(ResizeHandle, {
            orientation: "vertical",
            value: width,
            onChange: resizeWidth,
            measure: (event) => {
              const initial = event.clientX;
              const actualWidth =
                event.currentTarget.parentElement.getBoundingClientRect().width;
              return (move) => actualWidth + initial - move.clientX;
            },
          }),
          (0, import_react64.createElement)(
            "header",
            { className: "workagent-files-panel-header" },
            (0, import_react64.createElement)("strong", null, "项目文件"),
            (0, import_react64.createElement)(FileIconButton, {
              name: "expand",
              label: width > 500 ? "缩小文件侧栏" : "放大文件侧栏",
              onClick: () =>
                resizeWidth(width > 500 ? 440 : window.innerWidth * 0.55),
            }),
            (0, import_react64.createElement)(FileIconButton, {
              name: "close",
              label: "关闭文件侧栏",
              onClick: () => toggle(false),
            }),
          ),
          onProjectChange && !sharedProjectId
            ? (0, import_react64.createElement)(
                "select",
                {
                  className: "workagent-files-project",
                  "aria-label": "文件侧栏项目",
                  value: workspace?.id || "",
                  onChange: (event) => onProjectChange(event.target.value),
                },
                (0, import_react64.createElement)(
                  "option",
                  { value: "" },
                  "选择项目",
                ),
                ...state.rows
                  .filter((row) => row.scope !== "team")
                  .map((row) =>
                    (0, import_react64.createElement)(
                      "option",
                      { key: row.id, value: row.id },
                      displayWorkspaceName(row.name),
                    ),
                  ),
              )
            : (0, import_react64.createElement)(
                "div",
                {
                  className: "workagent-files-project",
                  title: workspace?.name || void 0,
                },
                workspace
                  ? displayWorkspaceName(workspace.name)
                  : sharedProjectId
                    ? "共享项目文件夹"
                    : "当前会话项目",
              ),
          state.error || sessionError
            ? (0, import_react64.createElement)(
                "p",
                { role: "alert", className: "workagent-file-notice" },
                friendlyError(state.error || sessionError),
              )
            : state.loading || sessionLoading
              ? (0, import_react64.createElement)(
                  "p",
                  { role: "status" },
                  "正在加载项目…",
                )
              : workspace
                ? (0, import_react64.createElement)(WorkspaceFileManager, {
                    key: workspace.id,
                    workspace,
                    ...sharedFiles,
                    onDismiss: () => toggle(false),
                  })
                : (0, import_react64.createElement)(
                    "div",
                    { className: "workagent-file-panel-empty" },
                    (0, import_react64.createElement)(Icon, {
                      name: "workspace",
                      size: 32,
                    }),
                    (0, import_react64.createElement)(
                      "strong",
                      null,
                      sharedProjectId ? "共享项目文件夹" : "选择项目后查看文件",
                    ),
                    (0, import_react64.createElement)(
                      "p",
                      null,
                      sharedProjectId
                        ? "项目不存在，或你已不再是项目成员。"
                        : "文件随项目保存。已有会话会自动显示所属项目。",
                    ),
                  ),
        ),
      );
    }
    function HomeFileSidebar() {
      const routeSearch = navigation.useSearch();
      const [workspaceId, setWorkspaceId] = import_react63.default.useState(
        () =>
          new URLSearchParams(routeSearch).get("project") ||
          localStorage.getItem(WORKSPACE_PICK_KEY) ||
          "",
      );
      import_react63.default.useEffect(() => {
        setWorkspaceId(
          new URLSearchParams(routeSearch).get("project") ||
            localStorage.getItem(WORKSPACE_PICK_KEY) ||
            "",
        );
      }, [routeSearch]);
      import_react63.default.useEffect(() => {
        const update = (event) => setWorkspaceId(event.detail || "");
        window.addEventListener(FILE_PROJECT_EVENT, update);
        return () => window.removeEventListener(FILE_PROJECT_EVENT, update);
      }, []);
      return (0, import_react64.createElement)(FileSidebarPanel, {
        workspaceId,
        onProjectChange: (id) => {
          setWorkspaceId(id);
          localStorage.setItem(WORKSPACE_PICK_KEY, id || "none");
          window.dispatchEvent(
            new window.CustomEvent(HERO_WORKSPACE_EVENT, {
              detail: id || "none",
            }),
          );
        },
      });
    }
    function SessionFileSidebar({ sessionId: sessionId2 }) {
      const [state] = useSessionResource(
        `${apiRoot}/sessions/${encodeURIComponent(sessionId2)}`,
      );
      return (0, import_react64.createElement)(FileSidebarPanel, {
        workspaceId: state.rows[0]?.workspaceId,
        sessionLoading: state.loading,
        sessionError: state.error,
      });
    }
    function FileSidebar() {
      const routeSearch = navigation.useSearch();
      const params = new URLSearchParams(routeSearch);
      const sessionId2 = params.get("session");
      const sharedStarter =
        params.get("workagent") === "shared" &&
        params.get("personal") === "new" &&
        params.get("project");
      if (sharedStarter && !sessionId2)
        return (0, import_react64.createElement)(FileSidebarPanel, {
          key: `shared:${sharedStarter}`,
          workspaceId: `shared:${sharedStarter}`,
        });
      if (params.get("workagent") && !sessionId2)
        return (0, import_react64.createElement)(
          "div",
          { className: "workagent-top-actions" },
          (0, import_react64.createElement)(TopNotificationButton),
        );
      return sessionId2
        ? (0, import_react64.createElement)(SessionFileSidebar, {
            key: sessionId2,
            sessionId: sessionId2,
          })
        : (0, import_react64.createElement)(HomeFileSidebar);
    }

    // src/features/quota/panel.js
    var import_react65 = __toESM(require("react"), 1);
    var import_react66 = require("react");
    function QuotaPanel() {
      const [state, refresh] = useResource(
        "/api/quota/dollars",
        (value) => value.budgets || [],
      );
      import_react65.default.useEffect(() => {
        const timer = setInterval(refresh, 5e3);
        return () => clearInterval(timer);
      }, [refresh]);
      const remaining = (used, limit) =>
        `${limit > 0 ? Math.round(Math.max(0, Math.min(1, 1 - used / limit)) * 100) : 0}%`;
      const meter = (label, used, limit) => {
        const value = remaining(used, limit);
        return (0, import_react66.createElement)(
          "div",
          { className: "workagent-quota-row" },
          (0, import_react66.createElement)("span", null, label),
          (0, import_react66.createElement)("span", null, value),
          (0, import_react66.createElement)(
            "div",
            {
              className: "workagent-quota-track",
              role: "progressbar",
              "aria-label": label,
              "aria-valuemin": 0,
              "aria-valuemax": 100,
              "aria-valuenow": parseInt(value, 10),
            },
            (0, import_react66.createElement)("span", {
              style: { width: value },
            }),
          ),
        );
      };
      return (0, import_react66.createElement)(
        "aside",
        { className: "workagent-quota-panel", "aria-label": "使用额度" },
        (0, import_react66.createElement)("strong", null, "剩余额度"),
        (0, import_react66.createElement)(Status, { state }),
        ...state.rows.map((b) =>
          (0, import_react66.createElement)(
            "div",
            { className: "workagent-dollar-quota", key: b.pool },
            (0, import_react66.createElement)(
              "strong",
              null,
              b.pool === "codex" ? "Codex / ChatGPT" : "Kimi",
            ),
            meter("每日剩余", b.dailyUsd, b.dailyLimitUsd),
            meter("每周剩余", b.weeklyUsd, b.weeklyLimitUsd),
          ),
        ),
        (0, import_react66.createElement)(
          "span",
          { className: "workagent-muted" },
          "DSH 与 Codex / ChatGPT 共享额度。",
        ),
      );
    }

    // src/client.js
    var import_react67 = require("react");
    var pluginScript = document.currentScript?.src;
    var sections = [
      ["workagent-system", 40, "系统与帮助", SystemSettings],
      ["workagent-mcp", 30, "MCP 服务", MCPSection],
      ["workagent-skills", 31, "技能", SkillsSection],
      ["workagent-market", 32, "市场", MarketplaceSection],
      ["workagent-presets", 33, "助手", PresetsSection],
      ["workagent-models", 34, "模型", ModelsSection],
      [
        "workagent-completion-notifications",
        36,
        "消息提醒",
        CompletionNotificationSettings,
      ],
    ];
    var inject = [
      "slots",
      "layout",
      "theme",
      "locale",
      "settingsScope",
      "sessions",
      "connection",
    ];
    function apply(ctx) {
      bindLayout(ctx.layout);
      ctx.effect(() => navigation.install(), "workagent: in-page navigation");
      bindConversationSettings(
        ctx.settingsScope.bind({ namespace: "ui-conversation" }),
      );
      ctx.effect(
        () =>
          installHostCompatibility({
            navigate: navigation.navigate,
            pluginScript,
            applyTypography: installTypography,
          }),
        "workagent: host compatibility",
      );
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register(
          {
            name: "settings.general.item",
            id: "workagent-upload-project",
            order: 15,
          },
          UploadSettings,
        ),
      );
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register(
          {
            name: "settings.general.item",
            id: "composer-enter",
            order: 20,
            priority: -10,
          },
          BusyEnterSettings,
        ),
      );
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register(
          {
            name: "settings.general.item",
            id: "permission",
            order: -20,
            priority: -10,
          },
          () => null,
        ),
      );
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register(
          {
            name: "settings.general.item",
            id: "workagent-typography",
            order: 5,
          },
          TypographySettings,
        ),
      );
      const localeScope = ctx.settingsScope.bind({ namespace: "locale" });
      let localeWritePending = false;
      const initializeLocale = () => {
        const value = localeScope.getSnapshot().value;
        if (value?.preference === "zh") localeWritePending = false;
        else if (value !== void 0 && !localeWritePending) {
          localeWritePending = true;
          ctx.locale.setLocale("zh");
        }
      };
      ctx.effect(() => {
        const unsubscribe = localeScope.subscribe(initializeLocale);
        initializeLocale();
        return unsubscribe;
      }, "workagent: Chinese interface language");
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register(
          {
            name: "settings.general.item",
            id: "language",
            order: 0,
            priority: -10,
          },
          () => null,
        ),
      );
      ctx.slots.inject("sidebar.brand.mark", () =>
        ctx.slots.inject("sidebar.brand.name", function* () {
          yield ctx.slots.register({ name: "sidebar.brand.mark" }, BrandMark);
          yield ctx.slots.register({ name: "sidebar.brand.name" }, BrandName);
        }),
      );
      ctx.slots.inject("conversation.hero.brand.mark", () =>
        ctx.slots.register(
          {
            name: "conversation.hero.brand.mark",
            id: "workagent-hero-mark",
            order: 10,
          },
          BrandMark,
        ),
      );
      for (const [id, order, label, Component] of sections)
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            { name: "settings.section", id, order, label },
            Component,
          ),
        );
      ctx.slots.inject("settings.action", () =>
        ctx.slots.register(
          { name: "settings.action", id: "workagent-quota", order: 100 },
          QuotaPanel,
        ),
      );
      for (const [order, kind] of [
        "chatgpt",
        "tasks",
        "workspace",
        "theme",
        "logout",
      ].entries())
        ctx.slots.inject("sidebar.footer.action", () =>
          ctx.slots.register(
            {
              name: "sidebar.footer.action",
              id: `workagent-${kind}`,
              order: 100 + order,
            },
            (props) =>
              (0, import_react67.createElement)(FooterAction, {
                ...props,
                kind,
                theme: ctx.theme,
              }),
          ),
        );
      ctx.slots.inject("conversation.hero.agentPreset", () =>
        ctx.slots.register(
          {
            name: "conversation.hero.agentPreset",
            id: "workagent-agent-picker",
            order: 10,
          },
          AgentPicker,
        ),
      );
      ctx.slots.inject("conversation.hero.workspace", () =>
        ctx.slots.register(
          {
            name: "conversation.hero.workspace",
            id: "workagent-workspace-composer",
            order: 20,
            priority: -10,
          },
          HeroWorkspaceComposer,
        ),
      );
      ctx.slots.inject("sidebar.workspaces", () =>
        ctx.slots.register(
          {
            name: "sidebar.workspaces",
            id: "workagent-sidebar-browser",
            order: 20,
            priority: -10,
          },
          CollaborationSidebar,
        ),
      );
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "workagent-page", order: 10 },
          (props) =>
            (0, import_react67.createElement)(
              RuntimeServices.Provider,
              { value: ctx },
              (0, import_react67.createElement)(WorkAgentOverlay, props),
            ),
        ),
      );
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "workagent-files", order: 20 },
          FileSidebar,
        ),
      );
    }

    return module.exports;
  },
});
