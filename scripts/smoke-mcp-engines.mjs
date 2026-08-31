import { createRequire } from "node:module";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const smokeRoot = join(root, ".cache", "mcp-engine-smoke");
const workspace = join(smokeRoot, "workspace");
const serverPath = fileURLToPath(
  new URL("./mcp-smoke-server.mjs", import.meta.url),
);
await mkdir(workspace, { recursive: true });

const harnessRequire = createRequire(
  new URL("../harness-bundle/package.json", import.meta.url),
);
const [{ Context }, { apply: installMcp }] = await Promise.all([
  import(pathToFileURL(harnessRequire.resolve("@deepseek-ai/cordis")).href),
  import(
    pathToFileURL(harnessRequire.resolve("@deepseek-ai/dsh-mcp-client")).href
  ),
]);
const [{ projectHarnessMcpServers }, { CodexBridge }, { KimiBridge }] =
  await Promise.all([
    import("../harness-bundle/dist/engines/harness-mcp.js"),
    import("../harness-bundle/dist/engines/codex.js"),
    import("../harness-bundle/dist/engines/kimi.js"),
  ]);

const markerPath = (engine) => join(smokeRoot, `${engine}.marker`);

const resetMarker = async (engine) => {
  for (const path of [markerPath(engine), `${markerPath(engine)}.methods`]) {
    try {
      await unlink(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
};

const waitForMarker = async (engine, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(markerPath(engine), "utf8")) === "initialized")
        return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${engine} did not initialize the managed MCP server`);
};

const withTimeout = (promise, label, timeoutMs = 20_000) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

const resolvedServer = (engine) => {
  const now = new Date().toISOString();
  return {
    server: {
      id: "wa3_smoke",
      name: "WorkAgent MCP smoke",
      source: "managed",
      enabled: true,
      transport: {
        kind: "stdio",
        command: process.execPath,
        args: [serverPath, markerPath(engine)],
        environmentCredentialIds: {},
      },
      toolPolicy: "all",
      allowedTools: [],
      oauthState: "none",
      health: "healthy",
      createdAt: now,
      updatedAt: now,
    },
    environment: {},
    headers: {},
    state: "ready",
  };
};

await resetMarker("harness");
const harnessContext = new Context();
const harnessTools = new Map();
harnessContext.provide("tools", {
  register(definition) {
    harnessTools.set(definition.name, definition);
    return () => harnessTools.delete(definition.name);
  },
});
try {
  await withTimeout(
    installMcp(
      harnessContext,
      projectHarnessMcpServers([resolvedServer("harness")], workspace)[0],
    ),
    "Harness MCP startup",
  );
  await waitForMarker("harness");
  const ping = harnessTools.get("mcp__wa3_smoke__ping");
  if (!ping) throw new Error("Harness did not register the projected MCP tool");
  const result = await ping.execute(
    {},
    { signal: new AbortController().signal },
  );
  if (result.content?.[0]?.text !== "pong")
    throw new Error("Harness MCP tool invocation did not return pong");
  process.stdout.write("Harness: MCP initialized, registered and invoked\n");
} finally {
  await harnessContext.fiber.dispose();
}

const codexHome =
  process.env.WORKAGENT_CODEX_SMOKE_HOME ?? process.env.CODEX_HOME;
const kimiHome =
  process.env.WORKAGENT_KIMI_SMOKE_HOME ?? process.env.KIMI_CODE_HOME;
if (!codexHome || !kimiHome)
  throw new Error(
    "WORKAGENT_CODEX_SMOKE_HOME and WORKAGENT_KIMI_SMOKE_HOME must point to authenticated SID-private native homes",
  );

const smokeNative = async (engine, Bridge, homeVariable, home) => {
  await resetMarker(engine);
  process.env[homeVariable] = home;
  const bridge = new Bridge();
  let session;
  try {
    const creation = bridge.create(workspace, () => undefined, {
      mcpServers: [resolvedServer(engine)],
    });
    const failedCreation = creation.then(
      (created) => {
        session = created;
        return new Promise(() => undefined);
      },
      (error) => Promise.reject(error),
    );
    await withTimeout(
      Promise.race([waitForMarker(engine, 60_000), failedCreation]),
      `${engine} MCP startup`,
      65_000,
    );
    process.stdout.write(`${engine}: MCP initialized by native Runtime\n`);
  } finally {
    await session?.close();
    await bridge.close();
  }
};

await smokeNative("codex", CodexBridge, "CODEX_HOME", codexHome);
await smokeNative("kimi", KimiBridge, "KIMI_CODE_HOME", kimiHome);
process.stdout.write("One managed MCP initialized through all three engines\n");
