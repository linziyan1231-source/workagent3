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

  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "/api/portal/me/notifications",
  );
  expect(fetchMock.mock.calls[1]?.[0]).toBe(
    "/api/portal/me/notifications/notice%2Funsafe/acknowledge",
  );
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
    method: "POST",
    credentials: "same-origin",
  });
});
