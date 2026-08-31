import { afterEach, expect, it, vi } from "vitest";
import { teamPort } from "./teamPort.js";

afterEach(() => vi.unstubAllGlobals());

it("routes team lifecycle through the employee Runtime proxy", async () => {
  const team = {
    id: "team-1",
    version: 1,
    name: "Launch",
    workspaceId: "workspace-1",
    members: [
      {
        id: "member-1",
        name: "Lead",
        engine: "harness",
        presetId: "preset-1",
        role: "lead",
        status: "idle",
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(
        JSON.stringify(
          init?.method === "POST" ? { ...team, id: "team-2" } : [team],
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  expect(await teamPort.list()).toHaveLength(1);
  expect(
    (
      await teamPort.create({
        name: "Launch",
        workspaceId: "workspace-1",
        lead: { name: "Lead", engine: "harness", presetId: "preset-1" },
      })
    ).id,
  ).toBe("team-2");
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/runtime/v1/teams");
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
});
