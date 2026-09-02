import { afterEach, expect, test, vi } from "vitest";
import { notificationPort } from "./notificationPort.js";

afterEach(() => vi.unstubAllGlobals());

test("notification port uses same-origin authenticated endpoints", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('{"notifications":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(
      new Response('{"success":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  vi.stubGlobal("fetch", fetchMock);

  await notificationPort.list();
  await notificationPort.acknowledge("notice/unsafe");

  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/portal/me/notifications");
  expect(fetchMock.mock.calls[1]?.[0]).toBe(
    "/api/portal/me/notifications/notice%2Funsafe/acknowledge",
  );
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
    method: "POST",
    credentials: "same-origin",
  });
});

test("notification stream subscribes over EventSource and closes on unsubscribe", () => {
  class FakeEventSource {
    static readonly CLOSED = 2;
    static latest: FakeEventSource;
    readonly listeners = new Map<string, (event: MessageEvent) => void>();
    readyState = 1;

    constructor(
      readonly url: string,
      readonly options: EventSourceInit,
    ) {
      FakeEventSource.latest = this;
    }

    addEventListener(name: string, listener: EventListener) {
      this.listeners.set(name, listener as (event: MessageEvent) => void);
    }

    close() {
      this.readyState = FakeEventSource.CLOSED;
    }

    emit(name: string, payload: unknown) {
      this.listeners.get(name)?.({
        data: JSON.stringify(payload),
      } as MessageEvent);
    }
  }
  vi.stubGlobal("EventSource", FakeEventSource);
  const received = vi.fn();
  const unsubscribe = notificationPort.subscribe(received);

  expect(FakeEventSource.latest.url).toBe(
    "/api/portal/me/notifications/stream",
  );
  expect(FakeEventSource.latest.options.withCredentials).toBe(true);
  FakeEventSource.latest.emit("notifications", {
    notifications: [{ id: "n-1", kind: "team", message: "done" }],
  });
  expect(received).toHaveBeenCalledWith({
    notifications: [expect.objectContaining({ id: "n-1" })],
  });
  // A malformed event is ignored without killing the subscription.
  FakeEventSource.latest.listeners.get("notifications")?.({
    data: "{not json",
  } as MessageEvent);
  expect(received).toHaveBeenCalledTimes(1);

  unsubscribe();
  expect(FakeEventSource.latest.readyState).toBe(FakeEventSource.CLOSED);
});

test("notification stream recreates a permanently closed source", () => {
  vi.useFakeTimers();
  try {
    class FakeEventSource {
      static readonly CLOSED = 2;
      static instances: FakeEventSource[] = [];
      readonly listeners = new Map<string, (event: MessageEvent) => void>();
      readyState = 1;

      constructor(
        readonly url: string,
        readonly options: EventSourceInit,
      ) {
        FakeEventSource.instances.push(this);
      }

      addEventListener(name: string, listener: EventListener) {
        this.listeners.set(name, listener as (event: MessageEvent) => void);
      }

      close() {
        this.readyState = FakeEventSource.CLOSED;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const unsubscribe = notificationPort.subscribe(vi.fn());
    expect(FakeEventSource.instances).toHaveLength(1);

    // A pre-login 401 closes the source permanently; the subscriber retries.
    const first = FakeEventSource.instances[0]!;
    first.readyState = FakeEventSource.CLOSED;
    first.listeners.get("error")?.({} as MessageEvent);
    vi.advanceTimersByTime(15_000);
    expect(FakeEventSource.instances).toHaveLength(2);

    // Unsubscribing stops the retry loop.
    const second = FakeEventSource.instances[1]!;
    unsubscribe();
    second.readyState = FakeEventSource.CLOSED;
    second.listeners.get("error")?.({} as MessageEvent);
    vi.advanceTimersByTime(30_000);
    expect(FakeEventSource.instances).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});
