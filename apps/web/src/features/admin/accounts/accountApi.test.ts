import { afterEach, expect, test, vi } from "vitest";
import { accountApi } from "./accountApi.js";

afterEach(() => vi.unstubAllGlobals());

test("account provisioning keeps Portal credentials separate and returns the background job", async () => {
  const job = {
    id: "create-1",
    username: "alice",
    status: "running",
    percent: 0,
    step: "queued",
  };
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ job })));
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    accountApi.create("alice", "example portal password"),
  ).resolves.toEqual({ job });
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/portal/admin/users",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: "alice",
        portal_password: "example portal password",
      }),
    }),
  );
});

test("maintenance uses the account action endpoint and encodes job identifiers", async () => {
  const fetchMock = vi
    .fn()
    .mockImplementation(() => Promise.resolve(new Response("{}")));
  vi.stubGlobal("fetch", fetchMock);
  await accountApi.action("alice", "rename-windows", {
    new_windows_username: "alice.work",
  });
  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    "/api/portal/admin/users/rename-windows",
    expect.objectContaining({
      body: JSON.stringify({
        username: "alice",
        new_windows_username: "alice.work",
      }),
    }),
  );
  await accountApi.job("job/1?&=2");
  expect(fetchMock).toHaveBeenNthCalledWith(
    2,
    "/api/portal/admin/user-jobs?id=job%2F1%3F%26%3D2",
    expect.anything(),
  );
});

test("data-source grants send only account policy fields and accept an empty success response", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  const grant = {
    enabled: true,
    allowed_sources: ["reports"],
    daily_limit: 10,
    monthly_limit: 100,
  };
  await expect(
    accountApi.setDatasource("alice", grant),
  ).resolves.toBeUndefined();
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/portal/admin/users/kimi-datasource",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ username: "alice", ...grant }),
    }),
  );
});
