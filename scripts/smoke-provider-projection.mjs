import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const profileScript = fileURLToPath(
  new URL("./dump-harness-profile.ps1", import.meta.url),
);
const dsh = fileURLToPath(
  new URL("../node_modules/@deepseek-ai/dsh/lib/bin.js", import.meta.url),
);
const smokeRoot = await mkdtemp(join(tmpdir(), "workagent3-provider-"));
const dshHome = join(smokeRoot, "dsh");
const workspaceRoot = join(smokeRoot, "workspace");
const token = "workagent-provider-smoke-token";
const secret = "provider-smoke-secret-never-persist";

const run = (command, args, label) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with ${code ?? signal}`));
    });
  });

const reservePort = () =>
  new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("failed to reserve a Provider smoke port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });

try {
  await run(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      profileScript,
      "-DestinationHome",
      dshHome,
    ],
    "isolated Provider Profile installation",
  );
  await mkdir(workspaceRoot, { recursive: true });
  const port = await reservePort();
  let providerRequests = 0;
  const providerServer = createHttpServer((request, response) => {
    if (
      request.method !== "POST" ||
      request.url !== "/chat/completions" ||
      request.headers.authorization !== `Bearer ${secret}`
    ) {
      response.writeHead(401).end();
      return;
    }
    providerRequests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      'data: {"id":"provider-smoke","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n',
    );
    response.write(
      'data: {"id":"provider-smoke","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    providerServer.once("error", reject);
    providerServer.listen(0, "127.0.0.1", resolve);
  });
  const providerAddress = providerServer.address();
  if (providerAddress === null || typeof providerAddress === "string")
    throw new Error("failed to start the Provider protocol fixture");
  const child = spawn(process.execPath, [dsh, "--profile", "workagent"], {
    cwd: root,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${providerAddress.port}`,
      WORKAGENT_HARNESS_MODEL: "gpt-5.6-sol",
      WORKAGENT_RUNTIME_PORT: String(port),
      WORKAGENT_RUNTIME_TOKEN: token,
      WORKAGENT_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let diagnostics = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-8_000);
    });
  }
  const endpoint = `http://127.0.0.1:${port}/internal/provider-credentials/deepseek-official`;
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      if (child.exitCode !== null)
        throw new Error(
          `Harness exited with ${child.exitCode}: ${diagnostics}`,
        );
      try {
        const health = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (health.ok) break;
      } catch {
        // The loopback listener is not ready yet.
      }
      if (Date.now() >= deadline)
        throw new Error(`Harness startup timed out: ${diagnostics}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const unauthorized = await fetch(endpoint, {
      method: "PUT",
      body: secret,
    });
    if (unauthorized.status !== 401)
      throw new Error("Provider projection accepted an unauthenticated write");

    const projected = await fetch(endpoint, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: secret,
    });
    if (projected.status !== 204)
      throw new Error(`Provider projection failed: ${await projected.text()}`);
    const status = await fetch(endpoint, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await status.text();
    const metadata = JSON.parse(body);
    if (
      !status.ok ||
      metadata.configured !== true ||
      metadata.source !== "workagent-broker-projection" ||
      body.includes(secret)
    )
      throw new Error(`Provider status was unsafe or invalid: ${body}`);

    try {
      await access(join(dshHome, ".credentials.yaml"));
      throw new Error("Provider secret was copied into .credentials.yaml");
    } catch (error) {
      if (error instanceof Error && !error.message.includes("ENOENT"))
        throw error;
    }

    const health = await fetch(
      `http://127.0.0.1:${port}/internal/providers/deepseek-official/test`,
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
    );
    const healthBody = await health.text();
    const healthMetadata = JSON.parse(healthBody);
    if (
      !health.ok ||
      healthMetadata.status !== "healthy" ||
      healthMetadata.message !== "provider_request_succeeded" ||
      providerRequests !== 1 ||
      healthBody.includes(secret)
    )
      throw new Error(`Provider request probe failed: ${healthBody}`);

    const revoked = await fetch(endpoint, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    const cleared = await fetch(endpoint, {
      headers: { authorization: `Bearer ${token}` },
    });
    const clearedMetadata = await cleared.json();
    if (revoked.status !== 204 || clearedMetadata.configured !== false)
      throw new Error(
        "Provider credential was not revoked from Harness memory",
      );
    process.stdout.write(
      "Managed Provider projection smoke passed: authenticated in-memory projection, official adapter request, redacted status, no DSH credential file, and revoke.\n",
    );
  } finally {
    child.kill();
    await new Promise((resolve) => providerServer.close(resolve));
  }
} finally {
  const expectedPrefix = join(tmpdir(), "workagent3-provider-");
  if (!smokeRoot.startsWith(expectedPrefix))
    throw new Error(
      `Refusing to remove unexpected Provider root: ${smokeRoot}`,
    );
  await rm(smokeRoot, { recursive: true, force: true });
}
