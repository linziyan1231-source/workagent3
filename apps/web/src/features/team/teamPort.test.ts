import { afterEach, expect, it, vi } from "vitest";
import { teamPort } from "./teamPort.js";
import type { TeamEvent } from "@workagent/contracts";

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

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener as (event: MessageEvent<string>) => void);
  }
  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({
      data: JSON.stringify(data),
    } as MessageEvent<string>);
  }
}

const teamEvent = (
  overrides: Partial<TeamEvent> = {},
): Record<string, unknown> => ({
  id: "event-1",
  teamId: "team-1",
  sequence: 7,
  type: "task.queued",
  subjectId: "team-task-1",
  occurredAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

it("streams global team events with typed dispatch and a working unsubscribe", () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  const listener = vi.fn();
  const off = teamPort.subscribeAll(3, listener);

  const source = FakeEventSource.instances.at(-1)!;
  expect(source.url).toBe("/api/runtime/v1/teams/events?after=3");

  source.emit("team.created", teamEvent({ type: "team.created" }));
  source.emit("member.added", teamEvent({ type: "member.added" }));
  expect(
    listener.mock.calls.map(([event]) => (event as TeamEvent).type),
  ).toEqual(["team.created", "member.added"]);

  off();
  expect(source.closed).toBe(true);
  source.emit("team.removed", teamEvent({ type: "team.removed" }));
  expect(listener).toHaveBeenCalledTimes(2);
});

it("rejects malformed stream payloads instead of delivering them", () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  const listener = vi.fn();
  teamPort.subscribeAll(0, listener);
  const source = FakeEventSource.instances.at(-1)!;
  expect(() => source.emit("team.created", { broken: true })).toThrow();
  expect(listener).not.toHaveBeenCalled();
});

it("fetches global events and patches session mode", async () => {
  const team = {
    id: "team-1",
    version: 2,
    name: "Launch",
    workspaceId: "workspace-1",
    sessionMode: null,
    members: [
      {
        id: "member-1",
        name: "Lead",
        engine: "harness",
        presetId: "preset-1",
        role: "lead",
        status: "idle",
        sessionId: "session-member-1",
        createdAt: "2026-09-01T00:00:00.000Z",
      },
    ],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      new Response(
        JSON.stringify(
          init?.method === "PATCH"
            ? { ...team, sessionMode: "auto", version: 3 }
            : [teamEvent()],
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);

  expect((await teamPort.eventsAll(5))[0]?.sequence).toBe(7);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "/api/runtime/v1/teams/events?after=5",
  );

  const updated = await teamPort.setSessionMode(team as never, "auto");
  expect(updated.sessionMode).toBe("auto");
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
    method: "PATCH",
    body: JSON.stringify({ version: 2, sessionMode: "auto" }),
  });
});
