import { afterEach, expect, test, vi } from "vitest";
import { auditApi } from "./auditApi.js";

afterEach(() => vi.unstubAllGlobals());

test("audit export and listing use the same encoded filter and result limit", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"events":[]}'));
  vi.stubGlobal("fetch", fetchMock);
  await auditApi.events("quota.adjust&actor=another");
  const list = new URL(fetchMock.mock.calls[0][0], "https://example.test");
  const download = new URL(
    auditApi.exportUrl("quota.adjust&actor=another"),
    "https://example.test",
  );
  expect(list.pathname).toBe("/api/portal/admin/audit");
  expect(download.pathname).toBe("/api/portal/admin/audit/export");
  expect(download.search).toBe(list.search);
  expect(Object.fromEntries(list.searchParams)).toEqual({
    limit: "100",
    action: "quota.adjust&actor=another",
  });
});
