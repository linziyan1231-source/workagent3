import { afterEach, expect, test, vi } from "vitest";
import { systemPort } from "./systemPort.js";

afterEach(() => vi.unstubAllGlobals());

test("system port reads status and requests the current SID runtime restart", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        '{"build":{"version":"1.0.0","commit":"abc","build_time":"now"},"components":[]}',
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    .mockResolvedValueOnce(
      new Response('{"reconnect_after_ms":4000}', {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
  vi.stubGlobal("fetch", fetchMock);

  await systemPort.status();
  await systemPort.restartRuntime();

  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/system/status");
  expect(fetchMock.mock.calls[1]?.[0]).toBe(
    "/api/system/runtime/restart",
  );
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
    method: "POST",
    credentials: "same-origin",
  });
});
