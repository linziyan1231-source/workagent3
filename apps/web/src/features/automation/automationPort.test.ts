import { afterEach, describe, expect, it, vi } from "vitest";
import { automationPort } from "./automationPort.js";

afterEach(() => vi.unstubAllGlobals());

describe("AutomationPort", () => {
  it("loads SID-private tasks through the same-origin runtime proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(automationPort.list()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/v1/automations",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("encodes task and run IDs for cancellation", async () => {
    const response = {
      id: "run/unsafe",
      automationId: "task/unsafe",
      definitionSnapshot: {
        id: "task/unsafe",
        version: 1,
        name: "Brief",
        enabled: false,
        schedule: { kind: "interval", everyMinutes: 30 },
        presetId: "builtin-general",
        engine: "harness",
        workspaceId: "workspace-default",
        input: "Brief me",
        notificationPolicy: "none",
        nextRunAt: null,
        lastRunAt: null,
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-31T00:00:00.000Z",
      },
      trigger: "manual",
      scheduledFor: "2026-08-31T00:00:00.000Z",
      status: "cancelled",
      attempt: 1,
      sessionId: null,
      result: null,
      error: null,
      createdAt: "2026-08-31T00:00:00.000Z",
      startedAt: "2026-08-31T00:00:00.000Z",
      finishedAt: "2026-08-31T00:01:00.000Z",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await automationPort.cancel("task/unsafe", "run/unsafe");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/v1/automations/task%2Funsafe/runs/run%2Funsafe/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
