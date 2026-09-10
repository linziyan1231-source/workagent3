import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect, vi } from "vitest";
import { RuntimePreferences } from "./runtime-preferences.js";
it("persists timeouts and never cancels a newer or completed turn through an old timer", async () => {
  const home = mkdtempSync(join(tmpdir(), "wa-preferences-"));
  vi.useFakeTimers();
  const store = new RuntimePreferences(home);
  const cancel = vi.fn(async () => {});
  try {
    store.started("one", "unlimited", cancel);
    await vi.advanceTimersByTimeAsync(100000);
    expect(cancel).not.toHaveBeenCalled();
    store.set({ turnTimeoutSeconds: 10 });
    expect(new RuntimePreferences(home).get()).toEqual({
      turnTimeoutSeconds: 10,
    });
    store.started("one", "old", cancel);
    await vi.advanceTimersByTimeAsync(5000);
    store.started("one", "new", cancel);
    store.ended("one", "old");
    await vi.advanceTimersByTimeAsync(5000);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(cancel).toHaveBeenCalledTimes(1);
    store.started("one", "complete", cancel);
    store.ended("one", "complete");
    await vi.advanceTimersByTimeAsync(20000);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(() => store.set({ turnTimeoutSeconds: -1 })).toThrow();
  } finally {
    store.close();
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  }
});
