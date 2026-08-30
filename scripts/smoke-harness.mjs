import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const home = fileURLToPath(new URL("../.cache/dsh-home", import.meta.url));
const dsh = fileURLToPath(
  new URL("../node_modules/@deepseek-ai/dsh/lib/bin.js", import.meta.url),
);
const token = "workagent-profile-smoke-token";

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      reject(new Error("failed to reserve a smoke-test port"));
      return;
    }
    server.close(() => resolve(address.port));
  });
});

const child = spawn(process.execPath, [dsh, "--profile", "workagent"], {
  cwd: root,
  env: {
    ...process.env,
    DSH_HOME: home,
    WORKAGENT_RUNTIME_PORT: String(port),
    WORKAGENT_RUNTIME_TOKEN: token,
  },
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
});

let diagnostics = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  diagnostics = (diagnostics + chunk).slice(-8_000);
});

try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Harness exited with ${child.exitCode}: ${diagnostics}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) {
        const body = await response.json();
        if (body.status !== "healthy")
          throw new Error("unexpected health response");
        const created = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            engine: "harness",
            title: "Profile smoke test",
          }),
        });
        if (created.status !== 201) {
          throw new Error(`session creation failed with ${created.status}`);
        }
        process.stdout.write(
          `workagent Harness profile healthy on loopback port ${port}\n`,
        );
        break;
      }
    } catch {
      // Startup is asynchronous; retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (Date.now() >= deadline)
    throw new Error(`Harness health timeout: ${diagnostics}`);
} finally {
  child.kill();
}
