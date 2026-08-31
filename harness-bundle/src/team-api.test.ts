import { createServer, request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTeamHandler } from "./team-api.js";
import { TeamOrchestrator, TeamStore } from "./team-store.js";

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
    createTeamHandler("runtime-token", store, orchestrator),
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
