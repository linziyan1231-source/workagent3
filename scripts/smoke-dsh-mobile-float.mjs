import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { login } from "./smoke-dsh-helpers.mjs";
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const out = `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/${engine}`;
await mkdir(out, { recursive: true });
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
  for (const width of [320, 390, 760, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const sidebar = page.locator(".hHd-Xa_root");
    if ((await sidebar.getAttribute("class")).includes("hHd-Xa_collapsed"))
      await page.locator(".hHd-Xa_toggle").click();
    await page.locator(".hHd-Xa_newSession").click();
    await page.waitForTimeout(400);
    if (
      width <= 760 &&
      !(await sidebar.getAttribute("class")).includes("hHd-Xa_collapsed")
    )
      await page.locator(".hHd-Xa_toggle").click();
    await check(page.locator(".workagent-hero-composer"), "home", width);
    if ((await sidebar.getAttribute("class")).includes("hHd-Xa_collapsed"))
      await page.locator(".hHd-Xa_toggle").click();
    await page
      .locator(".workagent-sidebar-session .is-main")
      .filter({ hasText: /^hi$/ })
      .first()
      .click();
    const form = page.locator(
      ".workagent-conversation-workspace > .workagent-conversation > form",
    );
    await page.waitForTimeout(400);
    await check(form, "chat", width);
    if (width <= 760) {
      const geometry = await form.evaluate((form) => {
        const list = form.parentElement.querySelector(
          ".workagent-message-list",
        );
        return {
          list: list.getBoundingClientRect().toJSON(),
          form: form.getBoundingClientRect().toJSON(),
          padding: parseFloat(getComputedStyle(list).paddingBottom),
        };
      });
      assert(
        geometry.list.bottom > geometry.form.bottom,
        JSON.stringify(geometry),
      );
      assert(geometry.padding > geometry.form.height);
      if (width === 390) {
        const list = page.locator(
          ".workagent-conversation-workspace > .workagent-conversation > .workagent-message-list",
        );
        await list.evaluate((el) => {
          const sample = document.createElement("div");
          sample.dataset.floatSample = "true";
          sample.style.cssText =
            "background:#dcebe3;padding:16px;line-height:32px";
          sample.textContent = "用于检查悬浮遮盖和滚动边界的长文本。".repeat(
            180,
          );
          el.append(sample);
          el.scrollTop = 700;
        });
        try {
          await page.screenshot({ path: out + "/chat-overlap-390.png" });
          await list.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
          });
          const end = await list.locator("[data-float-sample]").boundingBox();
          assert(
            end.y + end.height <= (await form.boundingBox()).y,
            "Last line can scroll above composer",
          );
        } finally {
          await list.evaluate((el) =>
            el.querySelector("[data-float-sample]").remove(),
          );
        }
      }
      for (const selector of [
        ".pI_x6G_sidebarCol",
        ".hHd-Xa_collapsed",
        ".hHd-Xa_collapsed .hHd-Xa_logoRow",
      ])
        assert.equal(
          await page
            .locator(selector)
            .evaluate((el) => getComputedStyle(el).backgroundColor),
          "rgba(0, 0, 0, 0)",
          selector,
        );
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  if (
    !(await page.locator(".hHd-Xa_root").getAttribute("class")).includes(
      "hHd-Xa_collapsed",
    )
  )
    await page.locator(".hHd-Xa_toggle").click();
  await writeFile(
    `${out}/navigation-styles.json`,
    JSON.stringify(
      await page.locator(".hHd-Xa_logoRow").evaluate((el) =>
        [el, ...el.querySelectorAll("*")].map((n) => ({
          tag: n.tagName,
          cls: n.className,
          bg: getComputedStyle(n).background,
          before: getComputedStyle(n, "::before").background,
          after: getComputedStyle(n, "::after").background,
        })),
      ),
      null,
      2,
    ),
  );
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report));
} finally {
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
async function check(form, name, width) {
  await form.waitFor();
  const input = form.locator("textarea");
  const draft = await input.inputValue();
  try {
    await input.fill("");
    await input.blur();
    await page.waitForTimeout(120);
    if (width <= 760) {
      assert((await form.boundingBox()).height <= 64);
      await input.focus();
      await page.waitForTimeout(120);
      const box = await input.boundingBox(),
        plus = await form.locator(".workagent-attachment-button").boundingBox(),
        frame = await form.boundingBox();
      assert(
        plus.y >= box.y + box.height,
        `${name} ${width}: toolbar below text`,
      );
      assert(box.width > frame.width - 42, `${name} ${width}: full width text`);
      await page.screenshot({ path: `${out}/${name}-focus-${width}.png` });
      await input.fill(
        "这是一段长文字，用来检查输入框宽度和高度。\n".repeat(25),
      );
      await page.waitForTimeout(120);
      assert(
        await input.evaluate(
          (el) => el.clientHeight <= 145 && el.scrollHeight > el.clientHeight,
        ),
      );
      const toggle = form.getByRole("button", { name: "模型与权限设置" });
      await toggle.click();
      await form.locator("select").nth(1).waitFor({ state: "visible" });
      assert((await form.locator("select:visible").count()) >= 2);
      await toggle.click();
      await input.fill("");
      await input.blur();
      await page.waitForTimeout(100);
      assert((await form.boundingBox()).height <= 64);
    }
    await page.screenshot({ path: `${out}/${name}-${width}.png` });
    report.checks.push(
      `${name} ${width}: floating layout and focused full-width input`,
    );
  } finally {
    await input.fill(draft);
    await input.blur();
  }
}
