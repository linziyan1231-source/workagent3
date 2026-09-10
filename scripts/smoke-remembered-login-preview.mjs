import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";

const base =
  process.env.WORKAGENT_LOGIN_PREVIEW_URL ?? "http://127.0.0.1:18420";
const output =
  process.env.WORKAGENT_SMOKE_EVIDENCE_DIR ??
  ".cache/remember-password/preview";
await mkdir(output, { recursive: true });
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    let saved = "alice";
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/remembered") {
        if (route.request().method() === "DELETE") {
          saved = null;
          return route.fulfill({ status: 204 });
        }
        return route.fulfill({
          json: { username: saved },
          headers: { "Cache-Control": "no-store" },
        });
      }
      return route.fulfill({
        status: 401,
        json: { error: "invalid_credentials" },
      });
    });
    await page.goto(base);
    const password = page.locator("#password");
    const reveal = page.locator(".login-page__toggle-password");
    const replace = page.getByRole("button", {
      name: "重新输入密码",
      exact: true,
    });
    const waitSaved = () =>
      page.waitForFunction(
        () => document.querySelector("#password")?.value === "••••••••",
      );
    await waitSaved();
    assert.equal(await replace.count(), 0);
    assert.equal(await page.locator("#username").inputValue(), "alice");
    assert.equal(await password.inputValue(), "••••••••");
    assert.equal(await reveal.count(), 0);
    // Even changing the HTML input type cannot reveal a saved password.
    await password.evaluate((el) => {
      el.type = "text";
    });
    assert.equal(await password.inputValue(), "••••••••");
    await password.evaluate((el) => {
      el.type = "password";
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${output}/${name}-saved.png` });
    const request = page.waitForRequest((r) =>
      r.url().endsWith("/api/auth/login"),
    );
    await page.getByRole("button", { name: "登录", exact: true }).click();
    assert.deepEqual((await request).postDataJSON(), {
      username: "alice",
      useRemembered: true,
      remember: true,
    });
    await page.getByText("已保存的密码已失效，请重新输入密码").waitFor();
    assert.equal(await password.inputValue(), "");
    await password.pressSequentially("manual-example");
    assert(await reveal.isEnabled());
    await reveal.click();
    assert.equal(await password.getAttribute("type"), "text");
    await password.evaluate((el) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "browser-filled-example");
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: "browser-filled-example" }));
    });
    assert.equal(await password.getAttribute("type"), "password");
    assert.equal(await reveal.count(), 0);
    await password.pressSequentially("x");
    assert.equal(await reveal.count(), 0);
    await password.fill("");
    await password.pressSequentially("manual-after-autofill");
    assert(await reveal.isEnabled());
    await page.reload();
    await waitSaved();
    await page.locator("#username").fill("bob");
    assert.equal(await password.inputValue(), "");
    assert.equal(await password.getAttribute("readonly"), null);
    await page.reload();
    await waitSaved();
    await password.click();
    assert.equal(await password.inputValue(), "••••••••");
    await password.press("Backspace");
    assert.equal(await password.inputValue(), "");
    await password.pressSequentially("manual-again");
    assert(await reveal.isEnabled());
    await page.reload();
    await waitSaved();
    await password.click();
    await password.press("Home");
    await password.press("Delete");
    assert.equal(await password.inputValue(), "");
    await page.reload();
    await waitSaved();
    await password.click();
    await password.pressSequentially("replacement");
    assert.equal(await password.inputValue(), "replacement");
    await page.reload();
    await waitSaved();
    await password.click();
    await password.press("Home");
    await password.press("ArrowRight");
    await page.keyboard.insertText("p•aste");
    assert.equal(await password.inputValue(), "p•aste");
    await page.reload();
    await waitSaved();
    await password.evaluate((el) => {
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          inputType: "deleteContentBackward",
        }),
      );
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "deleteContentBackward",
        }),
      );
    });
    assert.equal(await password.inputValue(), "");
    await page.reload();
    await waitSaved();
    await page.getByRole("button", { name: "修改密码", exact: true }).click();
    assert.equal(await password.inputValue(), "");
    assert.equal(await password.getAttribute("readonly"), null);
    await page.getByRole("button", { name: "返回登录", exact: true }).click();
    await waitSaved();
    await page.getByLabel("记住密码", { exact: true }).uncheck();
    await page.waitForFunction(
      () => document.querySelector("#password").value === "",
    );
    assert.equal(await password.inputValue(), "");
    await page.reload();
    assert.equal(await password.inputValue(), "");
    assert.equal(await replace.count(), 0);
    assert.deepEqual(errors, []);
    await writeFile(
      `${output}/${name}.json`,
      JSON.stringify(
        {
          passed: true,
          checks: [
            "opaque fill",
            "no eye icon for saved or browser-filled passwords",
            "credential-only submission",
            "expired recovery",
            "manual reveal",
            "account switch",
            "direct Backspace/Delete and mobile deletion",
            "direct typing replaces saved dots",
            "replacement preserves inserted characters without saved dots",
            "no replacement button",
            "password-change manual entry",
            "forget persists",
          ],
        },
        null,
        2,
      ),
    );
    console.log(`${name}: saved-password direct editing preview checks passed`);
  } finally {
    await browser.close();
  }
}
