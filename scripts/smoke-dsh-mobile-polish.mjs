import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { login } from "./smoke-dsh-helpers.mjs";
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const output = `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/${engine}`;
await mkdir(output, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 844 } });
await page.addInitScript(() => {
  localStorage.setItem("workagent.files.open", "false");
  localStorage.setItem(
    "workagent.appearance.v1",
    JSON.stringify({ mode: "porcelain", daylight: "porcelain" }),
  );
});
const report = { checks: [], errors: [] };
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
try {
  await login(page);
  for (const width of [390, 320, 760, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const root = page.locator(".hHd-Xa_root");
    if ((await root.getAttribute("class")).includes("hHd-Xa_collapsed"))
      await page.locator(".hHd-Xa_toggle").click();
    await page.locator(".hHd-Xa_newSession").click();
    await page.waitForTimeout(350);
    const form = page.locator(".workagent-hero-composer");
    await form.waitFor();
    if (
      width <= 760 &&
      !(await root.getAttribute("class")).includes("hHd-Xa_collapsed")
    )
      await page.locator(".hHd-Xa_toggle").click();
    await checkComposer(form, width, "home");
    if ((await root.getAttribute("class")).includes("hHd-Xa_collapsed"))
      await page.locator(".hHd-Xa_toggle").click();
    await page.screenshot({ path: `${output}/sidebar-${width}.png` });
    await page
      .locator(".workagent-sidebar-session .is-main")
      .filter({ hasText: /^hi$/ })
      .first()
      .click();
    const chat = page.locator(
      ".workagent-conversation-workspace > .workagent-conversation > form",
    );
    await chat.waitFor();
    await checkComposer(chat, width, "chat");
    if (width <= 760) {
      assert.equal(
        await page
          .locator(
            ".workagent-conversation-workspace > .workagent-conversation > header:visible",
          )
          .count(),
        0,
      );
      assert.equal(
        await page
          .locator(
            ".workagent-overlay:has(.workagent-conversation-workspace) > header:visible",
          )
          .count(),
        0,
      );
      const boxes = await page
        .locator(".workagent-conversation-workspace > .workagent-conversation")
        .evaluate((el) => ({
          gap: getComputedStyle(el).gap,
          scroll: el
            .querySelector(".workagent-message-list")
            .getBoundingClientRect().bottom,
          composer: el.querySelector("form").getBoundingClientRect().top,
        }));
      assert.equal(boxes.gap, "0px");
      assert(Math.abs(boxes.scroll - boxes.composer) < 2);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .locator(".hHd-Xa_root")
    .getByText("定时任务", { exact: true })
    .click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${output}/automations.png` });
  const footer = page.locator(".workagent-automation-form-footer");
  await footer.scrollIntoViewIfNeeded();
  assert.notEqual(
    await footer
      .locator("button")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    await footer
      .locator("button")
      .last()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  );
  await page.screenshot({ path: `${output}/automation-footer.png` });
  await footer.getByRole("button", { name: "取消", exact: true }).click();
  const card = page.locator(".workagent-automation-card").first();
  await card.waitFor();
  const colors = await card.locator("button").evaluateAll((nodes) =>
    nodes.map((el) => ({
      bg: getComputedStyle(el).backgroundColor,
      color: getComputedStyle(el).color,
    })),
  );
  assert.deepEqual(colors[0], colors[1]);
  assert.deepEqual(colors[0], colors[3]);
  assert.notEqual(colors[0].bg, colors[2].bg);
  assert.notEqual(colors[0].color, colors[4].color);
  await page.screenshot({ path: `${output}/automation-cards.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  if (
    !(await page.locator(".hHd-Xa_root").getAttribute("class")).includes(
      "hHd-Xa_collapsed",
    )
  )
    await page.locator(".hHd-Xa_toggle").click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${output}/automation-mobile.png` });
  assert(
    await card.evaluate((el) => el.getBoundingClientRect().right <= innerWidth),
  );
  report.checks.push(
    "Automation primary, secondary and delete actions are distinct; cards fit mobile",
  );
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report));
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
async function checkComposer(form, width, name) {
  const input = form.locator("textarea");
  await input.waitFor();
  const original = await input.inputValue();
  try {
    await input.fill("");
    await page.waitForTimeout(150);
    if (width <= 760) {
      const box = await form.boundingBox();
      assert(box.height <= 64, `${name} ${width}: height ${box.height}`);
      assert.equal(await form.locator("select:visible").count(), 0);
      const toggle = form.getByRole("button", { name: "模型与权限设置" });
      await toggle.click();
      await form.locator("select").nth(1).waitFor({ state: "visible" });
      assert((await form.locator("select:visible").count()) >= 2);
      await page.screenshot({ path: `${output}/${name}-options-${width}.png` });
      await toggle.click();
      await input.fill("第一行\n第二行\n第三行");
      assert((await input.boundingBox()).height >= 72);
      await input.fill("很长的内容，用来验证输入区域随文字增长。\n".repeat(25));
      const size = await input.evaluate((el) => ({
        height: el.clientHeight,
        scroll: el.scrollHeight,
      }));
      assert(size.height <= 145 && size.scroll > size.height);
      await page.screenshot({ path: `${output}/${name}-long-${width}.png` });
      await input.fill("");
      assert((await input.boundingBox()).height <= 25);
    } else assert((await form.locator("select:visible").count()) >= 2);
    await page.screenshot({ path: `${output}/${name}-${width}.png` });
    report.checks.push(
      `${name} ${width}: compact input, options, capped growth and shrink`,
    );
  } finally {
    await input.fill(original);
  }
}
