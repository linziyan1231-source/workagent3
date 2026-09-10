import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { login } from "./smoke-dsh-helpers.mjs";
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const output = `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/${engine}`;
await mkdir(output, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() =>
  localStorage.setItem("workagent.files.open", "false"),
);
const report = {
  checks: [],
  errors: [],
  preview: !!process.env.WORKAGENT_SMOKE_CLIENT,
};
page.on("pageerror", (e) => report.errors.push(e.message));
for (const [env, name, type] of [
  ["WORKAGENT_SMOKE_CLIENT", "client.js", "text/javascript"],
  ["WORKAGENT_SMOKE_CSS", "tokens.css", "text/css"],
])
  if (process.env[env]) {
    const body = await readFile(process.env[env], "utf8");
    await page.route(`**/plugins/@workagent/dsh-client/${name}*`, (r) =>
      r.fulfill({ contentType: type, body }),
    );
  }
const root = page.locator(".hHd-Xa_root");
const toggle = page.locator(".hHd-Xa_toggle");
async function expanded() {
  if ((await root.getAttribute("class")).includes("hHd-Xa_collapsed"))
    await toggle.click();
  await page.locator(".hHd-Xa_root:not(.hHd-Xa_collapsed)").waitFor();
  await page.waitForTimeout(400);
}
async function closed() {
  await page.locator(".hHd-Xa_root.hHd-Xa_collapsed").waitFor();
  await page.waitForTimeout(400);
}
try {
  await login(page);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(400);
    await expanded();
    await page
      .locator(".workagent-sidebar-session .is-main")
      .filter({ hasText: /^hi$/ })
      .first()
      .click();
    await closed();
    const session = new URL(page.url()).searchParams.get("session");
    assert(session);
    report.checks.push(`${width}: selecting a conversation closes sidebar`);
    await expanded();
    await page
      .locator('.workagent-sidebar-session .is-main[aria-current="page"]')
      .click();
    await closed();
    assert.equal(new URL(page.url()).searchParams.get("session"), session);
    report.checks.push(
      `${width}: selecting current conversation also closes sidebar`,
    );
    for (let i = 0; i < 2; i++) {
      await expanded();
      await page.locator(".hHd-Xa_newSession").click();
      await closed();
      assert.equal(new URL(page.url()).searchParams.get("session"), null);
    }
    report.checks.push(
      `${width}: new conversation closes from conversation and home`,
    );
    await page.screenshot({ path: `${output}/closed-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expanded();
  for (let i = 0; i < 2; i++) {
    await toggle.hover();
    await toggle.focus();
    await page.waitForTimeout(650);
    assert.equal(
      await page.locator('.hHd-Xa_toggle + [role="tooltip"]:visible').count(),
      0,
    );
    assert(await toggle.getAttribute("aria-label"));
    await toggle.click();
    await page.waitForTimeout(400);
  }
  report.checks.push("open/collapse hints hidden; accessible labels retained");
  await expanded();
  await page.locator(".hHd-Xa_newSession").click();
  assert(!(await root.getAttribute("class")).includes("hHd-Xa_collapsed"));
  await page
    .locator(".workagent-sidebar-session .is-main")
    .filter({ hasText: /^hi$/ })
    .first()
    .click();
  assert(!(await root.getAttribute("class")).includes("hHd-Xa_collapsed"));
  report.checks.push(
    "desktop sidebar remains open for new and existing conversations",
  );
  assert.deepEqual(report.errors, []);
  console.log(
    JSON.stringify({
      checks: report.checks.length,
      errors: report.errors,
      preview: report.preview,
    }),
  );
} catch (e) {
  report.failure = e.message;
  await page.screenshot({ path: `${output}/failure.png` });
  throw e;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
