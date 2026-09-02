import { createServer, request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTeamHandler } from "./team-api.js";
import {
  TeamOrchestrator,
  type TeamSessionRequest,
  TeamStore,
} from "./team-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

const call = (
  port: number,
  method: string,
  path: string,
  token?: string,
  value?: unknown,
) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = value === undefined ? undefined : JSON.stringify(value);
    const req = request(
      {
        port,
        method,
        path,
        headers: {
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
              }),
        },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += String(chunk)));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: text }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

it("authenticates team routes and exposes lifecycle state", async () => {
  const home = mkdtempSync(join(tmpdir(), "workagent-team-api-"));
  roots.push(home);
  const store = new TeamStore(home);
  const orchestrator = new TeamOrchestrator(store, {
    executeTeamTask: async () => ({ sessionId: "session-1" }),
  });
  const server = createServer(
    createTeamHandler("runtime-token", store, orchestrator, {
      openTeamSession: async () => undefined,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("missing address");
    expect((await call(address.port, "GET", "/v1/teams")).status).toBe(401);
    const created = await call(
      address.port,
      "POST",
      "/v1/teams",
      "runtime-token",
      {
        name: "Launch",
        workspaceId: "workspace-1",
        lead: { name: "Lead", engine: "codex", presetId: "preset-1" },
      },
    );
    expect(created.status).toBe(201);
    const team = JSON.parse(created.body) as {
      id: string;
      members: { id: string }[];
    };
    const queued = await call(
      address.port,
      "POST",
      `/v1/teams/${team.id}/tasks`,
      "runtime-token",
      {
        memberId: team.members[0]!.id,
        title: "Review",
        input: "Review launch",
      },
    );
    expect(queued.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const tasks = await call(
      address.port,
      "GET",
      `/v1/teams/${team.id}/tasks`,
      "runtime-token",
    );
    expect(JSON.parse(tasks.body)[0]).toMatchObject({
      status: "succeeded",
      sessionId: "session-1",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

const serve = async (
  store: TeamStore,
  openTeamSession: (request: TeamSessionRequest) => Promise<void> = async () =>
    undefined,
) => {
  const orchestrator = new TeamOrchestrator(store, {
    executeTeamTask: async () => ({ sessionId: "session-1" }),
  });
  const server = createServer(
    createTeamHandler("runtime-token", store, orchestrator, {
      openTeamSession,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("missing address");
  return { server, port: address.port };
};

const close = (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

it("opens the lead session when a team is created and rolls back on failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "workagent-team-api-"));
  roots.push(home);
  const store = new TeamStore(home);
  const opened: TeamSessionRequest[] = [];
  const { server, port } = await serve(store, async (request) => {
    opened.push(request);
  });
  try {
    const created = await call(port, "POST", "/v1/teams", "runtime-token", {
      name: "Launch",
      workspaceId: "workspace-1",
      lead: { name: "Lead", engine: "codex", presetId: "preset-1" },
    });
    expect(created.status).toBe(201);
    const team = JSON.parse(created.body) as {
      id: string;
      members: { sessionId: string }[];
    };
    expect(opened).toEqual([
      {
        sessionId: team.members[0]!.sessionId,
        title: "Launch · Lead",
        engine: "codex",
        presetId: "preset-1",
        workspaceId: "workspace-1",
      },
    ]);

    const added = await call(
      port,
      "POST",
      `/v1/teams/${team.id}/members`,
      "runtime-token",
      { name: "Reviewer", engine: "kimi", presetId: "preset-2" },
    );
    expect(added.status).toBe(201);
    expect(opened).toHaveLength(2);
    expect(opened[1]).toMatchObject({
      engine: "kimi",
      title: "Launch · Reviewer",
    });
  } finally {
    await close(server);
  }

  const failing = await serve(store, async () => {
    throw new Error("engine_start_failed");
  });
  try {
    const failed = await call(
      failing.port,
      "POST",
      "/v1/teams",
      "runtime-token",
      {
        name: "Doomed",
        workspaceId: "workspace-1",
        lead: { name: "Lead", engine: "codex", presetId: "preset-1" },
      },
    );
    expect(failed.status).toBe(400);
    expect(store.list().every((team) => team.name !== "Doomed")).toBe(true);

    const launch = store.list().find((team) => team.name === "Launch")!;
    const memberFailed = await call(
      failing.port,
      "POST",
      `/v1/teams/${launch.id}/members`,
      "runtime-token",
      { name: "Ghost", engine: "codex", presetId: "preset-1" },
    );
    expect(memberFailed.status).toBe(400);
    expect(
      store.get(launch.id)!.members.every((member) => member.name !== "Ghost"),
    ).toBe(true);
  } finally {
    await close(failing.server);
  }
});

it("updates session mode through the team patch route", async () => {
  const home = mkdtempSync(join(tmpdir(), "workagent-team-api-"));
  roots.push(home);
  const store = new TeamStore(home);
  const { server, port } = await serve(store);
  try {
    const created = await call(port, "POST", "/v1/teams", "runtime-token", {
      name: "Launch",
      workspaceId: "workspace-1",
      lead: { name: "Lead", engine: "codex", presetId: "preset-1" },
    });
    const team = JSON.parse(created.body) as { id: string; version: number };
    const patched = await call(
      port,
      "PATCH",
      `/v1/teams/${team.id}`,
      "runtime-token",
      { version: team.version, sessionMode: "auto" },
    );
    expect(patched.status).toBe(200);
    expect(JSON.parse(patched.body)).toMatchObject({ sessionMode: "auto" });
  } finally {
    await close(server);
  }
});

it("exposes a global team event stream across teams, including removals", async () => {
  const home = mkdtempSync(join(tmpdir(), "workagent-team-api-"));
  roots.push(home);
  const store = new TeamStore(home);
  const { server, port } = await serve(store);
  try {
    const created = await call(port, "POST", "/v1/teams", "runtime-token", {
      name: "Launch",
      workspaceId: "workspace-1",
      lead: { name: "Lead", engine: "codex", presetId: "preset-1" },
    });
    const team = JSON.parse(created.body) as { id: string };

    const events = await call(port, "GET", "/v1/teams/events", "runtime-token");
    expect(events.status).toBe(200);
    expect(JSON.parse(events.body)).toMatchObject([{ type: "team.created" }]);

    const sse = await new Promise<string>((resolve, reject) => {
      let deleted = false;
      const req = request(
        {
          port,
          method: "GET",
          path: "/v1/teams/events?after=0",
          headers: {
            authorization: "Bearer runtime-token",
            accept: "text/event-stream",
          },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => {
            text += String(chunk);
            if (!deleted && text.includes("team.created")) {
              deleted = true;
              store.delete(team.id);
            }
            if (text.includes("team.removed")) {
              req.destroy();
              resolve(text);
            }
          });
        },
      );
      req.on("error", () => resolve(""));
      req.end();
    });
    expect(sse).toContain("event: team.created");
    expect(sse).toContain("event: team.removed");
  } finally {
    await close(server);
  }
});
