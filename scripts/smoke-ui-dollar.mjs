import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { login } from "./smoke-dsh-helpers.mjs";
const out = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
await mkdir(out, { recursive: true });
const browser = await (
  process.env.WORKAGENT_SMOKE_WEBKIT ? webkit : chromium
).launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  localStorage.setItem("workagent.files.open", "false");
  localStorage.setItem(
    "workagent.appearance.v1",
    JSON.stringify({ mode: "jade", daylight: "jade" }),
  );
});
const report = [];
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
if (process.env.WORKAGENT_PREVIEW) {
  for (const [pattern, file, type] of [
    [
      "**/plugins/@workagent/dsh-client/client.js*",
      "packages/dsh-client-workagent/client.js",
      "text/javascript",
    ],
    [
      "**/plugins/@workagent/dsh-client/tokens.css*",
      "packages/dsh-client-workagent/tokens.css",
      "text/css",
    ],
    [
      "**/plugins/@workagent/dsh-appearance/tokens.css*",
      "packages/dsh-client-appearance/tokens.css",
      "text/css",
    ],
  ]) {
    const body = await readFile(file, "utf8");
    await page.route(pattern, (r) => r.fulfill({ body, contentType: type }));
  }
}
try {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  for (const size of ["13", "18"]) {
    await page.evaluate((size) => {
      localStorage.setItem("workagent.font-size", size);
      document.documentElement.style.setProperty(
        "--workagent-font-scale",
        String(Number(size) / 14),
      );
    }, size);
    if (
      !(await page
        .getByRole("button", { name: "设置", exact: true })
        .isVisible())
    )
      await page
        .getByRole("button", { name: "打开侧边栏", exact: true })
        .click();
    await page.waitForTimeout(500);
    const data = await page.locator(".hHd-Xa_root").evaluate((el) => {
      const box = (s) => el.querySelector(s).getBoundingClientRect();
      const region = box(".hHd-Xa_regionArea"),
        settings = box(".hHd-Xa_settingsArea");
      const nav = box('[data-kind="teams"]');
      return {
        height: region.height,
        regionChildren: [
          ...el.querySelector(".hHd-Xa_regionArea").querySelectorAll("*"),
        ]
          .slice(0, 8)
          .map((n) => ({
            cls: n.className,
            pad: getComputedStyle(n).padding,
            margin: getComputedStyle(n).margin,
            rect: n.getBoundingClientRect().toJSON(),
          })),
        footerGap: settings.top - region.bottom,
        topGap: region.top - nav.bottom,
        font: getComputedStyle(el.querySelector('[data-kind="teams"]'))
          .fontSize,
        overflow: el.scrollWidth > el.clientWidth + 1,
      };
    });
    report.push({ size, ...data });
    assert(data.height > 100, JSON.stringify(data));
    assert(!data.overflow);
    assert(data.footerGap < 14, JSON.stringify(data));
    assert(data.topGap < 18, JSON.stringify(data));
    await page.screenshot({ path: `${out}/sidebar-${size}.png` });
  }
  if (!process.env.WORKAGENT_PREVIEW) {
    const auth = await page.request.post(
      `${process.env.WORKAGENT_SMOKE_URL}/api/auth/login`,
      {
        data: {
          username: "admin",
          password: process.env.WORKAGENT_SMOKE_ADMIN_PASSWORD,
        },
        headers: { Origin: process.env.WORKAGENT_SMOKE_URL },
      },
    );
    assert(auth.ok());
    await page.goto(`${process.env.WORKAGENT_SMOKE_URL}/admin/accounts`);
    await page
      .getByRole("heading", { name: "账户与额度", exact: true })
      .waitFor();
    await page.getByText("每周：已用", { exact: false }).first().waitFor();
    const select = page.locator(".admin-usage-filters select");
    await select.selectOption("test");
    await page.getByLabel("开始时间", { exact: true }).fill("2026-09-08T00:00");
    await page.getByLabel("结束时间", { exact: true }).fill("2026-09-11T00:00");
    const userResponse = page.waitForResponse((r) =>
      r.url().includes("/api/portal/admin/usage?"),
    );
    await page.getByRole("button", { name: "查询", exact: true }).click();
    const userRows = (await (await userResponse).json()).rows;
    assert(userRows.length > 0);
    assert.equal(new Set(userRows.map((r) => r.sid)).size, 1);
    await select.selectOption("");
    const allResponse = page.waitForResponse((r) =>
      r.url().includes("/api/portal/admin/usage?"),
    );
    await page.getByRole("button", { name: "查询", exact: true }).click();
    const allRows = (await (await allResponse).json()).rows;
    assert(
      allRows.reduce((sum, r) => sum + r.usd, 0) >=
        userRows.reduce((sum, r) => sum + r.usd, 0),
    );
    const selectSizes = [];
    for (const size of ["13", "18"]) {
      await page.evaluate(
        (size) =>
          document.documentElement.style.setProperty(
            "--workagent-font-scale",
            String(Number(size) / 14),
          ),
        size,
      );
      selectSizes.push(
        await select.evaluate((el) => getComputedStyle(el).fontSize),
      );
    }
    assert(
      Math.abs(
        parseFloat(selectSizes[1]) / parseFloat(selectSizes[0]) - 18 / 13,
      ) < 0.01,
      JSON.stringify(selectSizes),
    );
    report.push({
      userIntervalRows: userRows.length,
      allIntervalRows: allRows.length,
      selectSizes,
    });
    const values = await page
      .locator(".admin-dollar-budgets")
      .first()
      .innerText();
    assert(
      values.includes("$80.00") &&
        values.includes("$20.00") &&
        values.includes("DSH"),
      values,
    );
    for (const size of ["13", "18"]) {
      await page.evaluate(
        (size) =>
          document.documentElement.style.setProperty(
            "--workagent-font-scale",
            String(Number(size) / 14),
          ),
        size,
      );
      await page.screenshot({ path: `${out}/admin-${size}.png` });
    }
    await page.getByRole("button", { name: "操作记录", exact: true }).click();
    await page.locator("tbody td").first().waitFor();
    const sizes = [];
    for (const size of ["13", "18"]) {
      await page.evaluate(
        (size) =>
          document.documentElement.style.setProperty(
            "--workagent-font-scale",
            String(Number(size) / 14),
          ),
        size,
      );
      sizes.push(
        await page
          .locator("tbody td")
          .first()
          .evaluate((el) => getComputedStyle(el).fontSize),
      );
    }
    assert(
      Math.abs(parseFloat(sizes[1]) / parseFloat(sizes[0]) - 18 / 13) < 0.01,
      JSON.stringify(sizes),
    );
    await page.screenshot({ path: `${out}/audit-18.png` });
    const forbiddenContext = await browser.newContext();
    const loginResponse = await forbiddenContext.request.post(
      `${process.env.WORKAGENT_SMOKE_URL}/api/auth/login`,
      {
        data: {
          username: process.env.WORKAGENT_SMOKE_USERNAME,
          password: process.env.WORKAGENT_SMOKE_PASSWORD,
        },
        headers: { Origin: process.env.WORKAGENT_SMOKE_URL },
      },
    );
    assert(loginResponse.ok());
    const denied = await forbiddenContext.request.get(
      `${process.env.WORKAGENT_SMOKE_URL}/api/portal/admin/usage?from=2026-09-01T00:00:00Z&to=2026-09-11T00:00:00Z`,
    );
    assert.equal(denied.status(), 403);
    await forbiddenContext.close();
    report.push({
      adminDollarPools: true,
      auditFontSizes: sizes,
      employeeStatisticsDenied: true,
    });
  }
  await writeFile(`${out}/layout.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png` });
  console.log((await page.locator("body").innerText()).slice(0, 1200));
  throw error;
} finally {
  await browser.close();
}
