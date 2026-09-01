import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const smokeScript = fileURLToPath(
  new URL("./smoke-harness.mjs", import.meta.url),
);
const profileScript = fileURLToPath(
  new URL("./dump-harness-profile.ps1", import.meta.url),
);
const smokeRoot = await mkdtemp(join(tmpdir(), "workagent3-harness-recovery-"));
const dshHome = join(smokeRoot, "sid-data", "dsh");
const workspaceRoot = join(smokeRoot, "sid-data", "workspaces");

function run(command, args, label, extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: {
        ...process.env,
        ...extraEnvironment,
      },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} exited with ${code ?? signal}`));
    });
  });
}

function runHarness(resumeOnly) {
  return run(
    process.execPath,
    [smokeScript],
    `Harness ${resumeOnly ? "recovery" : "seed"} smoke`,
    {
      WORKAGENT_SMOKE_DSH_HOME: dshHome,
      WORKAGENT_SMOKE_WORKSPACE_ROOT: workspaceRoot,
      ...(resumeOnly ? { WORKAGENT_SMOKE_RESUME_ONLY: "1" } : {}),
    },
  );
}

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
    "isolated Harness Profile installation",
  );
  await runHarness(false);
  await runHarness(true);
  process.stdout.write(
    "Harness recovery smoke passed: abrupt process stop, restart, Session resume, attachment recovery, and Artifact recovery.\n",
  );
} finally {
  const expectedPrefix = join(tmpdir(), "workagent3-harness-recovery-");
  if (!smokeRoot.startsWith(expectedPrefix)) {
    throw new Error(
      `Refusing to remove unexpected recovery root: ${smokeRoot}`,
    );
  }
  await rm(smokeRoot, { recursive: true, force: true });
}
