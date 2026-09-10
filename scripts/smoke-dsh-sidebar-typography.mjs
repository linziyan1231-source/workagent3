import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { login } from "./smoke-dsh-helpers.mjs";
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const output = `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/${engine}`;
await mkdir(output, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const report = {
  checks: [],
  errors: [],
  preview: !!process.env.WORKAGENT_SMOKE_CSS,
};
await page.addInitScript(() =>
  localStorage.setItem("workagent.files.open", "false"),
);
page.on("pageerror", (e) => report.errors.push(e.message));
if (process.env.WORKAGENT_SMOKE_CSS) {
  const body = await readFile(process.env.WORKAGENT_SMOKE_CSS, "utf8");
  await page.route("**/plugins/@workagent/dsh-client/tokens.css*", (r) =>
    r.fulfill({ contentType: "text/css", body }),
  );
}
try {
  await login(page);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(350);
    if (
      !(await page
        .getByRole("button", { name: "设置", exact: true })
        .isVisible())
    )
      await page
        .getByRole("button", { name: "打开侧边栏", exact: true })
        .click();
    for (const size of ["13", "14", "16", "18"]) {
      if (
        !(await page
          .getByRole("button", { name: "设置", exact: true })
          .isVisible())
      )
        await page
          .getByRole("button", { name: "打开侧边栏", exact: true })
          .click();
      await page.getByRole("button", { name: "设置", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "设置", exact: true });
      await dialog
        .getByRole("button", { name: "通用设置", exact: true })
        .click();
      await dialog.getByLabel("字体大小", { exact: true }).selectOption(size);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      await page.waitForTimeout(400);
      if (
        !(await page
          .getByRole("button", { name: "设置", exact: true })
          .isVisible())
      )
        await page
          .getByRole("button", { name: "打开侧边栏", exact: true })
          .click();
      await page.waitForTimeout(400);
      const result = await page.evaluate(() => {
        const selectors = [
          ".hHd-Xa_settingsArea .VOzbGW_trigger",
          '.workagent-footer[data-kind="logout"]',
          ".hHd-Xa_newSession",
        ];
        return selectors.map((s) => {
          const el = document.querySelector(s),
            r = el.getBoundingClientRect(),
            style = getComputedStyle(el);
          return {
            font: parseFloat(style.fontSize),
            top: r.top,
            height: r.height,
            left: r.left,
            right: r.right,
            overflow: el.scrollWidth > el.clientWidth + 1,
          };
        });
      });
      assert(
        result.every(
          (r) => Math.abs(r.font - Number(size)) < 0.1 && !r.overflow,
        ),
        JSON.stringify({ width, size, result }),
      );
      assert(
        Math.abs(result[0].top - result[1].top) < 1,
        JSON.stringify({ width, size, result }),
      );
      assert.equal(result[0].height, result[1].height);
      assert(result[0].right <= result[1].left + 1, JSON.stringify(result));
      report.checks.push({ width, size, result });
      if (size === "18")
        await page
          .locator(".hHd-Xa_root")
          .screenshot({ path: `${output}/sidebar-${width}.png` });
    }
  }
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
