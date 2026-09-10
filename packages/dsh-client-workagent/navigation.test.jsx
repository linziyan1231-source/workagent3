// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createNavigation, createConversationCache } from "./src/navigation.js";

afterEach(cleanup);
it("notifies navigation even when selecting the current conversation or home again", () => {
  history.replaceState(null, "", "/?frontend=dsh&session=current");
  let selections = 0;
  const nav = createNavigation(React, () => selections++);
  nav.navigate(location.href);
  expect(selections).toBe(1);
  nav.navigate("/?frontend=dsh");
  nav.navigate("/?frontend=dsh");
  expect(selections).toBe(3);
});
it("updates independent route consumers and handles browser history without replacing the document", async () => {
  history.replaceState(null, "", "/?frontend=dsh");
  const nav = createNavigation(React);
  function Consumer({ name }) {
    return <output data-testid={name}>{nav.useSearch()}</output>;
  }
  render(
    <>
      <Consumer name="sidebar" />
      <Consumer name="conversation" />
    </>,
  );
  const originalDocument = document;
  act(() => nav.navigate("/?session=alpha"));
  expect(screen.getByTestId("sidebar").textContent).toContain("session=alpha");
  expect(screen.getByTestId("conversation").textContent).toContain(
    "session=alpha",
  );
  act(() => nav.navigate("/?session=beta"));
  await act(async () => {
    await new Promise((resolve) => {
      window.addEventListener("popstate", resolve, { once: true });
      history.back();
    });
  });
  expect(screen.getByTestId("conversation").textContent).toContain(
    "session=alpha",
  );
  expect(document).toBe(originalDocument);
});

it("routes same-tab conversation links while preserving modified clicks and new tabs", () => {
  history.replaceState(null, "", "/?frontend=dsh");
  const nav = createNavigation(React);
  const stop = nav.install();
  // Observe native-default eligibility, then suppress jsdom's unimplemented navigation.
  const defaults = [];
  const captureDefault = (event) => {
    defaults.push(!event.defaultPrevented);
    event.preventDefault();
  };
  document.addEventListener("click", captureDefault);
  render(
    <>
      <a href="/?session=linked">
        <span>chat</span>
      </a>
      <a href="/?session=new-tab" target="_blank">
        tab
      </a>
    </>,
  );
  try {
    fireEvent.click(screen.getByText("chat"), { ctrlKey: true });
    expect(location.search).not.toContain("session=");
    fireEvent.click(screen.getByText("tab"));
    expect(location.search).not.toContain("session=");
    fireEvent.click(screen.getByText("chat"));
    expect(location.search).toContain("session=linked");
    expect(defaults).toEqual([true, true, false]);
  } finally {
    stop();
    document.removeEventListener("click", captureDefault);
  }
});

it("evicts entire least-recently-used conversations and bounds transcript memory", () => {
  const cache = createConversationCache(2, 200);
  cache.set("a", "native", ["old"]);
  cache.set("a", "scroll", 42);
  cache.set("b", "native", ["second"]);
  expect(cache.get("a", "scroll")).toBe(42);
  cache.set("c", "native", ["third"]);
  expect(cache.get("b", "native")).toBeUndefined();
  cache.set("a", "native", "x".repeat(200));
  expect(cache.get("a", "native")).toBeUndefined();
  expect(cache.get("a", "scroll")).toBeUndefined();
  expect(cache.get("c", "native")).toEqual(["third"]);
});
