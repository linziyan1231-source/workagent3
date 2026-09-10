import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { login, baseURL } from "./smoke-dsh-helpers.mjs";
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const out = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR + "/" + engine;
await mkdir(out, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 844 },
  hasTouch: true,
});
const result = { checks: [], errors: [] };
page.on("pageerror", (e) => result.errors.push(e.message));
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
await page.addInitScript(() => {
  localStorage.setItem("workagent.files.open", "false");
  localStorage.setItem(
    "workagent.appearance.v1",
    JSON.stringify({ mode: "porcelain", daylight: "porcelain" }),
  );
});
try {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.style.setProperty(
      "--workagent-safe-bottom",
      "34px",
    );
    document.documentElement.style.setProperty("--workagent-safe-top", "59px");
  });
  const sidebar = page.locator(".hHd-Xa_root");
  if ((await sidebar.getAttribute("class")).includes("hHd-Xa_collapsed"))
    await page.locator(".hHd-Xa_toggle").click();
  await page.locator(".hHd-Xa_newSession").click();
  await page.waitForTimeout(500);
  if ((await sidebar.getAttribute("class")).includes("hHd-Xa_collapsed"))
    await page.locator(".hHd-Xa_toggle").click();
  const settings = page.locator(".hHd-Xa_settingsArea .VOzbGW_trigger"),
    logout = page.locator('.workagent-footer[data-kind="logout"]');
  const a = await settings.boundingBox(),
    b = await logout.boundingBox();
  result.footer = { a, b };
  assert(Math.abs(a.y - b.y) < 1, "footer y");
  assert.equal(a.height, b.height);
  assert(844 - b.y - b.height <= 23, "lower footer");
  const project = page
    .locator(".workagent-sidebar-project:visible")
    .filter({ has: page.locator(".workagent-sidebar-session") })
    .first();
  const plus = await project
    .locator(".workagent-sidebar-project-row .workagent-row-action")
    .first()
    .boundingBox();
  const pin = await project
    .locator(".workagent-sidebar-session .workagent-row-action[aria-pressed]")
    .first()
    .boundingBox();
  result.icons = { plus, pin };
  assert(
    Math.abs(plus.x + plus.width / 2 - pin.x - pin.width / 2) < 1,
    "icon column",
  );
  await page.screenshot({ path: out + "/sidebar.png" });
  await page
    .locator(".workagent-sidebar-session .is-main:visible")
    .filter({ hasText: /^hi$/ })
    .first()
    .click();
  await page.waitForTimeout(400);
  const form = page.locator(".workagent-conversation-composer");
  await form.waitFor();
  const tops = await page
    .locator(
      ".hHd-Xa_collapsed .hHd-Xa_toggle, .hHd-Xa_collapsed .hHd-Xa_newSession, .workagent-top-actions > button",
    )
    .evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { y: r.y, h: r.height };
      }),
    );
  result.tops = tops;
  assert(
    tops.every(
      (r) =>
        Math.abs(r.y - tops[0].y) < 1 && r.h === 38 && Math.abs(r.y - 69) < 1,
    ),
    "top alignment",
  );
  const box = await form.boundingBox();
  assert(Math.abs(844 - box.y - box.height - 22) < 2, "lower composer");
  const fade = await page
    .locator(".workagent-conversation")
    .evaluate((el) => ({
      filter: getComputedStyle(el, "::after").backdropFilter,
      mask: getComputedStyle(el, "::after").maskImage,
    }));
  assert.match(fade.filter, /blur/);
  assert.match(fade.mask, /gradient/);
  await page.screenshot({ path: out + "/chat.png" });
  const branch = page.getByRole("button", { name: /分支/ }).last();
  await branch.click();
  await page.getByRole("dialog", { name: "从这里创建分支？" }).waitFor();
  await page.screenshot({ path: out + "/fork.png" });
  await page.getByRole("button", { name: "继续当前对话", exact: true }).click();
  assert.equal(await page.locator(".workagent-fork-dialog").count(), 0);
  for (const route of ["automations", "teams"]) {
    if ((await sidebar.getAttribute("class")).includes("hHd-Xa_collapsed"))
      await page.locator(".hHd-Xa_toggle").click();
    await page
      .locator(
        '.workagent-footer[data-kind="' +
          (route === "automations" ? "tasks" : "teams") +
          '"]',
      )
      .click();
    await page.locator(".workagent-overlay-header").waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.locator(".workagent-overlay-back").count(), 0);
    if (route === "teams")
      assert.equal(
        await page
          .getByRole("button", { name: "共享项目", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
    await page.screenshot({ path: out + "/" + route + ".png" });
  }
  if ((await sidebar.getAttribute("class")).includes("hHd-Xa_collapsed"))
    await page.locator(".hHd-Xa_toggle").click();
  await settings.click();
  const general = page
    .locator(".VOzbGW_navCell")
    .filter({ hasText: "通用设置" });
  await general.click();
  const center = await general.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect(),
      b = el.getBoundingClientRect();
    return { text: r.x + r.width / 2, button: b.x + b.width / 2 };
  });
  assert(
    Math.abs(center.text - center.button) < 1,
    "general settings centered",
  );
  await page.screenshot({ path: out + "/settings.png" });
  result.checks.push(
    "bottom controls, matching footer, icon column, fade, cancel fork, no back buttons, shared default",
  );
  assert.deepEqual(result.errors, []);
  console.log(JSON.stringify(result));
} finally {
  await writeFile(out + "/report.json", JSON.stringify(result, null, 2));
  await browser.close();
}
