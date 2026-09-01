import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const pluginRoot = process.env.WORKAGENT_DWG_PLUGIN_ROOT;
if (!pluginRoot || !isAbsolute(pluginRoot)) {
  throw new Error(
    "WORKAGENT_DWG_PLUGIN_ROOT must be an absolute released plugin path",
  );
}
const python = process.env.WORKAGENT_PYTHON_COMMAND || "python";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const launcher = join(
  repositoryRoot,
  "release",
  "managed-mcp",
  "dwg_launcher.py",
);
const workspace = mkdtempSync(join(tmpdir(), "workagent3-dwg-smoke-"));
const argumentsFor = (...extra) => [
  launcher,
  "--plugin-root",
  pluginRoot,
  "--workspace-root",
  workspace,
  ...extra,
];

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "WorkAgent3 DWG smoke", version: "0.1.0" },
  },
};

try {
  const healthResult = spawnSync(python, argumentsFor("--health"), {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (healthResult.status !== 0) {
    throw new Error(`DWG health probe failed: ${healthResult.stderr.trim()}`);
  }
  const health = JSON.parse(healthResult.stdout);
  if (
    realpathSync.native(health.project_root) !==
      realpathSync.native(workspace) ||
    health.libredwg?.available !== true ||
    health.tianzheng_converter?.state !== "available"
  ) {
    throw new Error(
      `DWG native dependencies are unavailable: ${healthResult.stdout}`,
    );
  }

  const server = spawn(python, argumentsFor(), {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  server.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  server.stdin.write(`${JSON.stringify(initialize)}\n`);

  await new Promise((resolveInitialization, rejectInitialization) => {
    const deadline = setTimeout(() => {
      rejectInitialization(
        new Error(`DWG MCP initialize timed out: ${stderr.trim()}`),
      );
    }, 30_000);
    const inspect = () => {
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const message = JSON.parse(line);
          if (message.jsonrpc === "2.0" && message.id === 1 && message.result) {
            clearTimeout(deadline);
            resolveInitialization();
            return;
          }
          if (message.jsonrpc === "2.0" && message.id === 1 && message.error) {
            clearTimeout(deadline);
            rejectInitialization(
              new Error(
                `DWG MCP rejected initialize: ${JSON.stringify(message.error)}`,
              ),
            );
            return;
          }
        } catch {
          // The final partial line is retried when more stdout arrives.
        }
      }
    };
    server.stdout.on("data", inspect);
    server.once("error", (error) => {
      clearTimeout(deadline);
      rejectInitialization(error);
    });
    server.once("exit", (code) => {
      clearTimeout(deadline);
      rejectInitialization(
        new Error(
          `DWG MCP exited before initialize (${code}): ${stderr.trim()}`,
        ),
      );
    });
  });
  server.kill();
  console.log(
    "DWG managed MCP smoke passed: SID workspace, native dependencies, and JSON-RPC initialize.",
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
