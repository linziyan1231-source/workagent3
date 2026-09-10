import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { login, openSettingsSection } from "./smoke-dsh-helpers.mjs";

const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const evidence = `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/mobile-settings-${engine}`;
await mkdir(evidence, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  hasTouch: true,
});
const report = { checks: [], errors: [] };
page.on("pageerror", (e) => report.errors.push(e.message));
try {
  await login(page);
  if (process.env.WORKAGENT_SMOKE_CSS)
    await page.addStyleTag({
      content: await readFile(process.env.WORKAGENT_SMOKE_CSS, "utf8"),
    });
  await openSettingsSection(page, "消息渠道");
  await page.locator(".ima-platform-head").first().waitFor();
  const dialog = page.getByRole("dialog", { name: /设置|Settings/i });
  for (const [width, height] of [
    [390, 740],
    [320, 640],
    [700, 390],
    [1440, 900],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(800);
    if (!(await dialog.isVisible())) {
      if (width <= 760)
        await page
          .getByRole("button", { name: "打开侧边栏", exact: true })
          .click();
      if (!(await dialog.isVisible()))
        await openSettingsSection(page, "消息渠道");
    }
    const sections = await dialog
      .locator(".VOzbGW_navCell:visible")
      .allTextContents();
    for (const section of sections) {
      await dialog
        .locator(".VOzbGW_navList")
        .getByRole("button", { name: section.trim(), exact: true })
        .click();
      await page.waitForTimeout(200);
      const geometry = await dialog.evaluate((el) => {
        const r = el.getBoundingClientRect(),
          options = el.querySelector(".VOzbGW_options"),
          nav = el.querySelector(".VOzbGW_nav");
        const containers = [
          options,
          ...el.querySelectorAll(
            ".ima-account-shell,.ima-platforms,.workagent-form",
          ),
        ].filter((e) => e.clientWidth);
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          contentWidth: options.clientWidth,
          contentHeight: options.clientHeight,
          navWidth: nav.clientWidth,
          overflow: containers
            .filter((e) => e.scrollWidth > e.clientWidth + 2)
            .map((e) => ({
              class: e.className,
              width: e.clientWidth,
              scrollWidth: e.scrollWidth,
            })),
        };
      });
      assert(
        geometry.x >= -1 &&
          geometry.y >= -1 &&
          geometry.x + geometry.width <= width + 1 &&
          geometry.y + geometry.height <= height + 1,
        JSON.stringify({ section, width, geometry }),
      );
      assert.deepEqual(
        geometry.overflow,
        [],
        JSON.stringify({ section, width, geometry }),
      );
      if (width <= 760)
        assert(
          geometry.contentWidth >= width - 2 && geometry.contentHeight > 120,
          JSON.stringify(geometry),
        );
      else
        assert(
          geometry.navWidth < geometry.contentWidth,
          "Desktop keeps side navigation",
        );
      if (
        width === 390 &&
        ["消息渠道", "系统与帮助", "通用设置", "模型"].includes(section.trim())
      )
        await page.screenshot({ path: `${evidence}/${section.trim()}.png` });
    }
    await dialog
      .locator(".VOzbGW_navList")
      .getByRole("button", { name: "消息渠道", exact: true })
      .click();
    await page.locator(".ima-platform-head").first().waitFor();
    if (width <= 760 && (await page.locator(".ima-account-row").count())) {
      await page.locator(".ima-account-row").first().click();
      const inspector = page.locator(".ima-inspector");
      await inspector.waitFor();
      await inspector.scrollIntoViewIfNeeded();
      assert(
        await inspector.evaluate((el) => el.scrollWidth <= el.clientWidth + 2),
        "Account settings fit the screen",
      );
      const picker = inspector.locator(".ima-model-select .ima-chip-btn");
      if (await picker.count()) {
        await picker.click();
        const menu = inspector.locator(".ima-model-select .ima-chip-menu");
        await menu.waitFor();
        const bounds = await menu.boundingBox();
        assert(
          bounds.x >= 0 && bounds.x + bounds.width <= width,
          "Model menu fits the screen",
        );
        await picker.click();
      }
      if (width === 390)
        await page.screenshot({ path: `${evidence}/channel-account.png` });
    }
    const options = dialog.locator(".VOzbGW_options");
    await options.evaluate((el) => (el.scrollTop = 0));
    const before = await dialog.locator(".VOzbGW_close").boundingBox();
    await options.hover();
    await page.mouse.wheel(0, 1000);
    await page.waitForTimeout(250);
    const scroll = await options.evaluate((el) => ({
      top: el.scrollTop,
      max: el.scrollHeight - el.clientHeight,
      body: document.scrollingElement.scrollTop,
    }));
    assert(scroll.max === 0 || scroll.top > 0, "Settings content scrolls");
    assert.equal(scroll.body, 0, "Page remains fixed");
    assert.deepEqual(
      await dialog.locator(".VOzbGW_close").boundingBox(),
      before,
      "Close stays fixed",
    );
    report.checks.push({ width, height, sections: sections.length, scroll });
  }
  await dialog.locator(".VOzbGW_close").click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report));
} finally {
  await page.screenshot({ path: `${evidence}/last-state.png` });
  await writeFile(`${evidence}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
