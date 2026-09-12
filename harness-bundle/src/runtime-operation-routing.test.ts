import { Context, Service } from "@deepseek-ai/cordis";
import { WebServer } from "@deepseek-ai/dsh-host-webserver";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeController } from "./runtime.js";
import { WorkspaceStore } from "./workspace-store.js";
import { PresetStore } from "./preset-store.js";
import {
  ModelAccessStore,
  type CredentialStatusStore,
} from "./model-access-store.js";
import { McpCatalogStore, SkillCatalogStore } from "./capability-store.js";

afterEach(() => vi.unstubAllEnvs());

it("dispatches session operation authentication, create, lookup and cancellation through the actual host HTTP router", async () => {
  const home = mkdtempSync(join(tmpdir(), "workagent-operation-router-"));
  vi.stubEnv("DSH_HOME", home);
  const disposers: (() => unknown)[] = [];
  const webContext = new Context();
  const effect = webContext.effect.bind(webContext);
  vi.spyOn(webContext, "effect").mockImplementation((callback, label) => {
    const dispose = effect(callback, label);
    disposers.push(() => dispose());
    return dispose;
  });
  const webServer = new WebServer(webContext, { host: "127.0.0.1", port: 0 });
  await webServer[Service.init]();
  const ctx = {
    effect: (callback: () => unknown) => callback(),
    on: () => () => {},
    webServer,
    agentDefaultModel: { currentSelection: () => ({ provider: "unused" }) },
    llm: { listModels: async () => [] },
  } as unknown as Context;
  const skills = new SkillCatalogStore();
  const presets = new PresetStore(home, new ModelAccessStore(home), skills);
  const runtime = new RuntimeController(
    ctx,
    "routing-test-token",
    new WorkspaceStore(join(home, "workspaces"), home),
    presets,
    new McpCatalogStore(),
    skills,
    {
      statusFor: () => ({ state: "ready" }),
    } as unknown as CredentialStatusStore,
    { reserve: vi.fn(), settle: vi.fn() },
  );
  runtime.mount();
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    authenticated = true,
  ) =>
    fetch(`http://127.0.0.1:${webServer.port}${path}`, {
      method,
      headers: {
        ...(authenticated
          ? { authorization: "Bearer routing-test-token" }
          : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(3000),
    });
  try {
    const operation = "/v1/session-operations/routing-operation";
    expect((await request(operation, "GET", undefined, false)).status).toBe(
      401,
    );
    expect((await request(operation)).status).toBe(404);
    const input = {
      operationId: "routing-operation",
      engine: "codex",
      title: "Route test",
      workspace: "default",
    };
    const created = await request("/v1/sessions", "POST", input);
    expect(created.status).toBe(201);
    const session = await created.json();
    const found = await request(operation);
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({
      operation: { id: input.operationId, state: "ready" },
      session: { id: session.id },
    });
    expect((await request(operation, "DELETE", undefined, false)).status).toBe(
      401,
    );
    expect((await request(operation, "DELETE")).status).toBe(204);
    expect(await (await request(operation)).json()).toEqual({
      operation: { id: input.operationId, state: "deleted" },
    });
    expect((await request("/v1/sessions", "POST", input)).status).toBe(409);
    const early = "/v1/session-operations/routing-before-create";
    expect((await request(early, "DELETE")).status).toBe(204);
    expect(
      (
        await request("/v1/sessions", "POST", {
          ...input,
          operationId: "routing-before-create",
        })
      ).status,
    ).toBe(409);
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
  }
});
