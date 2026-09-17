import { afterEach, expect, test, vi } from "vitest";
import { publishingApi } from "./publishingApi.js";

afterEach(() => vi.unstubAllGlobals());

test("settings save issues a PUT with the port range and quota", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        firstPort: 21134,
        lastPort: 21174,
        maxEmployeePorts: 3,
        totalPorts: 41,
        usedPorts: 0,
        employeeUsage: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const input = { firstPort: 21134, lastPort: 21174, maxEmployeePorts: 3 };
  const result = await publishingApi.save(input);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/portal/admin/published-apps/settings",
    expect.objectContaining({
      method: "PUT",
      credentials: "same-origin",
      body: JSON.stringify(input),
    }),
  );
  expect(result.totalPorts).toBe(41);
});

test("list fetches every published app and unpublish issues a POST", async () => {
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify({ apps: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const result = await publishingApi.list();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/portal/admin/published-apps",
    expect.objectContaining({ credentials: "same-origin" }),
  );
  expect(result.apps).toEqual([]);
  await publishingApi.unpublish("app-1");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/portal/admin/published-apps/app-1/unpublish",
    expect.objectContaining({ method: "POST", credentials: "same-origin" }),
  );
});
