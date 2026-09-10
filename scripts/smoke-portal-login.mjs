import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit } from "playwright";
import {
  baseURL,
  smokeUsername,
  requireSmokeEnvironment,
} from "./smoke-dsh-helpers.mjs";
requireSmokeEnvironment();
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const output = join(
  process.env.WORKAGENT_SMOKE_EVIDENCE_DIR ??
    process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR ??
    ".cache/login-smoke",
  engine,
);
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "workagent-login-smoke-"));
const preview = process.env.WORKAGENT_LOGIN_PREVIEW;
const report = { checks: [], errors: [], preview: !!preview };
let context;
async function openBrowser() {
  context = await { chromium, webkit }[engine].launchPersistentContext(
    profile,
    {
      headless: true,
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    },
  );
  const page = context.pages()[0];
  page.on("pageerror", (e) => report.errors.push(e.message));
  return page;
}
try {
  let page = await openBrowser();
  if (preview) {
    await page.route(`${baseURL}/?frontend=dsh`, async (route) =>
      route.fulfill({
        contentType: "text/html",
        body: await readFile(join(preview, "index.html")),
      }),
    );
    await page.route("**/assets/*", async (route) =>
      route.fulfill({
        contentType: route.request().url().endsWith(".css")
          ? "text/css"
          : "text/javascript",
        body: await readFile(
          join(
            preview,
            "assets",
            new URL(route.request().url()).pathname.split("/").pop(),
          ),
        ),
      }),
    );
  }
  await page.addInitScript(() =>
    localStorage.setItem("workagent.login.language", "en-US"),
  );
  await page.goto(`${baseURL}/?frontend=dsh`);
  await page.getByRole("button", { name: "登录", exact: true }).waitFor();
  assert.equal(await page.locator("#lang-select").count(), 0);
  assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
  report.checks.push(
    "Login and password-change UI use Chinese regardless of previous language preference",
  );
  const password = page.locator("#password");
  const reveal = page.locator(".login-page__toggle-password");
  assert(await reveal.isDisabled());
  await password.pressSequentially("manual-example");
  assert(await reveal.isEnabled());
  await reveal.click();
  assert.equal(await password.getAttribute("type"), "text");
  // Unknown replacement models password-manager fills without manual edit events.
  await password.evaluate((el) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set.call(el, "autofilled-example");
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertReplacementText",
        data: "autofilled-example",
      }),
    );
  });
  assert.equal(await password.getAttribute("type"), "password");
  assert.equal(await reveal.count(), 0);
  await password.press("End");
  await password.pressSequentially("x");
  assert.equal(await reveal.count(), 0);
  await password.fill("");
  await password.pressSequentially("new-manual-example");
  assert(await reveal.isEnabled());
  await reveal.click();
  assert.equal(await password.getAttribute("type"), "text");
  await password.fill("");
  assert.equal(await password.inputValue(), "");
  assert.equal(await password.getAttribute("type"), "password");
  report.checks.push(
    "Typed passwords can be revealed; unknown fills and partial edits remain masked; clearing restores manual reveal",
  );
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const dots = await page
      .locator(".login-page__footer-divider")
      .evaluateAll((els) =>
        els.map((el) => ({
          w: el.getBoundingClientRect().width,
          h: el.getBoundingClientRect().height,
          color: getComputedStyle(el).backgroundColor,
          left:
            el.getBoundingClientRect().left -
            el.previousElementSibling.getBoundingClientRect().right,
          right:
            el.nextElementSibling.getBoundingClientRect().left -
            el.getBoundingClientRect().right,
        })),
      );
    assert.equal(dots.length, 2);
    assert.deepEqual(dots[0], dots[1]);
    assert.equal(dots[0].left, dots[0].right);
    assert(
      await page
        .locator(".login-page__card")
        .evaluate((el) => el.getBoundingClientRect().right <= innerWidth),
    );
    await page.screenshot({ path: join(output, `login-${width}.png`) });
  }
  report.checks.push(
    "Both footer dots have identical size and spacing at desktop and mobile widths",
  );
  await page.getByRole("button", { name: "修改密码", exact: true }).click();
  await page.locator("#new-password").waitFor();
  assert.equal(await page.locator("#lang-select").count(), 0);
  await page.getByRole("button", { name: "返回登录", exact: true }).click();
  if (!preview) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("#username").fill(smokeUsername);
    await password.fill(process.env.WORKAGENT_SMOKE_PASSWORD);
    await page.getByLabel("记住密码", { exact: true }).check();
    const loginResponse = page.waitForResponse((r) =>
      r.url().endsWith("/api/auth/login"),
    );
    await page.getByRole("button", { name: "登录", exact: true }).click();
    assert.equal((await loginResponse).status(), 200);
    await page.locator(".hHd-Xa_root").waitFor();
    const cookie = (await context.cookies()).find((c) =>
      c.name.endsWith("workagent-session"),
    );
    assert(cookie.httpOnly);
    assert(cookie.expires > Date.now() / 1000 + 29 * 86400);
    const deviceCookie = (await context.cookies()).find((c) =>
      c.name.endsWith("workagent-session-remembered"),
    );
    assert(deviceCookie?.httpOnly);
    assert(deviceCookie.expires > Date.now() / 1000 + 29 * 86400);
    const storage = await page.evaluate(() => Object.values(localStorage));
    assert(
      !storage.some((value) =>
        value.includes(process.env.WORKAGENT_SMOKE_PASSWORD),
      ),
    );
    // Closing a browser cancels its pending application requests; stop observing
    // the old page once the restart begins, then observe the new browser again.
    page.removeAllListeners("pageerror");
    await context.close();
    page = await openBrowser();
    await page.goto(`${baseURL}/?frontend=dsh`);
    await page.locator(".hHd-Xa_root").waitFor();
    assert.equal(
      (await page.request.get(`${baseURL}/api/auth/me`)).status(),
      200,
    );
    await page.screenshot({
      path: join(output, "remembered-after-browser-restart.png"),
    });
    report.checks.push(
      "Remembered login survives a real browser restart with a 30-day HttpOnly cookie and no password in localStorage",
    );
    assert.equal(
      (
        await page.request.post(`${baseURL}/api/auth/logout`, {
          headers: { Origin: baseURL },
        })
      ).status(),
      204,
    );
    page.removeAllListeners("pageerror");
    await page.close();
    page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(error.message));
    assert.equal(
      (await page.request.get(`${baseURL}/api/auth/me`)).status(),
      401,
    );
    await page.goto(`${baseURL}/?frontend=dsh`);
    await page.locator("#password").waitFor();
    await page.waitForFunction(
      () => document.querySelector("#password")?.value === "••••••••",
    );
    assert.equal(await page.locator("#password").inputValue(), "••••••••");
    assert.equal(
      await page.locator("#password").getAttribute("readonly"),
      null,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "重新输入密码", exact: true })
        .count(),
      0,
    );
    assert.equal(await page.locator(".login-page__toggle-password").count(), 0);
    const savedResponse = page.waitForResponse((r) =>
      r.url().endsWith("/api/auth/login"),
    );
    await page.getByRole("button", { name: "登录", exact: true }).click();
    const savedLogin = await savedResponse;
    assert.equal(savedLogin.status(), 200);
    assert.deepEqual(savedLogin.request().postDataJSON(), {
      username: smokeUsername,
      useRemembered: true,
      remember: true,
    });
    await page.locator(".hHd-Xa_root").waitFor();
    page.removeAllListeners("pageerror");
    await page.request.post(`${baseURL}/api/auth/logout`, {
      headers: { Origin: baseURL },
    });
    await context.close();
    page = await openBrowser();
    await page.goto(`${baseURL}/?frontend=dsh`);
    await page.waitForFunction(
      () => document.querySelector("#password")?.value === "••••••••",
    );
    await page.screenshot({ path: join(output, "saved-password-masked.png") });
    assert(
      !(await page.evaluate(() => document.cookie)).includes(
        "workagent-session-remembered",
      ),
    );
    await page.locator("#password").click();
    await page.locator("#password").press("Backspace");
    assert.equal(await page.locator("#password").inputValue(), "");
    await page.locator("#password").pressSequentially("manual-after-delete");
    assert.equal(
      await page.locator("#password").inputValue(),
      "manual-after-delete",
    );
    assert(await page.locator(".login-page__toggle-password").isEnabled());
    await page.reload();
    await page.waitForFunction(
      () => document.querySelector("#password")?.value === "••••••••",
    );
    await page.getByLabel("记住密码", { exact: true }).uncheck();
    await page.waitForFunction(
      () => document.querySelector("#password")?.value === "",
    );
    assert.equal(await page.locator("#password").inputValue(), "");
    await page.reload();
    assert.equal(
      (await (await page.request.get(`${baseURL}/api/auth/remembered`)).json())
        .username,
      null,
    );
    assert.equal(await page.locator("#password").inputValue(), "");
    report.checks.push(
      "Saved login survives logout, fills an opaque masked value, submits without exposing a password, and can be forgotten",
    );
    const ordinary = await page.request.post(`${baseURL}/api/auth/login`, {
      headers: { Origin: baseURL },
      data: {
        username: smokeUsername,
        password: process.env.WORKAGENT_SMOKE_PASSWORD,
        remember: false,
      },
    });
    assert.equal(ordinary.status(), 200);
    const ordinaryCookie = (await context.cookies()).find((c) =>
      c.name.endsWith("workagent-session"),
    );
    assert.equal(ordinaryCookie.expires, -1);
    await page.request.post(`${baseURL}/api/auth/logout`, {
      headers: { Origin: baseURL },
    });
    report.checks.push(
      "Explicit logout revokes the current session; ordinary login has no persistent session cookie",
    );
  }
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report));
} finally {
  if (context) await context.close();
  await writeFile(
    join(output, "login-report.json"),
    JSON.stringify(report, null, 2),
  );
  if (!resolve(profile).startsWith(join(tmpdir(), "workagent-login-smoke-")))
    throw new Error("Temporary browser profile escaped its directory");
  await rm(profile, { recursive: true, force: true });
}
