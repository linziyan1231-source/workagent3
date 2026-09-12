import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { baseURL, smokeUsername } from "./smoke-dsh-helpers.mjs";

const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const out = `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/${engine}`;
await mkdir(out, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const report = {
  engine,
  checks: [],
  errors: [],
  httpErrors: [],
  navigationCancellations: [],
};
let navigating = false;
page.on("pageerror", (error) => {
  if (
    engine === "webkit" &&
    navigating &&
    error.message.endsWith(
      "/api/runtime/v1/sessions due to access control checks.",
    )
  ) {
    report.navigationCancellations.push(error.message);
  } else report.errors.push(error.message);
});
page.on("response", (response) => {
  if (response.status() >= 400)
    report.httpErrors.push({
      status: response.status(),
      path: new URL(response.url()).pathname,
    });
});
try {
  await navigate(`${baseURL}/?frontend=legacy`);
  const entry = await settings("login");
  const auth = await page.request.post(`${baseURL}/api/auth/login`, {
    data: {
      username: smokeUsername,
      password: process.env.WORKAGENT_SMOKE_PASSWORD,
    },
    headers: { Origin: new URL(baseURL).origin },
  });
  assert(auth.ok(), `Login returned ${auth.status()}`);
  await openEmployee();
  assert.deepEqual(await settings("employee"), entry);
  // Both administrator and login use this Portal document. Navigation remains
  // in the same browser context, as when switching accounts in one Home icon.
  await navigate(`${baseURL}/?frontend=legacy`);
  assert.deepEqual(await settings("portal"), entry);
  await openEmployee();
  assert.deepEqual(await settings("employee-return"), entry);
  assert((await page.request.get(`${baseURL}/api/runtime/v1/sessions`)).ok());
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report));
} catch (error) {
  report.failure = error.message;
  report.page = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: document.body.innerText.slice(0, 400),
  }));
  await page.screenshot({ path: `${out}/entry-failure.png` });
  throw error;
} finally {
  await writeFile(`${out}/entry-report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}

async function openEmployee() {
  // Wait for the initial session load before navigating away. Live event
  // streams keep the page busy, so a global network-idle wait is unsuitable.
  const sessions = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/runtime/v1/sessions" &&
      response.ok(),
  );
  await navigate(`${baseURL}/?frontend=dsh`);
  await (await sessions).finished();
  // Mobile starts with the sidebar collapsed, so its wordmark is not visible.
  await page.locator(".hHd-Xa_root").waitFor();
}

async function navigate(url) {
  navigating = true;
  try {
    await page.goto(url);
  } finally {
    navigating = false;
  }
}

async function settings(surface) {
  const viewport = await page
    .locator('meta[name="viewport"]')
    .getAttribute("content");
  assert.match(viewport, /viewport-fit=cover/);
  assert.equal(
    await page
      .locator('meta[name="apple-mobile-web-app-status-bar-style"]')
      .count(),
    0,
  );
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  const response = await page.request.get(new URL(href, page.url()).href);
  assert(response.ok());
  const manifest = await response.json();
  assert.equal(manifest.display, "standalone");
  const config = { viewport };
  for (const key of [
    "id",
    "name",
    "short_name",
    "start_url",
    "scope",
    "display",
  ])
    config[key] = manifest[key];
  report.checks.push({ surface, ...config });
  return config;
}
