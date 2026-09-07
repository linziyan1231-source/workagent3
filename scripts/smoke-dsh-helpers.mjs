import { chromium, request } from "playwright";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const baseURL = process.env.WORKAGENT_SMOKE_URL?.replace(/\/$/, "");
export const smokeUsername = process.env.WORKAGENT_SMOKE_USERNAME;
const password = process.env.WORKAGENT_SMOKE_PASSWORD;

export function requireSmokeEnvironment() {
  if (!baseURL || !smokeUsername || !password)
    throw new Error(
      "WORKAGENT_SMOKE_URL, WORKAGENT_SMOKE_USERNAME and WORKAGENT_SMOKE_PASSWORD are required",
    );
}

export async function withPage(run, launchOptions = {}) {
  requireSmokeEnvironment();
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await login(page);
    await run(page);
  } finally {
    await browser.close();
  }
}

export async function login(page) {
  const response = await page.request.post(`${baseURL}/api/auth/login`, {
    data: { username: smokeUsername, password },
    headers: { Origin: new URL(baseURL).origin },
  });
  if (!response.ok()) throw new Error(`login returned ${response.status()}`);
  await page.goto(`${baseURL}/?frontend=dsh`);
  await page.getByText("WorkAgent", { exact: true }).waitFor();
}

export async function json(page, path, init = {}) {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, {
        credentials: "same-origin",
        ...init,
        headers:
          init.body === undefined
            ? init.headers
            : { "Content-Type": "application/json", ...init.headers },
      });
      if (!response.ok)
        throw new Error(
          `${path} returned ${response.status}: ${await response.text()}`,
        );
      return response.status === 204 ? undefined : response.json();
    },
    { path, init },
  );
}

export async function openSettingsSection(page, name) {
  await page.getByRole("button", { name: /settings|设置/i }).click();
  await page
    .getByRole("dialog", { name: /settings|设置/i })
    .getByRole("button", { name, exact: true })
    .click();
  return name === "消息渠道"
    ? page.locator(".ima-account-page")
    : page.locator(`[data-workagent-section="${name}"]`);
}

export const uniqueName = (prefix) => `${prefix}-${Date.now()}`;

export async function killSmokeProcess(pid) {
  const target = process.env.WORKAGENT_SMOKE_SSH_TARGET;
  if (!target) {
    process.kill(pid);
    return;
  }
  let failure = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = spawnSync(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        target,
        "powershell",
        "-NoProfile",
        "-Command",
        `Stop-Process -Id ${pid} -Force`,
      ],
      { encoding: "utf8" },
    );
    if (result.status === 0) return;
    failure = (
      result.stderr ||
      result.stdout ||
      `exit ${result.status}`
    ).trim();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`failed to stop remote process ${pid}: ${failure}`);
}

export async function restartSmokeRuntime(page) {
  await adminJson(page, "/api/portal/admin/users/set-limits", {
    method: "POST",
    body: JSON.stringify({
      username: smokeUsername,
      limits: {
        cpu_percent: 80,
        memory_bytes: 4294967296,
        active_processes: 64,
      },
    }),
  });
}

export async function adminJson(page, path, init = {}) {
  const username = process.env.WORKAGENT_SMOKE_ADMIN_USERNAME;
  const password = process.env.WORKAGENT_SMOKE_ADMIN_PASSWORD;
  if (!username && !password) return json(page, path, init);
  if (!username || !password)
    throw new Error("Both WORKAGENT_SMOKE_ADMIN credentials are required");
  const context = await request.newContext({ baseURL });
  try {
    const login = await context.post("/api/auth/login", {
      data: { username, password },
      headers: { Origin: new URL(baseURL).origin },
    });
    if (!login.ok()) throw new Error(`admin login returned ${login.status()}`);
    const response = await context.fetch(path, {
      method: init.method || "GET",
      data: init.body === undefined ? undefined : JSON.parse(init.body),
      headers: { Origin: new URL(baseURL).origin },
    });
    if (!response.ok())
      throw new Error(`admin ${path} returned ${response.status()}`);
    return response.status() === 204 ? undefined : response.json();
  } finally {
    await context.dispose();
  }
}

export async function openDshAfterRestart(page, path) {
  const authentication = await page.request.post(`${baseURL}/api/auth/login`, {
    data: { username: smokeUsername, password },
    headers: { Origin: new URL(baseURL).origin },
  });
  if (!authentication.ok())
    throw new Error(
      `runtime reauthentication returned ${authentication.status()}`,
    );
  const deadline = Date.now() + 120_000;
  let lastStatus;
  let lastBody = "";
  do {
    const response = await page.goto(`${baseURL}${path}`);
    lastStatus = response?.status();
    if (response?.ok()) {
      const mounted = await page
        .getByText("WorkAgent", { exact: true })
        .waitFor({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (mounted) return;
    }
    lastBody = (
      await page
        .locator("body")
        .innerText()
        .catch(() => "")
    ).slice(0, 200);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);
  throw new Error(
    `DSH shell did not recover after runtime restart: ${lastStatus} ${lastBody}`,
  );
}

export async function resolveRemoteSmokeProcess(pid, executable, sid) {
  const target = process.env.WORKAGENT_SMOKE_SSH_TARGET;
  if (!target) return pid;
  if (
    !/^[A-Za-z0-9.-]+\.exe$/.test(executable) ||
    !/^S-\d+(?:-\d+)+$/.test(sid)
  )
    throw new Error("invalid remote process selector");
  const command = [
    `$matches = @(Get-CimInstance Win32_Process | Where-Object {`,
    `  $_.Name -eq '${executable}' -and $_.CommandLine -like '*${sid}*'`,
    `})`,
    `if ($matches.Count -ne 1) { exit 2 }`,
    `$matches[0].ProcessId`,
  ].join("\n");
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  let failure = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = spawnSync(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        target,
        "powershell",
        "-NoProfile",
        "-EncodedCommand",
        encoded,
      ],
      { encoding: "utf8" },
    );
    const resolved = Number(result.stdout.trim());
    if (result.status === 0 && Number.isSafeInteger(resolved) && resolved > 0)
      return resolved;
    failure = (
      result.stderr ||
      result.stdout ||
      `exit ${result.status}`
    ).trim();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`failed to resolve remote ${executable}: ${failure}`);
}

const smokeIdentityPath = join(tmpdir(), "workagent-dsh-smoke-sid.txt");

export async function smokeProcessSID(pid) {
  const target = process.env.WORKAGENT_SMOKE_SSH_TARGET;
  const command = [
    `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    `if ($null -eq $process) { exit 2 }`,
    `$process.CommandLine`,
  ].join("\n");
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  let failure = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const executable = target ? "ssh" : "powershell";
    const args = target
      ? [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=5",
          target,
          "powershell",
          "-NoProfile",
          "-EncodedCommand",
          encoded,
        ]
      : ["-NoProfile", "-EncodedCommand", encoded];
    const result = spawnSync(executable, args, { encoding: "utf8" });
    const sid = result.stdout.match(/S-\d+(?:-\d+)+/)?.[0];
    if (result.status === 0 && sid) return sid;
    failure = (
      result.stderr ||
      result.stdout ||
      `exit ${result.status}`
    ).trim();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`failed to identify smoke process ${pid}: ${failure}`);
}

export async function rememberSmokeProcessSID(pid) {
  const sid = await smokeProcessSID(pid);
  writeFileSync(smokeIdentityPath, sid, { encoding: "utf8", mode: 0o600 });
  return sid;
}

export function rememberedSmokeProcessSID() {
  const sid = readFileSync(smokeIdentityPath, "utf8").trim();
  if (!/^S-\d+(?:-\d+)+$/.test(sid))
    throw new Error("remembered smoke SID is invalid");
  return sid;
}
