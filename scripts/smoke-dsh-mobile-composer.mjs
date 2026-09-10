import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { baseURL, smokeUsername } from "./smoke-dsh-helpers.mjs";

const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
if (!evidence) throw new Error("Evidence directory required");
await mkdir(evidence, { recursive: true });
const browser = await (
  process.env.WORKAGENT_SMOKE_WEBKIT ? webkit : chromium
).launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 740 },
  isMobile: true,
  hasTouch: true,
});
const report = { checks: [], errors: [], resizeNotifications: [] };
page.on("pageerror", (error) => {
  if (
    error.message ===
    "ResizeObserver loop completed with undelivered notifications."
  )
    report.resizeNotifications.push(error.message);
  else report.errors.push(error.message);
});
try {
  const auth = await page.request.post(`${baseURL}/api/auth/login`, {
    data: {
      username: smokeUsername,
      password: process.env.WORKAGENT_SMOKE_PASSWORD,
    },
    headers: { Origin: new URL(baseURL).origin },
  });
  assert(auth.ok());
  await page.goto(`${baseURL}/?frontend=dsh`);
  await page.locator(".workagent-agent").filter({ hasText: "Codex" }).click();
  await page
    .getByLabel("模型", { exact: true })
    .locator("option")
    .filter({ hasText: /GPT|Kimi/ })
    .first()
    .waitFor({ state: "attached" });
  if (process.env.WORKAGENT_SMOKE_CSS)
    await page.addStyleTag({
      content: await readFile(process.env.WORKAGENT_SMOKE_CSS, "utf8"),
    });
  for (const width of [390, 375, 320, 700, 760, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const agent of ["Codex", "Kimi"]) {
      await page.locator(".workagent-agent").filter({ hasText: agent }).click();
      await page.waitForFunction(
        () => !document.querySelector('[aria-label="模型"]').disabled,
      );
      await page.waitForTimeout(250);
      const geometry = await page.evaluate(() => {
        const box = (el) => {
          const r = el.getBoundingClientRect();
          return {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
            right: r.right,
            bottom: r.bottom,
          };
        };
        const strip = document.querySelector(".workagent-agent-strip");
        return {
          controls: [
            ...document.querySelectorAll(".workagent-composer-options select"),
          ].map(box),
          strip: box(strip),
          agents: [...strip.children].map(box),
          form: box(document.querySelector(".workagent-hero-composer")),
          send: box(document.querySelector(".workagent-composer-send")),
          viewport: window.innerWidth,
          document: document.documentElement.scrollWidth,
        };
      });
      const { controls, agents, strip, form, send } = geometry;
      assert.equal(controls.length, 3);
      for (const control of controls) {
        assert(
          Math.abs(control.y - controls[0].y) < 1,
          JSON.stringify(geometry),
        );
        assert.equal(control.height, controls[0].height);
        assert(
          control.width > 20 &&
            control.x >= form.x &&
            control.right <= send.x + 1,
          JSON.stringify(geometry),
        );
      }
      assert(
        strip.right - agents.at(-1).right < 8,
        "Agent strip reserves an empty slot",
      );
      assert(send.right <= form.right && send.bottom <= form.bottom);
      assert(geometry.document <= geometry.viewport);
      report.checks.push({ width, agent, geometry });
      if ([390, 320, 1440].includes(width))
        await page.screenshot({
          path: `${evidence}/home-${width}-${agent}.png`,
        });
    }
  }
  report.typography = [];
  for (const width of [390, 320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByLabel("团队模式", { exact: true }).check();
    await page.getByLabel("新项目名称", { exact: true }).fill("字号预览");
    const type = await page.evaluate(() => {
      const size = (selector) =>
        parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
      return {
        title: size(".pXSMma_headlineText"),
        input: size(".workagent-hero-composer textarea"),
        projectInput: size(".workagent-project-name"),
        controls: [
          ".workagent-agent",
          ".workagent-composer-options select",
          ".workagent-project-select select",
          ".workagent-team-toggle",
          ".workagent-hero-composer > button",
        ].map(size),
        tops: [
          ...document.querySelectorAll(".workagent-composer-options select"),
        ].map((el) => el.getBoundingClientRect().top),
        modelWidth: document
          .querySelector('[aria-label="模型"]')
          .getBoundingClientRect().width,
        sendBottom: document
          .querySelector(".workagent-composer-send")
          .getBoundingClientRect().bottom,
        formBottom: document
          .querySelector(".workagent-hero-composer")
          .getBoundingClientRect().bottom,
      };
    });
    assert(type.title > type.input && type.input >= type.controls[0]);
    assert.equal(type.input, type.projectInput);
    assert(
      type.controls.every((size) => size === type.controls[0]),
      JSON.stringify(type),
    );
    assert(type.tops.every((top) => Math.abs(top - type.tops[0]) < 1));
    assert(type.modelWidth > 20 && type.sendBottom <= type.formBottom);
    report.typography.push({ width, ...type });
    await page.screenshot({ path: `${evidence}/team-type-${width}.png` });
    await page.getByLabel("团队模式", { exact: true }).uncheck();
  }
  assert.deepEqual(report.errors, []);
  console.log(
    JSON.stringify({
      checks: report.checks.length,
      typography: report.typography.length,
      errors: report.errors,
      resizeNotifications: report.resizeNotifications,
    }),
  );
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png` });
  report.failure = {
    message: error.message,
    controls: await page.locator(".workagent-composer-options").innerText(),
  };
  throw error;
} finally {
  await writeFile(
    `${evidence}/mobile-composer-report.json`,
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
