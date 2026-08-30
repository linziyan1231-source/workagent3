import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAutomationHandler } from "./automation-api.js";
import { AutomationScheduler, AutomationStore } from "./automation-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "workagent-automation-api-"));
  roots.push(root);
  const store = new AutomationStore(root);
  const scheduler = new AutomationScheduler(store, {
    execute: async ({ automationRunId }) => ({
      sessionId: `session-${automationRunId}`,
    }),
  });
  return {
    store,
    handler: createAutomationHandler("runtime-secret", store, scheduler),
  };
};

type Recorded = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

const invoke = async (
  handler: ReturnType<typeof createAutomationHandler>,
  method: string,
  url: string,
  input?: unknown,
  authorized = true,
): Promise<Recorded> => {
  const source = input === undefined ? [] : [JSON.stringify(input)];
  const request = Readable.from(source) as IncomingMessage;
  Object.assign(request, {
    method,
    url,
    headers: authorized ? { authorization: "Bearer runtime-secret" } : {},
  });
  const recorded: Recorded = { status: 0, headers: {}, body: "" };
  const response = new EventEmitter() as ServerResponse;
  Object.assign(response, {
    writeHead: (status: number, headers: Record<string, string> = {}) => {
      recorded.status = status;
      recorded.headers = headers;
      return response;
    },
    end: (body = "") => {
      recorded.body = String(body);
      return response;
    },
  });
  await handler(request, response);
  return recorded;
};

const mutation = {
  name: "Daily brief",
  enabled: false,
  schedule: { kind: "interval", everyMinutes: 30 },
  presetId: "builtin-general",
  engine: "harness",
  workspaceId: "workspace-default",
  input: "Prepare the brief",
  notificationPolicy: "on_failure",
};

describe("Automation runtime API", () => {
  it("requires the private Runtime bearer token", async () => {
    const { handler } = setup();
    const response = await invoke(
      handler,
      "GET",
      "/v1/automations",
      undefined,
      false,
    );
    expect(response.status).toBe(401);
  });

  it("creates, lists, updates, runs, and reads history", async () => {
    const { handler } = setup();
    const created = await invoke(handler, "POST", "/v1/automations", mutation);
    expect(created.status).toBe(201);
    const automation = JSON.parse(created.body) as {
      id: string;
      version: number;
    };

    const updated = await invoke(
      handler,
      "PATCH",
      `/v1/automations/${automation.id}`,
      {
        version: automation.version,
        name: "Renamed brief",
      },
    );
    expect(updated.status).toBe(200);
    expect(JSON.parse(updated.body)).toMatchObject({
      name: "Renamed brief",
      version: 2,
    });

    const run = await invoke(
      handler,
      "POST",
      `/v1/automations/${automation.id}/run`,
    );
    expect(run.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const history = await invoke(
      handler,
      "GET",
      `/v1/automations/${automation.id}/runs`,
    );
    expect(JSON.parse(history.body)[0]).toMatchObject({ status: "succeeded" });

    const list = await invoke(handler, "GET", "/v1/automations");
    expect(JSON.parse(list.body)).toHaveLength(1);
  });

  it("rejects stale updates", async () => {
    const { handler } = setup();
    const created = JSON.parse(
      (await invoke(handler, "POST", "/v1/automations", mutation)).body,
    ) as { id: string };
    const response = await invoke(
      handler,
      "PATCH",
      `/v1/automations/${created.id}`,
      {
        version: 99,
        name: "Stale",
      },
    );
    expect(response.status).toBe(409);
  });
});
