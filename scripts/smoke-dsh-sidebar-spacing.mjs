import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { login } from "./smoke-dsh-helpers.mjs";
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const output = `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/${engine}`;
await mkdir(output, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  localStorage.setItem("workagent.files.open", "false");
  localStorage.setItem("workagent.font-size", "18");
});
const report = {
  checks: [],
  errors: [],
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
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
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
    const geometry = await page.locator(".hHd-Xa_root").evaluate((el) => {
      const logo = el.querySelector(".hHd-Xa_logoRow").getBoundingClientRect(),
        create = el.querySelector(".hHd-Xa_newSession").getBoundingClientRect();
      const nav = [...el.querySelectorAll(".workagent-footer")]
        .filter(
          (b) =>
            b.getBoundingClientRect().height &&
            ["chatgpt", "tasks", "teams"].includes(b.dataset.kind),
        )
        .map((b) => b.getBoundingClientRect())
        .sort((a, b) => a.top - b.top);
      const region = el
        .querySelector(".hHd-Xa_regionArea")
        .getBoundingClientRect();
      const heading = el
        .querySelector(".workagent-sidebar-heading")
        .getBoundingClientRect();
      const settings = el
          .querySelector(".VOzbGW_trigger")
          .getBoundingClientRect(),
        logout = el
          .querySelector('[data-kind="logout"]')
          .getBoundingClientRect();
      return {
        boxes: {
          logo: logo.toJSON(),
          create: create.toJSON(),
          nav: nav.map((r) => r.toJSON()),
          region: region.toJSON(),
        },
        parents: [
          ...el.querySelectorAll(
            ".hHd-Xa_footerActions,div:has(> .workagent-footer)",
          ),
        ].map((p) => {
          const s = getComputedStyle(p);
          return {
            cls: p.className,
            rect: p.getBoundingClientRect().toJSON(),
            padding: s.padding,
            margin: s.margin,
            gap: s.gap,
            box: s.boxSizing,
          };
        }),
        gaps: [
          create.top - logo.bottom,
          nav[0].top - create.bottom,
          region.top - nav.at(-1).bottom,
        ],
        headingOffset: heading.top - region.top,
        footerAligned: Math.abs(settings.top - logout.top) < 1,
        overflow: el.scrollWidth > el.clientWidth + 1,
      };
    });
    assert(
      geometry.gaps.every((g) => Math.abs(g - 8) < 1),
      JSON.stringify({ width, geometry }),
    );
    assert(
      geometry.footerAligned && !geometry.overflow,
      JSON.stringify(geometry),
    );
    report.checks.push({ width, ...geometry });
    await page
      .locator(".hHd-Xa_root")
      .screenshot({ path: `${output}/sidebar-${width}.png` });
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
