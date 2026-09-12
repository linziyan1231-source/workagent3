// @vitest-environment jsdom
import { it, expect, vi, afterEach } from "vitest";
import { trackConversationScroll } from "./scroll.js";
import { createConversationCache } from "./cache.js";
import { sidebarState } from "../../host/compatibility.js";
afterEach(() => vi.restoreAllMocks());
window.matchMedia = () => ({});
it("retains the document position across drawer toggles, breakpoints and conversation remounts", async () => {
  const media = new EventTarget();
  media.matches = true;
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  let scroll = 0;
  vi.spyOn(window, "scrollY", "get").mockImplementation(() => scroll);
  vi.spyOn(window, "scrollTo").mockImplementation((x, y) => {
    scroll = y;
  });
  const list = document.createElement("div"),
    sidebar = document.createElement("aside");
  sidebar.className = "hHd-Xa_collapsed";
  const cache = createConversationCache();
  cache.set("a", "scroll", 120);
  let stop = trackConversationScroll(
    list,
    sidebarState(sidebar),
    cache,
    "a",
    false,
  );
  expect(scroll).toBe(120);
  scroll = 480;
  sidebar.classList.add("hHd-Xa_railIn");
  await Promise.resolve();
  expect(scroll).toBe(480);
  window.dispatchEvent(new Event("scroll"));
  expect(cache.get("a", "scroll")).toBe(480);
  sidebar.className = "";
  await Promise.resolve();
  expect(scroll).toBe(0);
  window.dispatchEvent(new Event("scroll"));
  expect(cache.get("a", "scroll")).toBe(480);
  sidebar.className = "hHd-Xa_collapsed";
  await Promise.resolve();
  expect(scroll).toBe(480);
  media.matches = false;
  media.dispatchEvent(new Event("change"));
  expect(list.scrollTop).toBe(480);
  expect(scroll).toBe(0);
  list.scrollTop = 650;
  list.dispatchEvent(new Event("scroll"));
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  expect(scroll).toBe(650);
  stop();
  expect(scroll).toBe(0);
  expect(cache.get("a", "scroll")).toBe(650);
  stop = trackConversationScroll(
    list,
    sidebarState(sidebar),
    cache,
    "a",
    false,
  );
  expect(scroll).toBe(650);
  stop();
});
it("keeps side conversations on their own scroller and removes listeners on unmount", () => {
  const media = new EventTarget();
  media.matches = true;
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  const to = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const list = document.createElement("div"),
    sidebar = document.createElement("aside");
  sidebar.className = "hHd-Xa_collapsed";
  const cache = createConversationCache();
  cache.set("side", "scroll", 90);
  const stop = trackConversationScroll(
    list,
    sidebarState(sidebar),
    cache,
    "side",
    true,
  );
  expect(list.scrollTop).toBe(90);
  list.scrollTop = 200;
  list.dispatchEvent(new Event("scroll"));
  expect(cache.get("side", "scroll")).toBe(200);
  stop();
  list.scrollTop = 300;
  list.dispatchEvent(new Event("scroll"));
  expect(cache.get("side", "scroll")).toBe(200);
  expect(to).not.toHaveBeenCalled();
});
