// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { sidebarState, isDarkTheme, watchTheme } from "./compatibility.js";

afterEach(() => {
  document.body.replaceChildren();
  document.body.removeAttribute("data-ds-dark-theme");
});

it("exposes sidebar changes without leaking its DOM classes to consumers", async () => {
  const element = document.createElement("aside");
  element.className = "hHd-Xa_root hHd-Xa_collapsed";
  document.body.append(element);
  const state = sidebarState();
  const listener = vi.fn();
  const stop = state.subscribe(listener);
  expect(state.isOpen()).toBe(false);
  element.classList.remove("hHd-Xa_collapsed");
  await Promise.resolve();
  expect(state.isOpen()).toBe(true);
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
  stop();
  element.classList.add("hHd-Xa_collapsed");
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(1);
});

it("treats an absent host sidebar as closed", () => {
  const state = sidebarState();
  expect(state.isOpen()).toBe(false);
  const listener = vi.fn();
  state.subscribe(listener)();
  expect(listener).not.toHaveBeenCalled();
});

it("observes the host theme and releases the observer", async () => {
  const listener = vi.fn();
  const stop = watchTheme(listener);
  expect(isDarkTheme()).toBe(false);
  document.body.setAttribute("data-ds-dark-theme", "");
  await Promise.resolve();
  expect(isDarkTheme()).toBe(true);
  expect(listener).toHaveBeenLastCalledWith(true);
  document.body.removeAttribute("data-ds-dark-theme");
  await Promise.resolve();
  expect(listener).toHaveBeenLastCalledWith(false);
  stop();
  document.body.setAttribute("data-ds-dark-theme", "");
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(2);
});
