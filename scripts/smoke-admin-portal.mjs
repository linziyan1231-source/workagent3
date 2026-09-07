import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
const base = process.env.WORKAGENT_SMOKE_URL?.replace(/\/$/, "");
const password = process.env.WORKAGENT_SMOKE_ADMIN_PASSWORD;
const employee = process.env.WORKAGENT_SMOKE_USERNAME;
const evidence = process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR;
if (!base || !password || !employee)
  throw Error("Smoke URL, employee username and admin password are required");
if (evidence) await mkdir(evidence, { recursive: true });
const browser = await chromium.launch();
const report = [];
let smokePage;
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  const page = await context.newPage();
  smokePage = page;
  const errors = [];
  page.on("response", async (response) => {
    if (response.url().endsWith("/api/auth/login") && response.status() >= 400)
      console.error(
        "Admin login failed",
        response.status(),
        await response.text(),
      );
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/admin/accounts");
  await page
    .locator("#username")
    .fill(process.env.WORKAGENT_SMOKE_ADMIN_USERNAME || "admin");
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page
    .getByRole("heading", { name: "账户与额度", exact: true })
    .waitFor();
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText(employee, { exact: true }) });
  await row.getByRole("button", { name: "管理", exact: false }).waitFor();
  if (evidence)
    await page.screenshot({ path: join(evidence, "admin-accounts-light.png") });
  await page
    .getByRole("searchbox", { name: "搜索账户" })
    .fill("no-matching-account");
  await page.getByText("没有匹配的账户").waitFor();
  await page.getByRole("searchbox", { name: "搜索账户" }).fill("");
  await page.getByRole("button", { name: "创建账户", exact: false }).click();
  const create = page.getByRole("dialog", { name: "创建账户" });
  await create.getByLabel("账户名").fill("validation-preview");
  assert.equal(
    await create.locator("form").evaluate((form) => form.checkValidity()),
    false,
  );
  await create.getByRole("button", { name: "关闭", exact: true }).click();
  await row.getByRole("button", { name: "管理", exact: false }).click();
  const dialog = page.getByRole("dialog", { name: employee, exact: true });
  await dialog.locator(".admin-quota").first().waitFor();
  const path = "/api/portal/admin/quotas";
  const getBudgets = async () => {
    const r = await page.request.get(
      base + path + "?username=" + encodeURIComponent(employee),
    );
    assert(r.ok());
    return (await r.json()).budgets;
  };
  const before = await getBudgets();
  assert(before.length > 0);
  const original =
    before.find((b) => b.modelId === "codex-native") || before[0];
  const card = dialog.locator(".admin-quota").filter({
    has: page.getByRole("heading", {
      name:
        original.modelId === "codex-native"
          ? "Codex 原生模型"
          : original.modelId,
      exact: true,
    }),
  });
  const adjust = async (mode, limit) => {
    const r = await page.request.post(base + path, {
      data: {
        username: employee,
        modelId: original.modelId,
        mode,
        limitUnits: limit,
      },
      headers: { Origin: base },
    });
    assert.equal(r.status(), 200);
  };
  try {
    await card.getByRole("button", { name: "调整额度", exact: true }).click();
    await card.getByRole("button", { name: "仅本周期", exact: true }).click();
    await card
      .getByRole("spinbutton", { name: "额度总量", exact: true })
      .fill(String(original.limitUnits + 1));
    if (evidence)
      await page.screenshot({
        path: join(evidence, "admin-temporary-quota.png"),
      });
    await card.getByRole("button", { name: "保存更改", exact: true }).click();
    await card.getByText("本周期临时额度", { exact: true }).waitFor();
    let actual = (await getBudgets()).find(
      (b) => b.modelId === original.modelId,
    );
    assert.equal(actual.limitUnits, original.limitUnits + 1);
    assert.equal(actual.baseLimitUnits, original.baseLimitUnits);
    assert(actual.temporary);
    await card.getByRole("button", { name: "调整额度", exact: true }).click();
    await card.getByRole("button", { name: "永久修改", exact: true }).click();
    await card
      .getByRole("spinbutton", { name: "额度总量", exact: true })
      .fill(String(original.baseLimitUnits + 2));
    await card.getByRole("button", { name: "保存更改", exact: true }).click();
    await card.locator(".admin-form").waitFor({ state: "detached" });
    actual = (await getBudgets()).find((b) => b.modelId === original.modelId);
    assert.equal(actual.baseLimitUnits, original.baseLimitUnits + 2);
    assert.equal(actual.limitUnits, original.baseLimitUnits + 2);
    assert.equal(actual.temporary, false);
    await page.reload();
    await page
      .getByRole("row")
      .filter({ has: page.getByText(employee, { exact: true }) })
      .getByRole("button", { name: "管理", exact: false })
      .click();
    await dialog.locator(".admin-quota").first().waitFor();
    actual = (await getBudgets()).find((b) => b.modelId === original.modelId);
    assert.equal(actual.limitUnits, original.baseLimitUnits + 2);
    await adjust("temporary", 0);
    await card.locator('progress[max="1"]').waitFor();
    await adjust("permanent", original.baseLimitUnits + 2);
    await card
      .locator(`progress[max="${original.baseLimitUnits + 2}"]`)
      .waitFor();
    report.push(
      "Temporary and permanent quota edits persist; permanent edit clears override; open dialog refreshes external changes",
    );
  } finally {
    await adjust("permanent", original.baseLimitUnits);
    if (original.temporary) await adjust("temporary", original.limitUnits);
  }
  await dialog.getByRole("tab", { name: "账户与服务", exact: true }).click();
  for (const label of [
    "重置密码",
    "修复服务",
    "修改 Windows 用户名",
    "资源限制",
    "离职并保留数据",
  ])
    await dialog.getByRole("button", { name: label, exact: false }).waitFor();
  await dialog.getByRole("button", { name: "资源限制", exact: false }).click();
  assert.equal(
    await dialog.locator('input[name="memory"]').getAttribute("min"),
    "0.25",
  );
  assert.equal(
    await dialog.locator('input[name="cpu"]').getAttribute("min"),
    "1",
  );
  assert.equal(
    await dialog.locator('input[name="processes"]').getAttribute("min"),
    "3",
  );
  assert.equal(
    await dialog.locator("form").evaluate((form) => form.checkValidity()),
    false,
  );
  if (evidence)
    await page.screenshot({
      path: join(evidence, "admin-service-controls.png"),
    });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "操作记录", exact: false }).click();
  await page.getByRole("heading", { name: "操作记录", exact: true }).waitFor();
  await page.getByLabel("筛选操作").fill("quota.adjust");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await page
    .getByRole("cell", { name: "quota.adjust", exact: true })
    .first()
    .waitFor();
  const exported = await page.request.get(
    new URL(
      await page.getByRole("link", { name: "导出记录" }).getAttribute("href"),
      base,
    ).href,
  );
  assert.equal(exported.status(), 200);
  await page.getByRole("button", { name: "账户与额度", exact: false }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  if (evidence)
    await page.screenshot({ path: join(evidence, "admin-accounts-dark.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page
    .getByRole("link", { name: "返回工作空间", exact: false })
    .waitFor();
  await page.getByRole("button", { name: "退出登录", exact: true }).waitFor();
  if (evidence)
    await page.screenshot({
      path: join(evidence, "admin-mobile.png"),
      fullPage: true,
    });
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.locator("#username").waitFor();
  const employeeContext = await browser.newContext();
  const employeePage = await employeeContext.newPage();
  const login = await employeePage.request.post(base + "/api/auth/login", {
    data: {
      username: employee,
      password: process.env.WORKAGENT_SMOKE_PASSWORD,
    },
    headers: { Origin: base },
  });
  assert.equal(login.status(), 200);
  for (const method of ["get", "post"]) {
    const result = await employeePage.request[method](
      base + path + "?username=" + encodeURIComponent(employee),
      method === "post"
        ? {
            data: {
              username: employee,
              modelId: original.modelId,
              mode: "permanent",
              limitUnits: 1,
            },
            headers: { Origin: base },
          }
        : {},
    );
    assert.equal(result.status(), 403);
  }
  await employeePage.goto(base + "/?frontend=dsh");
  await employeePage
    .getByRole("button", { name: "设置", exact: true })
    .waitFor();
  report.push(
    "Account search, validation, service controls, audit/export, logout, mobile and employee authorization passed",
  );
  assert.deepEqual(errors, []);
  if (evidence)
    await writeFile(
      join(evidence, "admin-report.json"),
      JSON.stringify({ report, consoleErrors: errors }, null, 2),
    );
  console.log(JSON.stringify(report));
} catch (error) {
  if (evidence && smokePage) {
    await smokePage.screenshot({
      path: join(evidence, "admin-smoke-failure.png"),
    });
    await writeFile(
      join(evidence, "admin-smoke-failure.txt"),
      smokePage.url() + "\n" + (await smokePage.locator("body").innerText()),
    );
  }
  throw error;
} finally {
  await browser.close();
}
