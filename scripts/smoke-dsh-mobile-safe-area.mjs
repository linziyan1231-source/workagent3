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
const report = { checks: [], errors: [], resizeNotifications: [] };
page.on("pageerror", (error) => {
  // WebKit can defer ResizeObserver delivery while resizing; settled geometry is checked below.
  if (
    engine === "webkit" &&
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
try {
  await login(page);
  if (!process.env.WORKAGENT_SMOKE_CSS) {
    assert.match(
      await page.locator('meta[name="viewport"]').getAttribute("content"),
      /viewport-fit=cover/,
    );
    assert.equal(
      await page
        .locator('meta[name="apple-mobile-web-app-status-bar-style"]')
        .count(),
      0,
    );
    const manifest = await page.request.get(
      new URL(
        await page.locator('link[rel="manifest"]').getAttribute("href"),
        page.url(),
      ).href,
    );
    assert.equal((await manifest.json()).display, "standalone");
  }
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
          window.scrollTo(0, 700);
        });
        try {
          await page.screenshot({ path: out + "/chat-overlap-390.png" });
          await list.evaluate((el) => {
            window.scrollTo(0, document.documentElement.scrollHeight);
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
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--workagent-safe-top", "59px");
    document.documentElement.style.setProperty(
      "--workagent-safe-bottom",
      "34px",
    );
  });
  await page.waitForTimeout(300);
  await setSidebar(false);
  const topInsets = [];
  for (const [inset, expected] of [
    [0, 2],
    [20, 22],
    [44, 46],
    [59, 50],
    [62, 52],
  ]) {
    await page.evaluate((value) => {
      document.documentElement.style.setProperty(
        "--workagent-safe-top",
        `${value}px`,
      );
    }, inset);
    const top = (await page.locator(".hHd-Xa_toggle").boundingBox()).y;
    assert.equal(top, expected);
    topInsets.push({ inset, top });
  }
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--workagent-safe-top", "59px");
  });
  report.checks.push({ topInsets });
  const geometry = await page.evaluate(() => {
    const rect = (s) =>
      document.querySelector(s).getBoundingClientRect().toJSON();
    const list = document.querySelector(
      ".workagent-conversation-workspace > .workagent-conversation > .workagent-message-list",
    );
    window.scrollTo(0, 0);
    return {
      list: rect(
        ".workagent-conversation-workspace > .workagent-conversation > .workagent-message-list",
      ),
      top: rect(".workagent-top-actions"),
      nav: rect(".hHd-Xa_toggle"),
      composer: rect(".workagent-conversation-composer"),
      padding: parseFloat(getComputedStyle(list).paddingTop),
    };
  });
  assert.equal(geometry.list.y, 0, JSON.stringify(geometry));
  assert(
    geometry.top.y >= 50 && geometry.nav.y >= 50,
    JSON.stringify(geometry),
  );
  // The accepted mobile bottom baseline uses 22px clearance for a 34px inset.
  assert(geometry.composer.bottom <= 822, JSON.stringify(geometry));
  assert.equal(geometry.padding, 112);
  assert.equal(geometry.top.y, 50);
  assert.equal(geometry.nav.y, 50);
  await setSidebar(true);
  const sidebarGeometry = await page.locator(".hHd-Xa_root").evaluate((el) => ({
    bounds: el.getBoundingClientRect().toJSON(),
    logo: el.querySelector(".hHd-Xa_logoRow").getBoundingClientRect().toJSON(),
    bottom: parseFloat(getComputedStyle(el).paddingBottom),
    logout: el
      .querySelector('.workagent-footer[data-kind="logout"]')
      .getBoundingClientRect()
      .toJSON(),
  }));
  assert.equal(sidebarGeometry.bounds.y, 0);
  assert.equal(sidebarGeometry.logo.y, 40);
  assert(sidebarGeometry.logo.right <= sidebarGeometry.bounds.right);
  assert(sidebarGeometry.logo.y >= 40, JSON.stringify(sidebarGeometry));
  assert(sidebarGeometry.bottom >= 22, JSON.stringify(sidebarGeometry));
  assert(sidebarGeometry.logout.bottom <= 822, JSON.stringify(sidebarGeometry));
  const screenEdges = await page.evaluate(() => {
    const sidebar = document.querySelector(".hHd-Xa_root");
    const backdrop = document.querySelector(".workagent-mobile-backdrop");
    const left = document.elementFromPoint(4, 1);
    const right = document.elementFromPoint(innerWidth - 4, 1);
    return {
      sidebarPaintsTop: sidebar.contains(left),
      backdropPaintsTop: backdrop === right || backdrop.contains(right),
      backdropTop: backdrop.getBoundingClientRect().top,
      rootOverflow: getComputedStyle(document.documentElement).overflowY,
      bodyOverflow: getComputedStyle(document.body).overflowY,
    };
  });
  assert(screenEdges.sidebarPaintsTop, JSON.stringify(screenEdges));
  assert(screenEdges.backdropPaintsTop, JSON.stringify(screenEdges));
  assert.equal(screenEdges.backdropTop, 0);
  assert.equal(screenEdges.rootOverflow, "visible");
  assert.equal(screenEdges.bodyOverflow, "visible");
  await page.screenshot({ path: out + "/safe-area-sidebar-390.png" });
  await page.evaluate(() => {
    document.querySelector(".workagent-sidebar-projects").scrollTop = 300;
    window.scrollTo(0, 300);
  });
  const drawerScroll = await page.evaluate(() => {
    const rect = (selector) =>
      document.querySelector(selector).getBoundingClientRect().toJSON();
    const sidebar = document.querySelector(".hHd-Xa_root");
    const newSession = rect(".hHd-Xa_newSession");
    return {
      document: scrollY,
      inner: document.querySelector(".workagent-sidebar-projects").scrollTop,
      width: document.documentElement.scrollWidth,
      logo: rect(".hHd-Xa_logoRow"),
      newSession,
      headerCovered: [
        1,
        24,
        38,
        newSession.top - 2,
        newSession.bottom + 2,
      ].every(
        (y) =>
          document.elementFromPoint(sidebar.clientWidth / 2, y) === sidebar,
      ),
      headerOpaque:
        getComputedStyle(sidebar, "::before").backgroundColor ===
        getComputedStyle(sidebar).backgroundColor,
      backdrop: rect(".workagent-mobile-backdrop"),
      projects: rect(".workagent-sidebar-projects"),
      settings: rect(".hHd-Xa_settingsArea"),
      logout: rect('.workagent-footer[data-kind="logout"]'),
    };
  });
  assert.equal(
    drawerScroll.document,
    0,
    "Drawer rows must not scroll the document behind the status bar",
  );
  assert.equal(drawerScroll.inner, 300);
  assert(Math.abs(drawerScroll.settings.top - drawerScroll.projects.bottom - 6) < 1, "List must end 6px above footer controls (allowing viewport rounding)");
  assert.equal(drawerScroll.width, 390);
  assert.equal(drawerScroll.logo.top, 40);
  assert.equal(drawerScroll.newSession.top, 76);
  assert(
    drawerScroll.headerCovered,
    "Header gaps must cover scrolled rows and their click targets",
  );
  assert(
    drawerScroll.headerOpaque,
    "Header mask must match the sidebar surface",
  );
  assert(
    drawerScroll.backdrop.top === 0 &&
      Math.abs(drawerScroll.backdrop.bottom - 844) < 1,
    JSON.stringify(drawerScroll.backdrop),
  );
  assert(
    drawerScroll.settings.bottom <= 822 && drawerScroll.logout.bottom <= 822,
  );
  report.checks.push({ drawerScroll });
  await page.screenshot({ path: out + "/safe-area-sidebar-scrolled-390.png" });
  // iPhone can composite the status area without fixed overlays. Rows must
  // remain clipped even when the decorative header mask is absent.
  const hideMask = await page.addStyleTag({
    content: ".hHd-Xa_root::before{display:none!important}",
  });
  try {
    const clipping = await page
      .locator(".workagent-sidebar-projects")
      .evaluate((list) => {
        const bounds = list.getBoundingClientRect();
        return {
          top: bounds.top,
          headerBottom: document
            .querySelector(".hHd-Xa_newSession")
            .getBoundingClientRect().bottom,
          rowAboveClip:
            list.firstElementChild.getBoundingClientRect().top < bounds.top,
          rowsReachHeader: [1, 24, 48, bounds.top - 1].some((y) =>
            list.contains(
              document.elementFromPoint(bounds.x + bounds.width / 2, y),
            ),
          ),
          overflow: getComputedStyle(list).overflowY,
          documentHeight: document.documentElement.scrollHeight,
        };
      });
    assert(clipping.top > clipping.headerBottom);
    assert(clipping.rowAboveClip);
    assert.equal(clipping.rowsReachHeader, false);
    assert.equal(clipping.overflow, "auto");
    assert(clipping.documentHeight <= 844);
    report.checks.push({ clippingWithoutMask: clipping });
    await page.screenshot({
      path: out + "/sidebar-clipped-without-mask-390.png",
    });
  } finally {
    await hideMask.evaluate((el) => el.remove());
  }
  await setSidebar(false);
  const scrollUnderStatusBar = await page
    .locator(".workagent-message-list")
    .evaluate((list) => {
      const savedScroll = window.scrollY;
      const sample = document.createElement("div");
      sample.style.cssText = "height:1200px;flex-shrink:0;background:#dcebe3";
      list.prepend(sample);
      try {
        window.scrollTo(0, parseFloat(getComputedStyle(list).paddingTop) + 20);
        const rect = sample.getBoundingClientRect();
        return {
          sampleTop: rect.top,
          sampleBottom: rect.bottom,
          topPixelBelongsToList: list.contains(
            document.elementFromPoint(innerWidth / 2, 1),
          ),
          buttonTop: document
            .querySelector(".hHd-Xa_toggle")
            .getBoundingClientRect().top,
          documentScroll: document.documentElement.scrollTop,
        };
      } finally {
        sample.remove();
        window.scrollTo(0, savedScroll);
      }
    });
  assert(
    scrollUnderStatusBar.sampleTop < 0,
    JSON.stringify(scrollUnderStatusBar),
  );
  assert(
    scrollUnderStatusBar.sampleBottom > 59,
    JSON.stringify(scrollUnderStatusBar),
  );
  assert(
    scrollUnderStatusBar.topPixelBelongsToList,
    JSON.stringify(scrollUnderStatusBar),
  );
  assert(
    scrollUnderStatusBar.buttonTop >= 50,
    JSON.stringify(scrollUnderStatusBar),
  );
  assert(scrollUnderStatusBar.documentScroll > 0);
  await page.screenshot({ path: out + "/safe-area-chat-390.png" });
  report.checks.push({
    safeArea: geometry,
    sidebar: sidebarGeometry,
    screenEdges,
    scrollUnderStatusBar,
  });
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
      await checkButtons(form);
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
      await checkButtons(form);
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

async function checkButtons(form) {
  const theme = await page.locator("body").getAttribute("data-workagent-theme");
  try {
    for (const variant of [
      "porcelain",
      "jade",
      "paper",
      "glacier",
      "graphite",
    ]) {
      await page.locator("body").evaluate((el, value) => {
        el.dataset.workagentTheme = value;
      }, variant);
      await compareButtons(form);
    }
  } finally {
    await page.locator("body").evaluate((el, value) => {
      el.dataset.workagentTheme = value;
    }, theme);
  }
}

async function setSidebar(open) {
  const collapsed = await page
    .locator(".hHd-Xa_root")
    .evaluate((el) => el.classList.contains("hHd-Xa_collapsed"));
  if (collapsed === open) await page.locator(".hHd-Xa_toggle").click();
  await page.waitForFunction(
    (value) =>
      document
        .querySelector(".hHd-Xa_root")
        .classList.contains("hHd-Xa_collapsed") !== value,
    open,
  );
  await page.waitForTimeout(150);
}

async function compareButtons(form) {
  const styles = await form.evaluate((el) =>
    [".workagent-composer-settings", "button[type=submit]"].map((s) => {
      const b = el.querySelector(s),
        c = getComputedStyle(b),
        r = b.getBoundingClientRect();
      return {
        width: r.width,
        height: r.height,
        background: c.backgroundColor,
        color: c.color,
        radius: c.borderRadius,
        shadow: c.boxShadow,
      };
    }),
  );
  assert.equal(styles[0].width, 36);
  assert.equal(styles[0].height, 36);
  assert.deepEqual(styles[0], styles[1]);
}
