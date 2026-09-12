// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMessageDelivery } from "./message-delivery.js";

let RuntimeConversation, RuntimeServices;
beforeEach(async () => {
  vi.resetModules();
  ({ RuntimeConversation } = await import("./page.js"));
  ({ RuntimeServices } = await import("./runtime.js"));
  const { bindConversationSettings } = await import("./preferences.js");
  bindConversationSettings({
    getSnapshot: () => ({ value: { busyEnter: "queue" } }),
    subscribe: () => () => {},
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  sessionStorage.clear();
  const storage = new Map();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
      clear: () => storage.clear(),
    },
  });
  vi.stubGlobal("localStorage", window.localStorage);
  window.history.replaceState({}, "", "/?session=session-delivery");
  window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  window.scrollTo = () => {};
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  document.body.innerHTML =
    '<aside class="hHd-Xa_root hHd-Xa_collapsed"></aside>';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fixture() {
  const projection = {
    sequence: 1,
    messages: [{ id: "old", role: "assistant", text: "Earlier answer" }],
    metadata: {
      id: "session-delivery",
      engine: "codex",
      title: "Delivery",
      queue: [],
    },
    activity: { state: "idle" },
    draft: "",
    progress: "",
    tools: {},
    processes: {},
  };
  const f = {
    server: projection,
    live: projection,
    gate: null,
    failure: false,
    requests: [],
  };
  const listeners = new Set();
  const face = {
    getSnapshot: () => f.live,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  f.publish = (value) => {
    f.live = value;
    listeners.forEach((fn) => fn());
  };
  const binding = { session: { projections: { faceOf: () => face } } };
  f.history = vi.fn(async () => ({
    result: {
      ok: true,
      value: {
        projections: {
          asOfSeq: f.server.sequence,
          values: { nativeSession: f.server },
        },
      },
    },
  }));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (path, init) => {
    let data = [];
    if (String(path) === "/api/session.prompt") {
      const request = JSON.parse(init.body);
      f.requests.push(request);
      await f.gate;
      if (f.failure) throw new Error("Connection lost");
      const row = {
        id: request.rpcId,
        role: "user",
        text: request.payload.content[0].text,
      };
      const queued =
        f.server.activity.state === "running" &&
        request.payload.mode === "queue";
      f.server = {
        ...f.server,
        sequence: f.server.sequence + 1,
        messages: queued ? f.server.messages : [...f.server.messages, row],
        metadata: queued
          ? {
              ...f.server.metadata,
              queue: [
                ...f.server.metadata.queue,
                { messageId: row.id, content: row.text },
              ],
            }
          : f.server.metadata,
        activity: { state: "running" },
      };
      data = { result: { ok: true, value: { accepted: true } } };
    } else if (String(path).endsWith("/sessions/session-delivery"))
      data = f.server.metadata;
    return new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
    });
  });
  const ctx = {
    sessions: { binding: () => binding, list: { subscribe: () => () => {} } },
    connection: { api: { sessions: { history: f.history } } },
    on: () => () => {},
  };
  f.view = render(<RuntimeServices.Provider value={ctx}><RuntimeConversation sessionId="session-delivery" /></RuntimeServices.Provider>);
  f.send = (text) => {
    const field = screen.getByLabelText("继续对话");
    field.textContent = text;
    fireEvent.input(field);
    fireEvent.submit(field.closest("form"));
  };
  return f;
}

it("shows an identified bubble before acceptance and synchronizes without any live push or page refresh", async () => {
  const f = fixture();
  await screen.findByText("Earlier answer");
  let accept;
  f.gate = new Promise((resolve) => {
    accept = resolve;
  });
  f.send("Immediate instruction");
  expect(
    screen.getByText("Immediate instruction").closest("article").className,
  ).toContain("is-user");
  expect(screen.getByText("发送中…")).toBeTruthy();
  const id = f.requests[0].rpcId;
  expect(document.querySelector(`[data-message-id="${id}"]`)).toBeTruthy();
  await act(async () => accept());
  await waitFor(() => expect(f.history.mock.calls.length).toBeGreaterThan(1));
  await screen.findByText("正在思考");
  expect(document.querySelectorAll(`[data-message-id="${id}"]`)).toHaveLength(
    1,
  );
  expect(screen.queryByText("发送中…")).toBeNull();
  await act(async () => f.publish(f.server));
  expect(document.querySelectorAll(`[data-message-id="${id}"]`)).toHaveLength(
    1,
  );
  // Delayed pre-send data cannot hide a message already recovered from history.
  await act(async () => f.publish({ ...f.server, sequence: 1, messages: [] }));
  expect(screen.getByText("Immediate instruction")).toBeTruthy();
});

it("recovers completion over history when the live stream remains stalled", async () => {
  const intervals = vi.spyOn(globalThis, "setInterval");
  const f = fixture();
  await screen.findByText("Earlier answer");
  f.send("Recover this turn");
  await screen.findByText("正在思考");
  f.server = {
    ...f.server,
    sequence: 9,
    activity: { state: "idle" },
    messages: [
      ...f.server.messages,
      { id: "final", role: "assistant", text: "Recovered final answer" },
    ],
  };
  const recover = intervals.mock.calls.find(([, delay]) => delay === 5000)[0];
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
  await act(async () => recover());
  await screen.findByText("Recovered final answer");
  expect(screen.queryByText("正在思考")).toBeNull();
});

it("keeps failed text, preserves a newly typed draft and retries with the exact same id", async () => {
  const f = fixture();
  await screen.findByText("Earlier answer");
  let release;
  f.gate = new Promise((resolve) => {
    release = resolve;
  });
  f.failure = true;
  f.send("Original instruction");
  const id = f.requests[0].rpcId;
  const field = screen.getByLabelText("继续对话");
  field.textContent = "New unsent draft";
  fireEvent.input(field);
  await act(async () => release());
  await screen.findByRole("button", { name: "重试发送" });
  expect(field.textContent).toBe("New unsent draft");
  expect(screen.getByText("Original instruction")).toBeTruthy();
  f.failure = false;
  f.gate = null;
  fireEvent.click(screen.getByRole("button", { name: "重试发送" }));
  await screen.findByText("正在思考");
  expect(f.requests[1].rpcId).toBe(id);
  expect(field.textContent).toBe("New unsent draft");
  expect(document.querySelectorAll(`[data-message-id="${id}"]`)).toHaveLength(
    1,
  );
});

it("shows queued input as one user bubble and moves it into history once consumed", async () => {
  const f = fixture();
  await screen.findByText("Earlier answer");
  await act(async () => {
    f.server = { ...f.server, sequence: 2, activity: { state: "running" } };
    f.publish(f.server);
  });
  f.send("Queued instruction");
  await screen.findByText("排队中");
  const id = f.requests[0].rpcId;
  expect(document.querySelectorAll(`[data-message-id="${id}"]`)).toHaveLength(
    1,
  );
  await act(async () => {
    f.server = {
      ...f.server,
      sequence: 5,
      metadata: { ...f.server.metadata, queue: [] },
      messages: [
        ...f.server.messages,
        { id, role: "user", text: "Queued instruction" },
      ],
    };
    f.publish(f.server);
  });
  expect(document.querySelectorAll(`[data-message-id="${id}"]`)).toHaveLength(
    1,
  );
  expect(screen.queryByText("排队中")).toBeNull();
});

it("retains unresolved receipts across reload and reconciles only matching identities", () => {
  const store = createMessageDelivery(React);
  store.update("a", { id: "first", text: "same", status: "sending" });
  store.update("a", { id: "second", text: "same", status: "failed" });
  const restored = createMessageDelivery(React);
  expect(restored.get("a").map((row) => row.status)).toEqual([
    "failed",
    "failed",
  ]);
  restored.reconcile("a", [{ id: "first" }], []);
  expect(restored.get("a").map((row) => row.id)).toEqual(["second"]);
  expect(restored.get("b")).toEqual([]);
});
