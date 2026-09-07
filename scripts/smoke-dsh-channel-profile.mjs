import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  unlink,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";
const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close(() => resolvePort(port));
  });
});
const source = resolve(
  process.env.WORKAGENT_SMOKE_PROFILE || ".cache/dsh-home/profiles/workagent",
);
const home = await mkdtemp(join(tmpdir(), "wa3-channel-profile-"));
const profile = join(home, "profiles/workagent");
await mkdir(profile, { recursive: true });
await writeFile(
  join(profile, "package.json"),
  await readFile(join(source, "package.json")),
);
await symlink(
  join(source, "node_modules"),
  join(profile, "node_modules"),
  "junction",
);
const probeFile = join(home, "probe.mjs");
await writeFile(
  probeFile,
  `export const inject=['webServer','credentials']; export function apply(ctx,config){ctx.effect(()=>ctx.webServer.register({kind:'exact',path:config.path,handler:async(req,res)=>{if(req.method==='POST'){await ctx.credentials.set(config.ref,'nonsecret-smoke-value');}if(req.method==='DELETE'){await ctx.credentials.unset(config.ref);}res.setHeader('content-type','application/json');res.end(JSON.stringify({configured:(await ctx.credentials.describe(config.ref)).configured,otherConfigured:(await ctx.credentials.describe(config.other)).configured}));}}),'probe');}`,
);
const yaml = `- id: workagent-channels\n  config:\n    - id: channel-credentials\n      name: '@deepseek-ai/dsh-credentials-local'\n    - id: im-connect\n      name: '@michengai/dsh-im-connect'\n    - id: child-probe\n      name: ${JSON.stringify(pathToFileURL(probeFile).href)}\n      config:\n        path: /child-probe\n        ref: im_connect_smoke\n        other: DEEPSEEK_API_KEY\n- insert:\n    - id: parent-probe\n      name: ${JSON.stringify(pathToFileURL(probeFile).href)}\n      config:\n        path: /parent-probe\n        ref: DEEPSEEK_API_KEY\n        other: im_connect_smoke\n`;
await writeFile(join(profile, "cordis.patch.yml"), yaml);
let child;
let log = "";
const origin = `http://127.0.0.1:${port}`;
async function start() {
  child = spawn(
    process.execPath,
    [
      join(profile, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
      "--profile",
      "workagent",
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DSH_HOME: home,
        WORKAGENT_RUNTIME_PORT: String(port),
        WORKAGENT_RUNTIME_TOKEN: "channel-profile-smoke-token-long-enough",
        WORKAGENT_HARNESS_MODEL: "gpt-5.6-sol",
        DEEPSEEK_BASE_URL: "http://127.0.0.1:8317/v1",
        WORKAGENT_WORKSPACE_ROOT: join(home, "workspaces"),
      },
    },
  );
  child.stdout.on("data", (x) => (log += x));
  child.stderr.on("data", (x) => (log += x));
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(origin + "/child-probe");
      if (r.ok) return;
    } catch {}
    if (child.exitCode !== null) throw Error(log);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error(log || "startup timed out");
}
async function stop() {
  const done = once(child, "exit");
  child.kill();
  await done;
}
async function probe(path, method = "GET") {
  return (await fetch(origin + path, { method })).json();
}
try {
  await start();
  const catalog = await probe("/dsh-im-connect/api/channels");
  assert.equal(
    catalog.ok,
    true,
    "channel plugin must activate with the native runtime service",
  );
  assert.equal(catalog.channels.length >= 4, true);
  const notificationURL = origin + "/v1/completion-notifications";
  assert.equal((await fetch(notificationURL)).status, 401);
  const notificationSettings = await (
    await fetch(notificationURL, {
      headers: {
        authorization: "Bearer channel-profile-smoke-token-long-enough",
      },
    })
  ).json();
  assert.equal(notificationSettings.enabled, false);
  assert.deepEqual(notificationSettings.targets, []);
  assert.deepEqual(await probe("/parent-probe", "POST"), {
    configured: true,
    otherConfigured: false,
  });
  assert.deepEqual(await probe("/child-probe", "POST"), {
    configured: true,
    otherConfigured: false,
  });
  const text = await readFile(join(home, ".credentials.yaml"), "utf8");
  assert(text.includes("im_connect_smoke"));
  assert(!text.includes("DEEPSEEK_API_KEY"));
  await stop();
  await start();
  assert.deepEqual(await probe("/child-probe"), {
    configured: true,
    otherConfigured: false,
  });
  assert.deepEqual(await probe("/parent-probe"), {
    configured: false,
    otherConfigured: false,
  });
  await probe("/child-probe", "DELETE");
  await stop();
  await start();
  assert.equal((await probe("/child-probe")).configured, false);
  console.log(
    "PASS native credential persistence, deletion, realm isolation, managed key remains memory-only",
  );
} catch (error) {
  console.error(log);
  throw error;
} finally {
  if (child?.exitCode === null) await stop();
  assert(home.startsWith(join(tmpdir(), "wa3-channel-profile-")));
  await unlink(join(profile, "node_modules"));
  await rm(home, { recursive: true, force: true });
}
