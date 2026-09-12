// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mutatePreset, usePresets } from "./api.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("refreshes independent assistant consumers only after a successful mutation", async () => {
  let rows = [{ id: "one" }];
  let fail = false;
  const fetch = vi.fn(async (_url, init) => {
    if (init?.method === "POST" && fail) return new Response('{"error":"rejected"}', { status: 409 });
    if (init?.method === "POST") rows = [{ id: "two" }];
    return new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  const first = renderHook(() => usePresets());
  const second = renderHook(() => usePresets((items) => items.map(item => ({ id: item.id + "-selected" }))));
  await waitFor(() => expect(first.result.current[0].rows).toEqual([{ id: "one" }]));
  const error = vi.fn();
  await act(async () => { expect(await mutatePreset(vi.fn(), error, "/api/runtime/v1/presets", "POST", {})).toBe(true); });
  await waitFor(() => expect(second.result.current[0].rows).toEqual([{ id: "two-selected" }]));
  expect(first.result.current[0].rows).toEqual([{ id: "two" }]);
  fetch.mockClear(); fail = true;
  await act(async () => { expect(await mutatePreset(vi.fn(), error, "/api/runtime/v1/presets", "POST", {})).toBe(false); });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenLastCalledWith("rejected");
  first.unmount(); second.unmount();
  fetch.mockClear();
  window.dispatchEvent(new Event("workagent:presets-changed"));
  expect(fetch).not.toHaveBeenCalled();
});
