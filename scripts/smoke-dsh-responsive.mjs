import { baseURL, withPage } from "./smoke-dsh-helpers.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

await withPage(async (page) => {
  const evidence = process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  if (process.env.WORKAGENT_SMOKE_LOCAL_ASSETS === "1") {
    const cssURL = await page
      .locator("#workagent-dsw-tokens")
      .getAttribute("href");
    const scriptURL = cssURL.replace("tokens.css", "client.js");
    await page.route(
      (url) => url.pathname === new URL(scriptURL, baseURL).pathname,
      (route) =>
        route.fulfill({
          path: "packages/dsh-client-workagent/client.js",
          contentType: "application/javascript",
        }),
    );
    await page.route(
      (url) => url.pathname === new URL(cssURL, baseURL).pathname,
      (route) =>
        route.fulfill({
          path: "packages/dsh-client-workagent/tokens.css",
          contentType: "text/css",
        }),
    );
    await page.reload();
  }
  const screenshot = async (name) => {
    if (evidence)
      await page.screenshot({ path: join(evidence, name), fullPage: true });
  };
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const checkComposer = async (mobile) => {
    await page.waitForFunction(
      () => document.querySelector('select[aria-label="模型"]')?.value,
    );
    const metrics = await page.evaluate(() => {
      const form = document
        .querySelector(".workagent-hero-composer")
        .getBoundingClientRect();
      const heading = document
        .querySelector(".pXSMma_headlineText")
        .getBoundingClientRect();
      const root = document
        .querySelector(".wSkVaW_root")
        .getBoundingClientRect();
      const controls = [
        ...document.querySelectorAll(
          ".workagent-hero-composer select, .workagent-composer-send",
        ),
      ].map((el) => el.getBoundingClientRect().toJSON());
      return {
        form: form.toJSON(),
        heading: heading.toJSON(),
        root: root.toJSON(),
        controls,
        width: innerWidth,
      };
    });
    if (metrics.heading.y > 175)
      throw new Error("Excessive space above chat heading");
    if (
      mobile &&
      (metrics.root.x > 1 || metrics.root.width < metrics.width - 1)
    )
      throw new Error("Collapsed rail still consumes mobile chat width");
    for (const box of metrics.controls) {
      if (
        box.x < metrics.form.x ||
        box.right > metrics.form.right + 1 ||
        box.bottom > metrics.form.bottom + 1
      )
        throw new Error(
          `Composer control escapes card: ${JSON.stringify(metrics)}`,
        );
    }
    if (
      metrics.form.right > metrics.width ||
      metrics.form.width < (mobile ? metrics.width - 60 : 600)
    )
      throw new Error("Composer width is incorrect");
    return metrics;
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel("输入消息", { exact: true }).waitFor();
  if (
    await page.getByRole("button", { name: "打开侧边栏", exact: true }).count()
  )
    await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  await checkComposer(false);
  await screenshot("responsive-desktop-expanded.png");
  await page.getByRole("button", { name: "收起侧边栏", exact: true }).click();
  await page.locator(".hHd-Xa_collapsed").waitFor();
  await page.waitForTimeout(300);
  const newChat = await page.locator(".hHd-Xa_newSession").boundingBox();
  if (newChat.width < 36 || newChat.height < 36)
    throw new Error("Collapsed new-chat icon is squeezed");
  await checkComposer(false);
  await screenshot("responsive-desktop-collapsed.png");
  await page.goto(`${baseURL}/?frontend=dsh&workagent=workspaces`);
  let dialog = page.getByRole("dialog", { name: "项目", exact: true });
  await dialog.getByLabel("搜索项目", { exact: true }).waitFor();
  if (
    await page.getByRole("button", { name: "收起侧边栏", exact: true }).count()
  )
    await page.getByRole("button", { name: "收起侧边栏", exact: true }).click();
  await page.locator(".hHd-Xa_collapsed").waitFor();
  const left = (await dialog.boundingBox()).x;
  if (Math.abs(left - 56) > 1)
    throw new Error("Project page retains the expanded sidebar offset");
  const newButton = dialog.getByRole("button", {
    name: "新建项目",
    exact: true,
  });
  if (
    (await newButton.evaluate((el) =>
      parseFloat(getComputedStyle(el).fontSize),
    )) < 14.5
  )
    throw new Error("New project text remains too small");
  await newButton.click();
  await dialog.getByLabel("新项目名称", { exact: true }).fill("项目名称预览");
  await screenshot("responsive-project-create-desktop.png");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.goto(`${baseURL}/?frontend=dsh`);
  // Test the home controls with the file drawer closed; on mobile the drawer is modal.
  const closeFiles = page.getByRole("button", {
    name: "收起文件侧栏",
    exact: true,
  });
  if (await closeFiles.count()) await closeFiles.click();
  const results = [];
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator(".hHd-Xa_collapsed").waitFor();
    await page.waitForTimeout(300);
    const icon = await page
      .locator(".hHd-Xa_toggle .hHd-Xa_panelIcon")
      .boundingBox();
    if (!icon || icon.width < 16) throw new Error("Mobile menu icon is hidden");
    const notification = page.getByRole("button", { name: /^通知/ }).first();
    if (
      !(await notification.evaluate((el) => {
        const b = el.getBoundingClientRect();
        return el.contains(
          document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2),
        );
      }))
    )
      throw new Error("Mobile notification button is covered");
    results.push(await checkComposer(true));
    await screenshot(`responsive-mobile-${width}.png`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  const backdrop = page.getByRole("button", {
    name: "收起导航菜单",
    exact: true,
  });
  await backdrop.waitFor();
  await page.waitForTimeout(350);
  await screenshot("responsive-mobile-menu.png");
  await backdrop.click({ position: { x: 30, y: 200 } });
  await page.locator(".hHd-Xa_collapsed").waitFor();
  await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.locator(".hHd-Xa_collapsed").waitFor();
  await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  await page.getByRole("button", { name: "管理项目", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "项目", exact: true });
  await dialog.getByRole("button", { name: "新建项目", exact: true }).click();
  await dialog.getByLabel("新项目名称", { exact: true }).fill("手机新项目预览");
  if (await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1))
    throw new Error("Mobile project form overflows");
  await screenshot("responsive-project-create-mobile.png");
  if (errors.length) throw new Error(errors.join("; "));
  if (evidence)
    await writeFile(
      join(evidence, "responsive.json"),
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          collapsedButton: newChat,
          mobile: results,
          drawerDismiss: true,
          projectForm: true,
        },
        null,
        2,
      ),
    );
});
console.log(
  "Responsive smoke passed: expanded/collapsed desktop, 390/320 mobile, drawer dismissal and project creation form",
);
