import { requestJson } from "../../shared/api/http.js";

export type PortalNotification = {
  id: string;
  kind: string;
  title?: string;
  message: string;
  deep_link?: string;
  published_at: string;
  read_at?: string;
  acknowledged_at?: string;
};

export type PortalNotificationFeed = {
  notifications: PortalNotification[];
};

const POLL_INTERVAL_MS = 60_000;

export const notificationPort = {
  list: () =>
    requestJson<PortalNotificationFeed>("/api/portal/me/notifications"),

  acknowledge: (id: string) =>
    requestJson<{ success: boolean }>(
      `/api/portal/me/notifications/${encodeURIComponent(id)}/acknowledge`,
      { method: "POST" },
    ),

  // Subscribes to the live notification feed. The server sends the full
  // unacknowledged feed on connect and after every publish; EventSource
  // reconnects automatically after transient drops. A permanent close (a
  // pre-login 401 closes EventSource in Chromium) is retried after a delay.
  // Falls back to 60s polling where EventSource is unavailable.
  subscribe: (
    listener: (feed: PortalNotificationFeed) => void,
  ): (() => void) => {
    if (typeof globalThis.EventSource === "undefined") {
      let stopped = false;
      const poll = () => {
        if (stopped) return;
        void notificationPort
          .list()
          .then(listener)
          .catch(() => undefined);
      };
      poll();
      const timer = setInterval(poll, POLL_INTERVAL_MS);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    }
    let stopped = false;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (stopped) return;
      const current = new EventSource("/api/portal/me/notifications/stream", {
        withCredentials: true,
      });
      source = current;
      current.addEventListener("notifications", (event) => {
        try {
          listener(JSON.parse((event as MessageEvent<string>).data));
        } catch {
          // A malformed feed event is ignored; the next publish or reconnect
          // delivers the full feed again.
        }
      });
      current.addEventListener("error", () => {
        if (current.readyState !== EventSource.CLOSED || source !== current)
          return;
        source = null;
        retry = setTimeout(connect, 15_000);
      });
    };
    connect();
    return () => {
      stopped = true;
      if (retry !== undefined) clearTimeout(retry);
      source?.close();
    };
  },
};
