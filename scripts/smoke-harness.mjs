import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const home = fileURLToPath(new URL("../.cache/dsh-home", import.meta.url));
const dsh = fileURLToPath(
  new URL("../node_modules/@deepseek-ai/dsh/lib/bin.js", import.meta.url),
);
const token = "workagent-profile-smoke-token";
const nativeHome = join(home, "native-smoke");
const workspaceRoot = fileURLToPath(
  new URL("../.cache/workspaces", import.meta.url),
);
await mkdir(join(nativeHome, "codex"), { recursive: true });
await mkdir(join(nativeHome, "kimi"), { recursive: true });
await mkdir(workspaceRoot, { recursive: true });

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
    CODEX_HOME: process.env.CODEX_HOME ?? join(nativeHome, "codex"),
    DSH_HOME: home,
    KIMI_CODE_HOME: process.env.KIMI_CODE_HOME ?? join(nativeHome, "kimi"),
    WORKAGENT_RUNTIME_PORT: String(port),
    WORKAGENT_RUNTIME_TOKEN: token,
    WORKAGENT_WORKSPACE_ROOT: workspaceRoot,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let diagnostics = "";
for (const output of [child.stdout, child.stderr]) {
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-8_000);
  });
}

try {
  const deadline = Date.now() + 30_000;
  let succeeded = false;
  let lastFailure = "";
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
        if (process.env.WORKAGENT_SMOKE_RESUME_ONLY === "1") {
          const listed = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
            headers: { authorization: `Bearer ${token}` },
          });
          const sessions = await listed.json();
          const harness = sessions.find(
            (item) =>
              item.engine === "harness" && item.workspaceId !== "default",
          );
          if (!harness) throw new Error("no persisted Harness session found");
          const resumed = await fetch(
            `http://127.0.0.1:${port}/v1/sessions/${encodeURIComponent(harness.id)}/resume`,
            {
              method: "POST",
              headers: { authorization: `Bearer ${token}` },
            },
          );
          if (!resumed.ok)
            throw new Error(
              `Harness resume failed with ${resumed.status}: ${await resumed.text()}`,
            );
          const assets = await fetch(
            `http://127.0.0.1:${port}/v1/workspaces/${encodeURIComponent(harness.workspaceId)}/assets?sessionId=${encodeURIComponent(harness.id)}`,
            { headers: { authorization: `Bearer ${token}` } },
          );
          const recoveredAssets = await assets.json();
          if (
            !assets.ok ||
            !recoveredAssets.some((item) => item.kind === "attachment") ||
            !recoveredAssets.some((item) => item.kind === "artifact")
          )
            throw new Error("persisted session assets were not recovered");
          for (const asset of recoveredAssets) {
            const content = await fetch(
              `http://127.0.0.1:${port}/v1/workspaces/${encodeURIComponent(harness.workspaceId)}/content?path=${encodeURIComponent(asset.path)}`,
              { headers: { authorization: `Bearer ${token}` } },
            );
            if (!content.ok)
              throw new Error(`persisted asset ${asset.id} was unreadable`);
          }
          process.stdout.write(
            `workagent resumed persisted Harness session ${harness.id}\n`,
          );
          succeeded = true;
          break;
        }
        const engineResponse = await fetch(
          `http://127.0.0.1:${port}/v1/engines`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        const engineStatuses = await engineResponse.json();
        if (
          !engineResponse.ok ||
          engineStatuses.length !== 3 ||
          !engineStatuses.every(
            (item) =>
              typeof item.available === "boolean" &&
              typeof item.capabilities?.resume === "boolean",
          )
        )
          throw new Error("engine registry returned an invalid status matrix");
        const capabilityResponse = await fetch(
          `http://127.0.0.1:${port}/v1/capabilities`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        const capabilities = await capabilityResponse.json();
        if (
          !capabilityResponse.ok ||
          !Array.isArray(capabilities.modules) ||
          !capabilities.modules.some(
            (module) =>
              module.id === "workspace-runtime" &&
              typeof module.dataOwner === "string" &&
              typeof module.healthCheck === "string",
          )
        )
          throw new Error("runtime module manifests were not published");
        const createdWorkspace = await fetch(
          `http://127.0.0.1:${port}/v1/workspaces`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ name: `Smoke ${Date.now()}` }),
          },
        );
        if (createdWorkspace.status !== 201)
          throw new Error(
            `workspace creation failed: ${await createdWorkspace.text()}`,
          );
        const workspace = await createdWorkspace.json();
        const contentURL = `http://127.0.0.1:${port}/v1/workspaces/${encodeURIComponent(workspace.id)}/content?path=smoke.txt`;
        const written = await fetch(contentURL, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}` },
          body: "workspace smoke",
        });
        if (!written.ok)
          throw new Error(`workspace write failed: ${await written.text()}`);
        const downloaded = await fetch(contentURL, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!downloaded.ok || (await downloaded.text()) !== "workspace smoke")
          throw new Error("workspace download did not round-trip");
        const deleted = await fetch(contentURL, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        });
        if (deleted.status !== 204)
          throw new Error(`workspace delete failed with ${deleted.status}`);
        const engines = [
          "harness",
          ...(process.env.WORKAGENT_NATIVE_SMOKE_ENGINES ?? "")
            .split(",")
            .filter(Boolean),
        ];
        for (const engine of engines) {
          const created = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              engine,
              title: `${engine} profile smoke test`,
              workspace: workspace.id,
            }),
          });
          if (created.status !== 201) {
            throw new Error(
              `${engine} session creation failed with ${created.status}: ${await created.text()}`,
            );
          }
          const session = await created.json();
          const messages = await fetch(
            `http://127.0.0.1:${port}/v1/sessions/${encodeURIComponent(session.id)}/messages`,
            { headers: { authorization: `Bearer ${token}` } },
          );
          if (!messages.ok || (await messages.json()).length !== 0)
            throw new Error(`${engine} session message log was not empty`);
          if (engine === "harness") {
            const attachment = await fetch(
              `http://127.0.0.1:${port}/v1/workspaces/${encodeURIComponent(workspace.id)}/attachments?sessionId=${encodeURIComponent(session.id)}&name=brief.txt`,
              {
                method: "PUT",
                headers: {
                  authorization: `Bearer ${token}`,
                  "content-type": "text/plain",
                },
                body: "private attachment",
              },
            );
            if (attachment.status !== 201)
              throw new Error(
                `attachment upload failed: ${await attachment.text()}`,
              );
            const artifactPath = "artifacts/result.txt";
            const artifactContent = await fetch(
              `http://127.0.0.1:${port}/v1/workspaces/${encodeURIComponent(workspace.id)}/content?path=${encodeURIComponent(artifactPath)}`,
              {
                method: "PUT",
                headers: { authorization: `Bearer ${token}` },
                body: "generated artifact",
              },
            );
            if (!artifactContent.ok)
              throw new Error(
                `artifact content write failed: ${await artifactContent.text()}`,
              );
            const artifact = await fetch(
              `http://127.0.0.1:${port}/v1/workspaces/${encodeURIComponent(workspace.id)}/assets?sessionId=${encodeURIComponent(session.id)}`,
              {
                method: "POST",
                headers: {
                  authorization: `Bearer ${token}`,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  path: artifactPath,
                  name: "result.txt",
                  mediaType: "text/plain",
                }),
              },
            );
            if (artifact.status !== 201)
              throw new Error(
                `artifact registration failed: ${await artifact.text()}`,
              );
            const assets = await fetch(
              `http://127.0.0.1:${port}/v1/workspaces/${encodeURIComponent(workspace.id)}/assets?sessionId=${encodeURIComponent(session.id)}`,
              { headers: { authorization: `Bearer ${token}` } },
            );
            const listedAssets = await assets.json();
            if (
              !assets.ok ||
              listedAssets.length !== 2 ||
              !listedAssets.some((item) => item.kind === "attachment") ||
              !listedAssets.some((item) => item.kind === "artifact")
            )
              throw new Error("session assets were not recoverable");
            const recoveredArtifact = await fetch(
              `http://127.0.0.1:${port}/v1/workspaces/${encodeURIComponent(workspace.id)}/content?path=${encodeURIComponent(artifactPath)}`,
              { headers: { authorization: `Bearer ${token}` } },
            );
            if (
              !recoveredArtifact.ok ||
              (await recoveredArtifact.text()) !== "generated artifact"
            )
              throw new Error("registered artifact was not recoverable");
          }
        }
        process.stdout.write(
          `workagent Harness profile healthy on loopback port ${port}\n`,
        );
        succeeded = true;
        break;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
      // Startup is asynchronous; retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!succeeded)
    throw new Error(
      `Harness health timeout: ${lastFailure}\n${diagnostics}`.trim(),
    );
} finally {
  child.kill();
}
