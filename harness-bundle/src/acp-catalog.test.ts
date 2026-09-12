import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { ManagedAcpCatalog } from "./acp-catalog.js";

it("starts an approved process with only declared Broker fields and a separate internal credential", async () => {
  const home = mkdtempSync(join(tmpdir(), "workagent-acp-private-"));
  const authorization: string[] = [];
  const entry = {
    id: "approved",
    label: "Approved",
    revision: "v1",
    packageRef: "public-package",
    command: basename(process.execPath),
    resolvedCommand: process.execPath,
    args: [
      fileURLToPath(
        new URL("./engines/fixtures/acp-agent.mjs", import.meta.url),
      ),
    ],
    credentialFields: [
      { id: "key", label: "Key", environment: "ACP_TEST_KEY", required: true },
    ],
    billingModelId: "fixed-budget",
    enabled: true,
  };
  const server = createServer((request, response) => {
    authorization.push(request.headers.authorization ?? "");
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== "Bearer private-acp-scope") {
      response.writeHead(401).end('{"error":"unauthorized"}');
      return;
    }
    response.end(
      JSON.stringify(
        request.url?.includes("/credentials")
          ? {
              environment: {
                ACP_TEST_KEY: "fixture-key",
                ACP_TEST_UNDECLARED: "must-not-inject",
              },
            }
          : entry,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  mkdirSync(join(home, "workagent"));
  writeFileSync(
    join(home, "workagent", "acp-gateway.json"),
    JSON.stringify({
      baseURL: `http://127.0.0.1:${address.port}`,
      token: "private-acp-scope",
    }),
  );
  vi.stubEnv("WORKAGENT_TEST_TOKEN", "must-not-forward");
  vi.stubEnv("ACP_TEST_UNDECLARED", "must-not-inherit");
  const catalog = new ManagedAcpCatalog(home);
  const events = vi.fn();
  try {
    const resolved = await catalog.resolve("approved");
    const bridge = await catalog.bridge(resolved);
    const session = await bridge.create(home, events, { mcpServers: [] });
    await session.send("inspect-test-environment");
    await vi.waitFor(() =>
      expect(events).toHaveBeenCalledWith(
        expect.objectContaining({ type: "assistant.completed" }),
      ),
    );
    const completed = events.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === "assistant.completed");
    expect(JSON.parse(completed.content)).toEqual({
      key: "fixture-key",
      home: join(home, "workagent", "acp", "approved"),
    });
    expect(authorization.length).toBeGreaterThanOrEqual(4);
    expect(
      authorization.every((value) => value === "Bearer private-acp-scope"),
    ).toBe(true);
  } finally {
    await catalog.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});
