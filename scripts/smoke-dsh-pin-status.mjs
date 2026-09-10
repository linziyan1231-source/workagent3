import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, webkit } from "playwright";
import { login } from "./smoke-dsh-helpers.mjs";
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const output = join(process.env.WORKAGENT_SMOKE_EVIDENCE_DIR, engine);
await mkdir(output, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const report = { checks: [], errors: [] };
page.on("pageerror", (e) => report.errors.push(e.message));
if (process.env.WORKAGENT_SMOKE_CSS) {
  const body = await readFile(process.env.WORKAGENT_SMOKE_CSS, "utf8");
  await page.route("**/plugins/@workagent/dsh-client/tokens.css*", (r) =>
    r.fulfill({ contentType: "text/css", body }),
  );
}
try {
  await login(page);
  const row = page
    .locator(".workagent-sidebar-session:has(.workagent-session-status)")
    .first();
  await row.waitFor();
  const pin = row.locator("[aria-pressed]");
  const label = await pin.getAttribute("aria-label");
  assert.equal(await pin.getAttribute("aria-pressed"), "false");
  await pin.click();
  const selected = page
    .getByRole("button", {
      name: label.replace(/^置顶 /, "取消置顶 "),
      exact: true,
    })
    .first();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(400);
    if (
      (await page.locator(".hHd-Xa_root").getAttribute("class")).includes(
        "hHd-Xa_collapsed",
      )
    )
      await page.locator(".hHd-Xa_toggle").click();
    await selected.evaluate((element) => element.blur());
    await page.mouse.move(width - 2, 880);
    const state = await selected.evaluate((pin) => {
      const row = pin.parentElement,
        status = row.querySelector(".workagent-session-status"),
        edit = row.querySelector(".workagent-row-action:not([aria-pressed])");
      return {
        opacity: getComputedStyle(pin).opacity,
        fill: getComputedStyle(pin.querySelector("path")).fill,
        status: status.getBoundingClientRect().right,
        pinLeft: pin.getBoundingClientRect().left,
        pinRight: pin.getBoundingClientRect().right,
        editLeft: edit.getBoundingClientRect().left,
      };
    });
    assert.equal(state.opacity, "1");
    assert.notEqual(state.fill, "none");
    assert(
      state.status <= state.pinLeft && state.pinRight <= state.editLeft + 1,
    );
    await page.screenshot({ path: join(output, `pinned-${width}.png`) });
    report.checks.push(
      `${width}: pinned icon remains solid and visible; status, pin and edit never overlap`,
    );
  }
  await selected.click();
  const unpinned = page
    .getByRole("button", { name: label, exact: true })
    .first();
  assert.equal(await unpinned.getAttribute("aria-pressed"), "false");
  assert.equal(
    await unpinned
      .locator("path")
      .first()
      .evaluate((el) => getComputedStyle(el).fill),
    "none",
  );
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report));
} finally {
  await writeFile(
    join(output, "pin-report.json"),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
