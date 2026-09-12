import { afterEach, expect, test, vi } from "vitest";
import { usageApi } from "./usageApi.js";

afterEach(() => vi.unstubAllGlobals());

test("usage intervals cross the API in UTC while usernames remain a single query parameter", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"rows":[]}'));
  vi.stubGlobal("fetch", fetchMock);
  await usageApi.usage(
    "alice&pool=other",
    "2026-09-12T08:00:00+08:00",
    "2026-09-12T09:00:00+08:00",
  );
  const url = new URL(fetchMock.mock.calls[0][0], "https://example.test");
  expect(url.pathname).toBe("/api/portal/admin/usage");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    username: "alice&pool=other",
    from: "2026-09-12T00:00:00.000Z",
    to: "2026-09-12T01:00:00.000Z",
  });
});

test.each([
  ["2026-09-12T01:00:00Z", "2026-09-12T01:00:00Z"],
  ["2026-09-12T02:00:00Z", "2026-09-12T01:00:00Z"],
  ["invalid", "2026-09-12T01:00:00Z"],
])(
  "rejects an invalid usage interval without making a request (%s, %s)",
  (from, to) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => usageApi.usage("alice", from, to)).toThrow("interval");
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test("quota adjustments preserve model, scope and units and dollar budgets use their own endpoint", async () => {
  const fetchMock = vi
    .fn()
    .mockImplementation(() => Promise.resolve(new Response('{"budgets":[]}')));
  vi.stubGlobal("fetch", fetchMock);
  await usageApi.adjust("alice", "speech-transcription", "permanent", 3600);
  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "/api/portal/admin/quotas",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        username: "alice",
        modelId: "speech-transcription",
        mode: "permanent",
        limitUnits: 3600,
      }),
    }),
  );
  await usageApi.dollars("alice&next");
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/quota/dollars?username=alice%26next",
    expect.anything(),
  );
});
