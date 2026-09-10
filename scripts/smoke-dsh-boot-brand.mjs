import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import {
  baseURL,
  smokeUsername,
  requireSmokeEnvironment,
} from "./smoke-dsh-helpers.mjs";
requireSmokeEnvironment();
const out = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
await mkdir(out, { recursive: true });
for (const [name, engine] of Object.entries({ chromium, webkit })) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    const errors = [];
    const onPageError = (error) => errors.push(error.message);
    page.on("pageerror", onPageError);
    if (process.env.WORKAGENT_SMOKE_BOOT_ASSET) {
      const body = await readFile(
        process.env.WORKAGENT_SMOKE_BOOT_ASSET,
        "utf8",
      );
      await page.route("**/index-ClqxG24t.js", (r) =>
        r.fulfill({ body, contentType: "text/javascript" }),
      );
    }
    // Delay plugin downloads so the real startup screen can be inspected.
    await page.route(
      "**/plugins/@workagent/dsh-client/client.js*",
      async (r) => {
        await new Promise((resolve) => setTimeout(resolve, 6000));
        try {
          await r.continue();
        } catch (error) {
          // A plugin can cancel its own startup request during the delay.
          if (!error.message.includes("Route is already handled")) throw error;
        }
      },
    );
    const response = await page.request.post(`${baseURL}/api/auth/login`, {
      data: {
        username: smokeUsername,
        password: process.env.WORKAGENT_SMOKE_PASSWORD,
      },
      headers: { Origin: new URL(baseURL).origin },
    });
    assert.equal(response.ok(), true);
    await page.goto(`${baseURL}/?frontend=dsh`, {
      waitUntil: "domcontentloaded",
    });
    const boot = page.locator("[data-dsh-boot]");
    await boot.waitFor({ state: "visible" });
    assert.equal(
      await boot
        .locator("div")
        .filter({ hasText: /^WorkAgent$/ })
        .last()
        .textContent(),
      "WorkAgent",
    );
    assert.doesNotMatch(await boot.innerText(), /HARNESS/);
    await page.screenshot({ path: `${out}/${name}-loading.png` });
    await boot.waitFor({ state: "detached", timeout: 60000 });
    await page.locator("textarea").first().waitFor();
    await page.screenshot({ path: `${out}/${name}-loaded.png` });
    await page.unrouteAll({ behavior: "wait" });
    assert.deepEqual(errors, []);
    // Stop observing the departing document: WebKit reports its cancelled
    // sessions fetch as a page error during intentional navigation.
    page.off("pageerror", onPageError);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("textarea").first().waitFor();
    if (!process.env.WORKAGENT_SMOKE_BOOT_ASSET) {
      assert.match(
        await page
          .locator('script[src*="index-ClqxG24t.js"]')
          .getAttribute("src"),
        /workagent-boot=1/,
      );
    }
    assert.deepEqual(errors, []);
    await writeFile(
      `${out}/${name}.json`,
      JSON.stringify({
        loadingBrand: "WorkAgent",
        loaded: true,
        normalReload: true,
        errors,
        preview: !!process.env.WORKAGENT_SMOKE_BOOT_ASSET,
      }),
    );
    console.log(`${name}: startup branding and authenticated app passed`);
  } finally {
    await browser.close();
  }
}
