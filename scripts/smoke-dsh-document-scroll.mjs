import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { login } from "./smoke-dsh-helpers.mjs";
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const out = `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/${engine}`;
await mkdir(out, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 844 },
  hasTouch: true,
});
const page = await context.newPage();
const report = { checks: [], errors: [], resizeNotifications: [] };
page.on("pageerror", (error) => {
  // WebKit may defer ResizeObserver delivery during a viewport resize. Geometry is checked after settling.
  if (
    error.message ===
    "ResizeObserver loop completed with undelivered notifications."
  )
    report.resizeNotifications.push(error.message);
  else report.errors.push(error.message);
});
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
await page.addInitScript(() =>
  localStorage.setItem("workagent.files.open", "false"),
);
const list = page.locator(
  ".workagent-conversation-workspace > .workagent-conversation > .workagent-message-list",
);
try {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await drawer(true);
  await page
    .locator(".workagent-sidebar-session .is-main")
    .filter({ hasText: /^hi$/ })
    .first()
    .click();
  await page.locator(".hHd-Xa_collapsed").waitFor();
  await list.waitFor();
  await page.waitForTimeout(400);
  await page.addStyleTag({
    content: ":root{--workagent-safe-top:59px;--workagent-safe-bottom:34px}",
  });
  await list.evaluate((el) => {
    const sample = document.createElement("div");
    sample.dataset.scrollSample = "true";
    sample.style.cssText =
      "height:3000px;background:linear-gradient(#dcebe3,#d3def2)";
    sample.textContent = "仅浏览器内的滚动样本";
    el.append(sample);
  });
  for (const size of [
    { width: 390, height: 844 },
    { width: 390, height: 520 },
    { width: 760, height: 844 },
    { width: 844, height: 390 },
    { width: 1440, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(250);
    await drawer(false);
    await page.evaluate((mobile) => {
      const list = document.querySelector(".workagent-message-list");
      if (mobile) window.scrollTo(0, 400);
      else list.scrollTop = 400;
    }, size.width <= 760);
    await page.waitForTimeout(150);
    const state = await geometry();
    assert.equal(
      state.inner,
      size.width <= 760 ? 0 : 400,
      JSON.stringify(state),
    );
    assert.equal(
      state.document,
      size.width <= 760 ? 400 : 0,
      JSON.stringify(state),
    );
    assert(
      state.composer.bottom <= size.height &&
        state.composer.bottom >= size.height - 40,
      JSON.stringify(state),
    );
    if (size.width <= 760) {
      assert(state.button.top >= 50);
      assert.equal(state.overlayPosition, "relative");
    }
    report.checks.push({ size, state });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await drawer(false);
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.waitForTimeout(120);
  await drawer(true);
  const open = await page.evaluate(() => ({
    scroll: scrollY,
    sidebar: getComputedStyle(document.querySelector(".pI_x6G_sidebarCol"))
      .position,
    backdrop: getComputedStyle(
      document.querySelector(".workagent-mobile-backdrop"),
    ).position,
    top: document
      .querySelector(".workagent-mobile-backdrop")
      .getBoundingClientRect().top,
  }));
  assert.deepEqual(open, {
    scroll: 0,
    sidebar: "relative",
    backdrop: "absolute",
    top: 0,
  });
  await page.screenshot({ path: `${out}/document-drawer.png` });
  if (engine === "chromium") {
    const projects = page.locator(".workagent-sidebar-projects");
    const bounds = await projects.boundingBox();
    const cdp = await context.newCDPSession(page);
    for (const edge of ["start", "end"]) {
      await projects.evaluate((el, edge) => {
        el.scrollTop = edge === "start" ? 0 : el.scrollHeight;
      }, edge);
      const x = bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height - 30;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      for (let step = 1; step <= 8; step++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: y - step * 16 }],
        });
      }
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await page.waitForTimeout(200);
      assert(
        await projects.evaluate((el) => el.scrollTop > 0),
        "Touch gesture scrolls sidebar rows",
      );
      assert.equal(
        await page.evaluate(() => scrollY),
        0,
        "Sidebar touch scrolling must not reach the document, including at its end",
      );
    }
    await cdp.detach();
    report.checks.push("Sidebar touch scrolling stays clipped at both ends");
  }
  await page
    .locator(".workagent-mobile-backdrop")
    .click({ position: { x: 40, y: 240 } });
  await page.waitForTimeout(200);
  assert.equal(
    (await geometry()).document,
    500,
    "Drawer close restores transcript position",
  );
  if (engine === "chromium") {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 180, y: 450 }],
    });
    for (let step = 1; step <= 8; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: 180, y: 450 - step * 20 }],
      });
      await page.waitForTimeout(20);
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForTimeout(400);
    assert((await geometry()).document > 500, "Touch scrolls the document");
    await cdp.detach();
  }
  const input = page.locator(".workagent-conversation-composer textarea");
  await input.focus();
  // Exercise visual-viewport handling without changing a stored draft or sending a message.
  await page.evaluate(() => {
    const vv = window.visualViewport;
    Object.defineProperties(vv, {
      height: { configurable: true, value: 520 },
      offsetTop: { configurable: true, value: 0 },
      scale: { configurable: true, value: 1 },
    });
    vv.dispatchEvent(new Event("resize"));
  });
  const keyboard = await geometry();
  assert(keyboard.composer.bottom <= 520, JSON.stringify(keyboard));
  await page.evaluate(() => {
    const vv = window.visualViewport;
    for (const key of ["height", "offsetTop", "scale"]) delete vv[key];
    vv.dispatchEvent(new Event("resize"));
  });
  await input.blur();
  await page.screenshot({ path: `${out}/document-chat.png` });
  // A side conversation remains a separate bounded scroller after removing the container query on mobile.
  await list.evaluate((el) => {
    const workspace = el.closest(".workagent-conversation-workspace");
    workspace.classList.add("has-side-chat");
    const aside = document.createElement("aside");
    aside.className = "workagent-side-chat";
    aside.dataset.scrollFixture = "true";
    aside.innerHTML =
      '<section class="workagent-conversation"><header>侧聊布局样本</header><div class="workagent-message-list"><div style="height:1400px;flex-shrink:0">独立滚动</div></div><form class="workagent-conversation-composer">输入框样本</form></section>';
    workspace.append(aside);
  });
  const side = await page.locator("[data-scroll-fixture]").evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    overflow: getComputedStyle(el.querySelector(".workagent-message-list"))
      .overflowY,
    scrollHeight: el.querySelector(".workagent-message-list").scrollHeight,
    height: el.querySelector(".workagent-message-list").clientHeight,
  }));
  assert(side.width <= 390);
  assert.equal(side.overflow, "auto");
  assert(side.scrollHeight > side.height);
  await list.evaluate((el) => {
    const workspace = el.closest(".workagent-conversation-workspace");
    workspace.querySelector("[data-scroll-fixture]").remove();
    workspace.classList.remove("has-side-chat");
    el.querySelector("[data-scroll-sample]").remove();
  });
  await drawer(true);
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  await page.getByRole("heading", { name: "定时任务", exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector(".workagent-overlay"))
        .overflowY === "visible",
  );
  await page.locator(".workagent-overlay-content").evaluate((el) => {
    const sample = document.createElement("div");
    sample.dataset.pageSample = "true";
    sample.style.height = "2000px";
    el.append(sample);
  });
  await page.evaluate(() => window.scrollTo(0, 350));
  await page.waitForTimeout(150);
  await drawer(true);
  await drawer(false);
  assert.equal(
    await page.evaluate(() => scrollY),
    350,
    "Other pages retain position across drawer toggles",
  );
  await page.locator("[data-page-sample]").evaluate((el) => el.remove());
  report.checks.push({
    drawer: open,
    keyboard,
    side,
    pageDrawerRestoration: true,
  });
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report));
} finally {
  await writeFile(
    `${out}/document-scroll-report.json`,
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
async function drawer(open) {
  const el = page.locator(".hHd-Xa_root");
  if ((await el.getAttribute("class")).includes("hHd-Xa_collapsed") === open)
    await page.locator(".hHd-Xa_toggle").click();
  await page.waitForFunction(
    (value) =>
      document
        .querySelector(".hHd-Xa_root")
        .classList.contains("hHd-Xa_collapsed") !== value,
    open,
  );
  await page.waitForTimeout(150);
}
async function geometry() {
  return page.evaluate(() => ({
    document: scrollY,
    inner: document.querySelector(".workagent-message-list").scrollTop,
    overlayPosition: getComputedStyle(
      document.querySelector(".workagent-overlay"),
    ).position,
    composer: document
      .querySelector(".workagent-conversation-composer")
      .getBoundingClientRect()
      .toJSON(),
    button: document
      .querySelector(".hHd-Xa_toggle")
      .getBoundingClientRect()
      .toJSON(),
  }));
}
