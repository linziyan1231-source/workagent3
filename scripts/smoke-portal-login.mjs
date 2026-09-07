import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  baseURL,
  smokeUsername,
  requireSmokeEnvironment,
} from "./smoke-dsh-helpers.mjs";

requireSmokeEnvironment();
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const output = process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR;
const screenshot = async (name) => {
  if (!output) return;
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, name) });
};
try {
  const documentResponse = await page.goto(`${baseURL}/?frontend=dsh`);
  assert.match(documentResponse.headers()["cache-control"], /no-store/);
  await page.getByRole("heading", { name: "WorkAgent", exact: true }).waitFor();
  assert.equal(await page.title(), "WorkAgent - 登录");
  assert.equal(await page.locator(".login-page img").count(), 0);
  const card = await page.locator(".login-page__card").boundingBox();
  assert.equal(card.width, 360);
  assert.equal(Math.round(card.x + card.width / 2), 720);
  assert.match(
    await page
      .locator(".login-page")
      .evaluate((el) => getComputedStyle(el).backgroundImage),
    /151, 160, 197/,
  );
  await screenshot("login-desktop.png");

  for (const code of await page
    .locator("#lang-select option")
    .evaluateAll((options) => options.map((el) => el.value))) {
    await page.locator("#lang-select").selectOption(code);
    assert.match(await page.title(), /WorkAgent/);
    assert.doesNotMatch(await page.locator("body").innerText(), /puxin\s*ai/i);
  }
  await page.locator("#lang-select").selectOption("en-US");
  await page.reload();
  await page.getByRole("button", { name: "Sign In", exact: true }).waitFor();
  await page.locator("#lang-select").selectOption("zh-CN");
  await page.locator("#password").fill("visibility-check");
  await page.getByRole("button", { name: "显示密码" }).click();
  assert.equal(await page.locator("#password").getAttribute("type"), "text");
  await page.getByRole("button", { name: "隐藏密码" }).click();
  assert.equal(
    await page.locator("#password").getAttribute("type"),
    "password",
  );
  await page.locator("#password").fill("");

  await page.getByRole("button", { name: "修改密码", exact: true }).click();
  await page.locator("#username").fill("validation-only");
  await page.locator("#password").fill("not-a-real-credential");
  await page.locator("#new-password").fill("validation-example-one");
  await page.locator("#confirm-password").fill("validation-example-two");
  let passwordRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/auth/password")) passwordRequests++;
  });
  await page.getByRole("button", { name: "确认修改" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "两次输入的新密码不一致" })
    .waitFor();
  assert.equal(passwordRequests, 0);
  await page.getByRole("button", { name: "返回登录" }).click();
  assert.equal(await page.locator("#password").inputValue(), "");
  await page.locator("#username").fill("");

  // Exercise the visible error state without making failed real login attempts.
  await page.route("**/api/auth/login", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "invalid_credentials" }),
    }),
  );
  await page.locator("#username").fill("validation-only");
  await page.locator("#password").fill("invalid-example");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "用户名或密码错误" })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "登录", exact: true }).isEnabled(),
    true,
  );
  await page.unroute("**/api/auth/login");
  await page.reload();
  await page.locator("#username").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("login-mobile.png");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.setViewportSize({ width: 844, height: 390 });
  await page
    .getByRole("button", { name: "登录", exact: true })
    .scrollIntoViewIfNeeded();
  assert.equal(
    await page.getByRole("button", { name: "登录", exact: true }).isVisible(),
    true,
  );
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.locator("#username").fill(smokeUsername);
  await page.locator("#password").fill(process.env.WORKAGENT_SMOKE_PASSWORD);
  await page.getByLabel("记住我", { exact: true }).check();
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/?frontend=dsh");
  await page.getByText("WorkAgent", { exact: true }).waitFor();
  await page.getByRole("button", { name: /settings|设置/i }).waitFor();
  await screenshot("login-authenticated-dsh.png");
  assert.deepEqual(errors, []);
  // Credentials must never be saved by the remember-me control.
  const storage = await page.evaluate(() => ({ ...localStorage }));
  assert.equal(storage["workagent.login.username"], smokeUsername);
  assert.equal(
    Object.values(storage).some((value) =>
      value.includes(process.env.WORKAGENT_SMOKE_PASSWORD),
    ),
    false,
  );
  await page.request.post(`${baseURL}/api/auth/logout`, {
    headers: { Origin: new URL(baseURL).origin },
  });
  await page.goto(`${baseURL}/?frontend=dsh`);
  await page.locator("#username").waitFor();
  assert.equal(await page.locator("#username").inputValue(), smokeUsername);
  assert.equal(await page.locator("#password").inputValue(), "");
  await page.getByLabel("记住我", { exact: true }).uncheck();
  await page.reload();
  await page.locator("#username").waitFor();
  assert.equal(await page.locator("#username").inputValue(), "");
  if (output)
    await writeFile(
      join(output, "login-checks.json"),
      JSON.stringify(
        {
          branding: "WorkAgent",
          legacyLayout: true,
          languages: 11,
          passwordVisibility: true,
          passwordValidation: true,
          loginErrorRecovery: true,
          mobile: true,
          realLoginToDsh: true,
          logout: true,
          rememberUsername: true,
          pageErrors: errors,
        },
        null,
        2,
      ),
    );
  console.log(
    "Portal login smoke passed: WorkAgent branding, WorkAgent2 layout, languages, password controls, responsive layout, authenticated DSH and logout",
  );
} catch (error) {
  if (output)
    await page.screenshot({
      path: join(output, "login-failure.png"),
      mask: [page.locator("input")],
    });
  throw error;
} finally {
  await browser.close();
}
