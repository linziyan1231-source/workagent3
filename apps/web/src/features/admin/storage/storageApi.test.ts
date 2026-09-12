import { afterEach, expect, test, vi } from "vitest";
import { storageApi, gibibytesToBytes } from "./storageApi.js";

afterEach(() => vi.unstubAllGlobals());

test("storage reads keep the caller's abort signal and encode the selected account", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController();
  await storageApi.usage("alice&other", controller.signal);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/portal/admin/storage?username=alice%26other",
    expect.objectContaining({
      signal: controller.signal,
      credentials: "same-origin",
    }),
  );
});

test("personal and owned shared storage limits are replaced together as integer bytes", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  await storageApi.update("alice", {
    personalBytes: gibibytesToBytes("1.5"),
    sharedBytes: gibibytesToBytes("0.001"),
  });
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/portal/admin/storage",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({
        username: "alice",
        limits: { personalBytes: 1610612736, sharedBytes: 1073742 },
      }),
    }),
  );
});
