import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { baseURL, smokeUsername } from "./smoke-dsh-helpers.mjs";

const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
const session = process.env.WORKAGENT_SMOKE_SESSION;
if (!evidence || !session)
  throw new Error("Evidence directory and test session required");
await mkdir(evidence, { recursive: true });
const report = { checks: [], errors: [], resizeNotifications: [] };
const browser = await (
  process.env.WORKAGENT_SMOKE_WEBKIT ? webkit : chromium
).launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
page.on("pageerror", (error) => {
  // WebKit can defer observer delivery while resizing; retain this diagnostic
  // separately and verify the settled geometry below at every viewport size.
  if (
    error.message ===
    "ResizeObserver loop completed with undelivered notifications."
  )
    report.resizeNotifications.push(error.message);
  else report.errors.push(error.message);
});
await page.addInitScript(() =>
  localStorage.setItem("workagent.files.open", "false"),
);
try {
  const auth = await page.request.post(`${baseURL}/api/auth/login`, {
    data: {
      username: smokeUsername,
      password: process.env.WORKAGENT_SMOKE_PASSWORD,
    },
    headers: { Origin: new URL(baseURL).origin },
  });
  assert(auth.ok(), `Login returned ${auth.status()}`);
  await page.goto(
    `${baseURL}/?frontend=dsh&session=${encodeURIComponent(session)}`,
  );
  await page.locator(".workagent-message.is-assistant").first().waitFor();
  await page.getByLabel("当前会话思考强度", { exact: true }).waitFor();
  if (process.env.WORKAGENT_SMOKE_CSS)
    await page.addStyleTag({
      content: await readFile(process.env.WORKAGENT_SMOKE_CSS, "utf8"),
    });
  // Extend a real rendered conversation locally without modifying stored messages.
  await page.locator(".workagent-message-list").evaluate((list) => {
    const message = list.querySelector(".workagent-message.is-assistant");
    for (let i = 0; i < 30; i++) list.append(message.cloneNode(true));
  });
  for (const viewport of [
    { width: 390, height: 740 },
    { width: 390, height: 520 },
    { width: 844, height: 390 },
    { width: 1440, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(350);
    const before = await page.evaluate(() => {
      const bounds = (selector) => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return {
          top: r.top,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        };
      };
      const list = document.querySelector(".workagent-message-list");
      list.scrollTop = 0;
      return {
        composer: bounds(".workagent-conversation-composer"),
        header: bounds(".workagent-overlay-header"),
        bell: bounds(".workagent-top-notifications svg"),
        folder: bounds(".workagent-files-toggle svg"),
        listHeight: list.clientHeight,
        scrollHeight: list.scrollHeight,
        viewportHeight: window.innerHeight,
      };
    });
    assert(before.listHeight > 20 && before.scrollHeight > before.listHeight);
    assert(
      before.composer.bottom <= before.viewportHeight + 1,
      JSON.stringify(before),
    );
    assert(
      before.viewportHeight - before.composer.bottom < 40,
      JSON.stringify(before),
    );
    assert.equal(before.bell.width, before.folder.width);
    assert.equal(before.bell.height, before.folder.height);
    const controls = await page
      .locator(".workagent-session-controls select")
      .evaluateAll((rows) =>
        rows.map((row) => ({
          top: row.getBoundingClientRect().top,
          width: row.getBoundingClientRect().width,
        })),
      );
    assert(
      controls.every(
        (row) => row.width > 20 && Math.abs(row.top - controls[0].top) < 1,
      ),
      JSON.stringify(controls),
    );
    const list = page.locator(".workagent-message-list");
    if (!process.env.WORKAGENT_SMOKE_WEBKIT && viewport.width === 390) {
      const box = await list.boundingBox();
      const cdp = await context.newCDPSession(page);
      const x = box.x + box.width / 2;
      const y = box.y + box.height - 12;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      for (let step = 1; step <= 8; step++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: y - step * 12 }],
        });
        await page.waitForTimeout(20);
      }
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await page.waitForTimeout(350);
      assert(
        await list.evaluate((el) => el.scrollTop > 0),
        "Touch swipe must scroll messages",
      );
      await cdp.detach();
    }
    await list.evaluate((el) => {
      el.scrollTop = 400;
    });
    await page.evaluate(() => {
      window.scrollTo(0, 400);
      document.querySelector(".workagent-overlay").scrollTop = 400;
    });
    const after = await page.evaluate(() => ({
      scroll: window.scrollY,
      outer: document.querySelector(".workagent-overlay").scrollTop,
      inner: document.querySelector(".workagent-message-list").scrollTop,
      composer: document
        .querySelector(".workagent-conversation-composer")
        .getBoundingClientRect().bottom,
      header: document
        .querySelector(".workagent-overlay-header")
        .getBoundingClientRect().top,
    }));
    assert.equal(after.scroll, 0);
    assert.equal(after.outer, 0);
    assert(after.inner > 0);
    assert.equal(after.composer, before.composer.bottom);
    assert.equal(after.header, before.header.top);
    report.checks.push({ viewport, before, after });
    await page.screenshot({
      path: `${evidence}/chat-${viewport.width}-${viewport.height}.png`,
    });
  }
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report));
} finally {
  await writeFile(
    `${evidence}/mobile-scroll-report.json`,
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
