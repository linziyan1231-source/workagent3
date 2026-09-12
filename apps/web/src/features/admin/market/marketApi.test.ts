import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "../../../shared/api/http.js";
import { marketApi } from "./marketApi.js";

afterEach(() => vi.unstubAllGlobals());

test("market actions retain the selected series, version, action and reason", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  const selection = {
    seriesId: "skill-series",
    targetId: "version-2",
    action: "update",
    reason: "修复",
  };
  await marketApi.act(selection);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/portal/admin/marketplace",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify(selection),
    }),
  );
});

test("unlist posts the series action without a target version", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  const selection = {
    seriesId: "skill-series",
    targetId: "",
    action: "unlist",
    reason: "违规内容",
  };
  await marketApi.act(selection);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/portal/admin/marketplace",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(selection),
    }),
  );
});

test("retry identifies the prior action without creating a new market selection", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  await marketApi.retry("action-1");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/portal/admin/marketplace",
    expect.objectContaining({
      body: JSON.stringify({ retryId: "action-1" }),
    }),
  );
});

test("market policy failures remain typed for shared error presentation", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response('{"error":"administrator_required"}', { status: 403 }),
      ),
  );
  await expect(marketApi.catalog()).rejects.toEqual(
    new ApiError(403, "administrator_required"),
  );
});
