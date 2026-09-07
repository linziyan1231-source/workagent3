window.__ModuleLoader__.load({
  id: "@workagent/dsh-appearance",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const stylesheet =
      document.currentScript?.src.replace(
        /client\.js(?:\?.*)?$/,
        "tokens.css",
      ) || "/plugins/@workagent/dsh-appearance/tokens.css";
    const storageKey = "workagent.appearance.v1";
    const themes = [
      { id: "porcelain", label: "云瓷白", detail: "轻盈、精致" },
      { id: "glacier", label: "冰川蓝", detail: "清晰、沉静" },
      { id: "graphite", label: "石墨黑", detail: "专注、低亮度" },
      { id: "paper", label: "暖纸色", detail: "温润、书卷感" },
      { id: "jade", label: "松石绿", detail: "自然、稳重" },
    ];
    const daylightThemes = themes.filter((theme) => theme.id !== "graphite");
    function readPreference() {
      try {
        const value = JSON.parse(localStorage.getItem(storageKey));
        if (
          value &&
          ["system", ...themes.map((theme) => theme.id)].includes(value.mode) &&
          daylightThemes.some((theme) => theme.id === value.daylight)
        )
          return value;
      } catch {
        /* Ignore a damaged preference left in browser storage. */
      }
      return null;
    }
    function legacyPreference(theme) {
      return {
        mode:
          theme.preference === "dark"
            ? "graphite"
            : theme.preference === "light"
              ? "porcelain"
              : "system",
        daylight: "porcelain",
      };
    }
    function createAppearance(ctx) {
      let preference = readPreference();
      let owned = preference !== null;
      preference ||= legacyPreference(ctx.theme.getTheme());
      let snapshot;
      const listeners = new Set();
      const update = () => {
        const native = ctx.theme.getTheme();
        if (!owned) preference = legacyPreference(native);
        const expected =
          preference.mode === "system"
            ? "system"
            : preference.mode === "graphite"
              ? "dark"
              : "light";
        if (owned && native.preference !== expected) {
          ctx.theme.setTheme(expected);
          return;
        }
        const active =
          preference.mode === "system"
            ? native.active.colorScheme === "dark"
              ? "graphite"
              : preference.daylight
            : preference.mode;
        document.documentElement.dataset.workagentTheme = active;
        document.body.dataset.workagentTheme = active;
        if (
          snapshot?.mode === preference.mode &&
          snapshot.daylight === preference.daylight &&
          snapshot.active === active
        )
          return;
        snapshot = { ...preference, active };
        listeners.forEach((listener) => listener());
      };
      ctx.on("theme/change", update);
      ctx.effect(() => {
        const onStorage = (event) => {
          if (event.key !== storageKey && event.key !== null) return;
          preference = readPreference();
          owned = preference !== null;
          preference ||= legacyPreference(ctx.theme.getTheme());
          update();
        };
        window.addEventListener("storage", onStorage);
        return () => {
          window.removeEventListener("storage", onStorage);
          delete document.documentElement.dataset.workagentTheme;
          delete document.body.dataset.workagentTheme;
        };
      }, "workagent-appearance: preference lifecycle");
      update();
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        choose: (changes) => {
          preference = { ...preference, ...changes };
          owned = true;
          localStorage.setItem(storageKey, JSON.stringify(preference));
          update();
        },
      };
    }
    function ThemePreview({ theme }) {
      return h(
        "span",
        {
          className: "wa-appearance-preview",
          "data-palette": theme,
          "aria-hidden": true,
        },
        h(
          "span",
          { className: "wa-appearance-preview-sidebar" },
          h("i"),
          h("i"),
          h("i"),
        ),
        h(
          "span",
          { className: "wa-appearance-preview-main" },
          h("i"),
          h("span", null, h("b")),
        ),
      );
    }
    function AppearanceRow({ appearance }) {
      const value = React.useSyncExternalStore(
        appearance.subscribe,
        appearance.getSnapshot,
      );
      return h(
        "section",
        { className: "wa-appearance", "aria-label": "外观" },
        h("div", { className: "wa-appearance-heading" }, "外观"),
        h(
          "div",
          { className: "wa-appearance-grid", "aria-label": "外观方案" },
          ...themes.map((theme) =>
            h(
              "button",
              {
                key: theme.id,
                type: "button",
                className: "wa-appearance-choice",
                "aria-pressed": value.mode === theme.id,
                "aria-label": theme.label,
                onClick: () => appearance.choose({ mode: theme.id }),
              },
              h(ThemePreview, { theme: theme.id }),
              h("span", { className: "wa-appearance-name" }, theme.label),
              h("small", null, theme.detail),
            ),
          ),
          h(
            "button",
            {
              type: "button",
              className: "wa-appearance-choice",
              "aria-pressed": value.mode === "system",
              "aria-label": "跟随系统",
              onClick: () => appearance.choose({ mode: "system" }),
            },
            h(
              "span",
              {
                className: "wa-appearance-system-preview",
                "aria-hidden": true,
              },
              h(ThemePreview, { theme: value.daylight }),
              h(ThemePreview, { theme: "graphite" }),
            ),
            h("span", { className: "wa-appearance-name" }, "跟随系统"),
            h("small", null, "自动切换白昼与黑夜"),
          ),
        ),
        value.mode === "system"
          ? h(
              "div",
              { className: "wa-appearance-system" },
              h(
                "label",
                null,
                h("span", null, "白昼模式"),
                h(
                  "select",
                  {
                    "aria-label": "白昼模式",
                    value: value.daylight,
                    onChange: (event) =>
                      appearance.choose({ daylight: event.target.value }),
                  },
                  ...daylightThemes.map((theme) =>
                    h(
                      "option",
                      { key: theme.id, value: theme.id },
                      theme.label,
                    ),
                  ),
                ),
              ),
              h(
                "div",
                { className: "wa-appearance-night" },
                h("span", null, "黑夜模式"),
                h("span", null, "石墨黑"),
              ),
              h(
                "p",
                { "aria-live": "polite" },
                `当前使用 ${themes.find((theme) => theme.id === value.active).label}，随系统外观自动切换。`,
              ),
            )
          : null,
      );
    }
    const inject = ["slots", "theme"];
    function apply(ctx) {
      ctx.effect(() => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = stylesheet;
        link.dataset.workagentAppearance = "true";
        document.head.append(link);
        return () => link.remove();
      }, "workagent-appearance: stylesheet");
      // Keep upstream components and future slot plugins on the same semantic palette.
      const aliases = {
        "bg-base": "bg",
        "bg-layer-1": "panel",
        "bg-layer-2": "sidebar",
        "bg-overlay": "panel",
        "bg-module-platform": "sidebar",
        "bg-module-message": "panel",
        "border-l1": "border",
        "border-l2": "border",
        "label-primary": "text",
        "label-secondary": "muted",
        "label-tertiary": "muted",
        "interactive-bg-hover": "accent-soft",
        "interactive-bg-active": "accent-soft",
      };
      ctx.effect(
        () =>
          ctx.theme.overrideTokens(
            "@workagent/dsh-appearance",
            Object.fromEntries(
              Object.entries(aliases).map(([name, token]) => [
                `--dsw-alias-${name}`,
                {
                  light: `var(--dsw-color-${token})`,
                  dark: `var(--dsw-color-${token})`,
                },
              ]),
            ),
          ),
        "workagent-appearance: semantic theme tokens",
      );
      const appearance = createAppearance(ctx);
      // Shade only the existing Appearance cell. Other settings contributors stay intact.
      ctx.slots.inject("settings.general.item", () =>
        ctx.slots.register(
          {
            name: "settings.general.item",
            id: "appearance",
            order: 10,
            priority: -10,
          },
          () => h(AppearanceRow, { appearance }),
        ),
      );
    }
    return { inject, apply };
  },
});
