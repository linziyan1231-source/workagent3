import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { baseURL, login } from "./smoke-dsh-helpers.mjs";

// Read-only acceptance of the existing personal and AI-team entry points.
const out = process.env.WORKAGENT_COLLAB_EVIDENCE_DIR || ".cache/collaboration/regression";
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const report = { checks: [], errors: [] };
page.on("pageerror", error => report.errors.push(error.message));
try {
  await login(page);
  for (const path of ["/api/runtime/v1/workspaces", "/api/runtime/v1/sessions", "/api/runtime/v1/presets"]) {
    assert((await page.request.get(baseURL + path)).ok(), path);
    report.checks.push(path);
  }
  await page.goto(baseURL + "/?frontend=dsh");
  await page.getByRole("button", { name: "协作", exact: true }).waitFor();
  await page.getByRole("button", { name: "频道", exact: true }).click();
  await page.screenshot({ path: out + "/channels.png" });
  report.checks.push("channel tab remains accessible");
  for (const route of ["workspaces", "assistants", "teams"]) {
    await page.goto(baseURL + "/?frontend=dsh&workagent=" + route);
    await page.locator(".workagent-overlay").waitFor();
    await page.screenshot({ path: out + "/" + route + ".png" });
    report.checks.push(route + " entry accessible");
  }
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.failure = error.message;
  throw error;
} finally {
  await writeFile(out + "/report.json", JSON.stringify(report, null, 2));
  await browser.close();
}
