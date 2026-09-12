import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { login, openSettingsSection } from "./smoke-dsh-helpers.mjs";
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const out = `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/typography-${engine}`;
await mkdir(out, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const report = [];
try {
  for (const width of [1440, 390])
    for (const size of [13, 14, 16, 18]) {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
        hasTouch: width === 390,
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript((size) => {
        localStorage.setItem("workagent.font-size", String(size));
        localStorage.setItem("workagent.files.open", "false");
      }, size);
      if (process.env.WORKAGENT_SMOKE_CANDIDATE)
        for (const file of ["client.js", "tokens.css"])
          await page.route(
            `**/plugins/@workagent/dsh-client/${file}*`,
            async (r) =>
              r.fulfill({
                body: await readFile(
                  `${process.env.WORKAGENT_SMOKE_CANDIDATE}/${file}`,
                ),
                contentType: file.endsWith("css")
                  ? "text/css"
                  : "application/javascript",
              }),
          );
      try {
        await login(page);
      } catch (error) {
        await page.screenshot({
          path: `${out}/load-failure-${width}-${size}.png`,
        });
        console.log(
          JSON.stringify({
            width,
            size,
            errors,
            url: page.url(),
            body: (await page.locator("body").innerText()).slice(0, 500),
          }),
        );
        throw error;
      }
      await openSettingsSection(page, "消息渠道");
      await page.locator(".ima-account-row").first().click();
      await page.setViewportSize({ width, height: 1000 });
      const metric = async (selector, role) => {
        const actual = await page
          .locator(selector)
          .first()
          .evaluate((el, role) => {
            const s = getComputedStyle(el);
            const probe = document.createElement("span");
            probe.style.fontSize = `var(--workagent-type-${role})`;
            el.parentElement.append(probe);
            const expected = getComputedStyle(probe).fontSize;
            probe.remove();
            return { font: s.fontSize, expected, line: s.lineHeight };
          }, role);
        assert.equal(
          actual.font,
          actual.expected,
          `${width}/${size} ${selector}`,
        );
        return actual;
      };
      await metric(".ima-title", "section");
      await metric(".ima-platform-title", "body");
      await metric(".ima-platform-add", "control");
      await metric(".ima-sub", "caption");
      await metric(".ima-inspector-title", "section");
      await metric(".ima-picker-label", "caption");
      await metric(".ima-chip-btn", "control");
      // Open only the configuration dialog, never generate QR codes or save accounts.
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.locator(".ima-platform-add").first().click();
      await page.locator(".ima-modal").waitFor();
      await page.setViewportSize({ width, height: 1000 });
      await metric(".ima-modal-h h2", "section");
      await metric(".ima-modal .ima-picker-label", "caption");
      await metric(".ima-modal .ima-hint", "caption");
      await metric(".ima-modal .ima-btn", "control");
      await page.screenshot({ path: `${out}/${width}-${size}.png` });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.locator(".ima-x").click();
      await page
        .locator(".ima-platform")
        .filter({ has: page.getByText("企业微信", { exact: true }) })
        .locator(".ima-platform-add")
        .click();
      await page.getByRole("button", { name: "手动配置", exact: true }).click();
      await page.setViewportSize({ width, height: 1000 });
      await metric(".ima-modal .ima-field input", "input");
      await page.evaluate(() => {
        const b = document.createElement("div");
        b.id = "typography-fixture";
        b.innerHTML =
          '<div class="workagent-message-editor"><textarea aria-label="audit-edit">中文第一行\n第二行</textarea></div><form class="workagent-conversation-composer workagent-compact-composer"><textarea aria-label="audit-compose"></textarea></form>';
        document.body.append(b);
      });
      const metrics = await page
        .locator("#typography-fixture textarea")
        .evaluateAll((es) =>
          es.map((e) => {
            const s = getComputedStyle(e);
            return {
              font: s.fontSize,
              line: s.lineHeight,
              family: s.fontFamily,
            };
          }),
        );
      assert.deepEqual(metrics[0], metrics[1]);
      if (width === 390) assert.ok(parseFloat(metrics[0].font) >= 16);
      await page.getByLabel("audit-edit").focus();
      await page.getByLabel("audit-edit").fill("中文第一行\n继续补充第二行");
      assert.equal(
        await page.getByLabel("audit-edit").inputValue(),
        "中文第一行\n继续补充第二行",
      );
      const focused = await page.getByLabel("audit-edit").evaluate((e) => ({
        font: getComputedStyle(e).fontSize,
        line: getComputedStyle(e).lineHeight,
      }));
      assert.equal(focused.font, metrics[0].font);
      assert.equal(focused.line, metrics[0].line);
      assert.deepEqual(errors, []);
      report.push({
        width,
        size,
        input: metrics[0],
        channels: "roles matched",
        modal: "roles matched",
      });
      await page.close();
    }
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(`${engine}: ${report.length} typography combinations passed`);
} finally {
  await browser.close();
}
