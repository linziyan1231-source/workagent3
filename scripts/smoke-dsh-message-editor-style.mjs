import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { login } from "./smoke-dsh-helpers.mjs";
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const output = `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/${engine}`;
await mkdir(output, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript(() =>
  localStorage.setItem("workagent.files.open", "false"),
);
const report = {
  checks: [],
  errors: [],
  writes: [],
  preview: !!process.env.WORKAGENT_SMOKE_CSS,
};
page.on("pageerror", (e) => report.errors.push(e.message));
if (process.env.WORKAGENT_SMOKE_CSS) {
  const body = await readFile(process.env.WORKAGENT_SMOKE_CSS, "utf8");
  await page.route("**/plugins/@workagent/dsh-client/tokens.css*", (r) =>
    r.fulfill({ contentType: "text/css", body }),
  );
}
try {
  await login(page);
  page.on("request", (r) => {
    if (
      /\/(fork|messages)$/.test(new URL(r.url()).pathname) &&
      r.method() === "POST"
    )
      report.writes.push(new URL(r.url()).pathname);
  });
  await page
    .locator(".workagent-sidebar-session .is-main")
    .filter({ hasText: /^hi$/ })
    .first()
    .click();
  const edit = page.getByRole("button", { name: "编辑", exact: true }).first();
  await edit.waitFor({ timeout: 60000 });
  await edit.locator("xpath=ancestor::article").hover();
  await edit.click();
  const form = page.locator(".workagent-message-editor");
  const input = page.getByLabel("编辑消息", { exact: true });
  const original = await input.inputValue();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await input.fill("要这一个月的");
    await input.focus();
    await form.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const geometry = await form.evaluate((el) => {
      const r = el.getBoundingClientRect(),
        t = el.querySelector("textarea"),
        s = getComputedStyle(t),
        fs = getComputedStyle(el);
      return {
        width: r.width,
        overflow: el.scrollWidth > el.clientWidth + 1,
        outline: s.outlineStyle,
        resize: s.resize,
        radius: fs.borderRadius,
        buttons: [...el.querySelectorAll("button")].map((b) => {
          const br = b.getBoundingClientRect();
          return {
            inside: br.left >= r.left && br.right <= r.right,
            height: br.height,
          };
        }),
      };
    });
    assert(
      !geometry.overflow && geometry.buttons.every((b) => b.inside),
      JSON.stringify(geometry),
    );
    assert.equal(geometry.outline, "none");
    assert.equal(geometry.resize, "none");
    assert.equal(geometry.radius, "16px");
    assert.match(
      await form.locator("small").innerText(),
      /不会回滚已修改的文件/,
    );
    report.checks.push({ width, ...geometry });
    await form.screenshot({ path: `${output}/editor-${width}.png` });
  }
  await input.fill("");
  assert(
    await form
      .getByRole("button", { name: "保存并重发", exact: true })
      .isDisabled(),
  );
  await form.getByRole("button", { name: "取消编辑", exact: true }).click();
  await form.waitFor({ state: "hidden" });
  await edit.locator("xpath=ancestor::article").hover();
  await edit.click();
  assert.equal(await input.inputValue(), original);
  await form.getByRole("button", { name: "取消编辑", exact: true }).click();
  assert.deepEqual(report.writes, []);
  assert.deepEqual(report.errors, []);
  console.log(
    JSON.stringify({
      checks: report.checks.length,
      errors: report.errors,
      writes: report.writes,
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
