// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

let client;
const disposers = [];
beforeAll(async () => {
  let registration;
  window.__ModuleLoader__ = {
    load: (value) => {
      registration = value;
    },
  };
  await import("./client.js");
  client = registration.factory(() => React);
});
beforeEach(() => {
  const values = new Map();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      clear: () => values.clear(),
    },
  });
});
afterEach(() => {
  cleanup();
  disposers
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
});

function mount({ preference = "system", dark = false } = {}) {
  let systemDark = dark;
  let snapshot = {
    preference,
    active: {
      colorScheme:
        preference === "system" ? (dark ? "dark" : "light") : preference,
    },
  };
  const events = new Set();
  const registrations = [];
  const theme = {
    getTheme: () => snapshot,
    setTheme: vi.fn((next) => {
      snapshot = {
        preference: next,
        active: {
          colorScheme:
            next === "system" ? (systemDark ? "dark" : "light") : next,
        },
      };
      events.forEach((fn) => fn());
    }),
    overrideTokens: vi.fn(() => () => {}),
  };
  const ctx = {
    theme,
    effect: (fn) => {
      const dispose = fn();
      disposers.push(dispose);
      return dispose;
    },
    on: (_name, fn) => {
      events.add(fn);
      disposers.push(() => events.delete(fn));
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, Component) => {
        registrations.push({ options, Component });
        return () => {};
      },
    },
  };
  client.apply(ctx);
  render(React.createElement(registrations[0].Component));
  return {
    theme,
    registrations,
    system: (dark) =>
      act(() => {
        systemDark = dark;
        if (snapshot.preference === "system") {
          snapshot = {
            ...snapshot,
            active: { colorScheme: dark ? "dark" : "light" },
          };
          events.forEach((fn) => fn());
        }
      }),
  };
}
const active = () => document.body.dataset.workagentTheme;
const choose = (name) =>
  fireEvent.click(screen.getByRole("button", { name, exact: true }));

describe("appearance plugin", () => {
  it("shades only the native Appearance cell and presents five themes", () => {
    const { registrations } = mount();
    expect(registrations[0].options).toMatchObject({
      name: "settings.general.item",
      id: "appearance",
      priority: -10,
    });
    expect(screen.getAllByRole("button")).toHaveLength(6);
    expect(
      screen.queryByRole("button", { name: "浅色", exact: true }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "深色", exact: true }),
    ).toBeNull();
  });
  it.each([
    ["云瓷白", "porcelain"],
    ["冰川蓝", "glacier"],
    ["石墨黑", "graphite"],
    ["暖纸色", "paper"],
    ["松石绿", "jade"],
  ])(
    "selects %s and keeps a fixed theme through system changes",
    (label, id) => {
      const app = mount();
      choose(label);
      expect(active()).toBe(id);
      expect(app.theme.getTheme().active.colorScheme).toBe(
        id === "graphite" ? "dark" : "light",
      );
      app.system(true);
      app.system(false);
      expect(active()).toBe(id);
      expect(
        JSON.parse(localStorage.getItem("workagent.appearance.v1")).mode,
      ).toBe(id);
    },
  );
  it("follows the chosen daylight palette and fixes night to graphite", () => {
    const app = mount();
    const picker = screen.getByRole("combobox", { name: "白昼模式" });
    expect([...picker.options].map((option) => option.value)).toEqual([
      "porcelain",
      "glacier",
      "paper",
      "jade",
    ]);
    fireEvent.change(picker, { target: { value: "jade" } });
    expect(active()).toBe("jade");
    app.system(true);
    expect(active()).toBe("graphite");
    fireEvent.change(picker, { target: { value: "paper" } });
    expect(active()).toBe("graphite");
    app.system(false);
    expect(active()).toBe("paper");
    choose("冰川蓝");
    choose("跟随系统");
    expect(active()).toBe("paper");
  });
  it("restores a saved system choice on a dark startup", () => {
    localStorage.setItem(
      "workagent.appearance.v1",
      JSON.stringify({ mode: "system", daylight: "glacier" }),
    );
    const app = mount({ dark: true });
    expect(active()).toBe("graphite");
    app.system(false);
    expect(active()).toBe("glacier");
  });
  it("migrates legacy dark and ignores a damaged saved preference", () => {
    localStorage.setItem("workagent.appearance.v1", "not-json");
    mount({ preference: "dark" });
    expect(active()).toBe("graphite");
    expect(
      screen
        .getByRole("button", { name: "石墨黑" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
  it("accepts a stored preference from another tab", () => {
    mount();
    act(() => {
      localStorage.setItem(
        "workagent.appearance.v1",
        JSON.stringify({ mode: "jade", daylight: "paper" }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: "workagent.appearance.v1" }),
      );
    });
    expect(active()).toBe("jade");
  });
});
