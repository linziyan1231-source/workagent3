import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.WORKAGENT_SMOKE_URL?.replace(/\/$/, "");
const password = process.env.WORKAGENT_SMOKE_ADMIN_PASSWORD;
const employee = process.env.WORKAGENT_SMOKE_USERNAME;
const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
if (!base || !password || !employee?.startsWith("wa3cred-"))
  throw Error(
    "Dedicated disposable employee and authenticated smoke settings required",
  );
if (evidence) await mkdir(evidence, { recursive: true });
const browser = await chromium.launch();
const report = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const login = await page.request.post(base + "/api/auth/login", {
    data: { username: "admin", password },
    headers: { Origin: base },
  });
  assert(login.ok());
  const open = async () => {
    await page.goto(base + "/admin/accounts");
    await page
      .getByRole("row")
      .filter({ has: page.getByText(employee, { exact: true }) })
      .getByRole("button", { name: "管理", exact: false })
      .click();
    return page.getByRole("dialog", { name: employee, exact: true });
  };
  const actions = [
    ["restart", "重启服务"],
    ["repair", "修复服务"],
  ];
  const selected =
    process.env.WORKAGENT_SMOKE_RESTART_ONLY === "1"
      ? actions.slice(0, 1)
      : process.env.WORKAGENT_SMOKE_REPAIR_ONLY === "1"
        ? actions.slice(1)
        : actions;
  for (const [action, label] of selected) {
    let dialog = await open();
    await dialog.getByRole("tab", { name: "账户与服务" }).click();
    await dialog.getByRole("button", { name: label, exact: false }).click();
    assert.equal(await dialog.locator('input[type="password"]').count(), 0);
    const responsePromise = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/portal/admin/users/" + action) &&
        r.request().method() === "POST",
    );
    const started = Date.now();
    await dialog
      .locator("form")
      .getByRole("button", { name: label, exact: true })
      .click();
    const response = await responsePromise;
    assert(response.ok());
    const { job } = await response.json();
    assert(job?.id);
    assert(
      Date.now() - started < 10000,
      "maintenance must return before work finishes",
    );
    await dialog.getByRole("status").waitFor();
    dialog = await open();
    await dialog.getByRole("status").waitFor();
    const deadline = Date.now() + 15 * 60 * 1000;
    let latest;
    let nextLoginProbe = 0;
    const loginFailures = [];
    do {
      const r = await page.request.get(
        base + "/api/portal/admin/user-jobs?id=" + encodeURIComponent(job.id),
      );
      assert(r.ok());
      latest = (await r.json()).job;
      if (Date.now() >= nextLoginProbe) {
        const probe = await page.request.post(base + "/api/auth/login", {
          data: { username: "admin", password },
          headers: { Origin: base },
        });
        if (!probe.ok()) {
          loginFailures.push(probe.status());
          console.error("Concurrent login failed", probe.status());
        }
        nextLoginProbe = Date.now() + 30000;
      }
      if (latest.status !== "running") break;
      await page.waitForTimeout(2000);
    } while (Date.now() < deadline);
    assert.equal(latest.status, "succeeded", latest.error_message);
    assert.deepEqual(
      loginFailures,
      [],
      "new logins must work during maintenance",
    );
    const loginCheck = await page.request.post(base + "/api/auth/login", {
      data: { username: "admin", password },
      headers: { Origin: base },
    });
    assert.equal(
      loginCheck.status(),
      200,
      "new login must work after maintenance",
    );
    await dialog.getByText("服务维护已完成", { exact: true }).waitFor();
    if (evidence)
      await page.screenshot({ path: join(evidence, `employee-${action}.png`) });
    report.push({
      action,
      status: latest.status,
      job: job.id,
      elapsedMs: Date.now() - started,
      reloadRestoredJob: true,
    });
    console.log(JSON.stringify(report.at(-1)));
  }
  await page.goto(base + "/?frontend=dsh");
  await page.getByText("WorkAgent", { exact: true }).waitFor();
  if (evidence)
    await writeFile(
      join(evidence, "employee-maintenance.json"),
      JSON.stringify(report, null, 2),
    );
} finally {
  await browser.close();
}
