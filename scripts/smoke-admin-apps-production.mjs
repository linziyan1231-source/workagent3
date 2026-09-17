import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

// Read-only production smoke for the admin-apps release: admin publishing
// console (dark-mode readability, published-app list with links and the
// unpublish button present but never clicked), market management readability,
// and the employee file manager multi-select toolbar (buttons shown, then
// selection cancelled without any mutation).

const baseURL = (process.env.WORKAGENT_SMOKE_URL || "http://127.0.0.1:18300").replace(/\/$/, "");
const out = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
assert.ok(out, "WORKAGENT_SMOKE_EVIDENCE_DIR is required");
await mkdir(out, { recursive: true });

const report = { baseURL, mode: "read-only", checks: [] };
const errors = [];
const browser = await chromium.launch();

async function openSession({ username, password, sessionToken, colorScheme }) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: colorScheme || "light",
  });
  if (sessionToken)
    await context.addCookies([{ name: "workagent-session", value: sessionToken, url: baseURL }]);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  if (!sessionToken) {
    const response = await page.request.post(`${baseURL}/api/auth/login`, {
      data: { username, password },
      headers: { Origin: new URL(baseURL).origin },
    });
    assert.ok(response.ok(), `${username} login returned ${response.status()}`);
  }
  return { context, page };
}

const adminIdentity = {
  username: process.env.WORKAGENT_SMOKE_ADMIN_USERNAME || "admin",
  password: process.env.WORKAGENT_SMOKE_ADMIN_PASSWORD,
  sessionToken: process.env.WORKAGENT_SMOKE_ADMIN_SESSION,
};
const employeeIdentity = {
  username: process.env.WORKAGENT_SMOKE_USERNAME || "test",
  password: process.env.WORKAGENT_SMOKE_PASSWORD,
  sessionToken: process.env.WORKAGENT_SMOKE_SESSION,
};

try {
  // 1. Admin publishing console in dark mode: cards readable, list + links +
  //    unpublish buttons present (never clicked).
  const admin = await openSession({ ...adminIdentity, colorScheme: "dark" });
  const adminPage = admin.page;
  await adminPage.goto(`${baseURL}/admin/accounts`);
  await adminPage.getByRole("button", { name: "应用发布", exact: true }).click();
  await adminPage.getByRole("heading", { name: "应用发布", exact: true }).waitFor();
  await adminPage.getByRole("heading", { name: "端口范围", exact: true }).waitFor();
  await adminPage.getByRole("heading", { name: "已发布网页", exact: true }).waitFor();
  const card = adminPage.locator(".admin-market-card").first();
  await card.waitFor();
  const darkBg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
  const darkFg = await card.evaluate((el) => getComputedStyle(el).color);
  assert.equal(darkBg, "rgb(32, 35, 41)", `admin card background not dark panel: ${darkBg}`);
  assert.equal(darkFg, "rgb(227, 230, 238)", `admin card text not dark-theme foreground: ${darkFg}`);
  report.checks.push("应用发布 page cards use dark --a-panel background and dark-theme text");

  const listed = await adminPage.request.get(`${baseURL}/api/portal/admin/published-apps`);
  assert.ok(listed.ok(), `admin published-apps list returned ${listed.status()}`);
  const apps = (await listed.json()).apps;
  assert.ok(Array.isArray(apps), "admin published-apps response has no apps array");
  if (apps.length) {
    const first = apps[0];
    assert.ok(first.name && first.username && (first.url || first.shareUrl), "admin list entry lacks name/username/link");
    const listSection = adminPage.getByRole("heading", { name: "已发布网页", exact: true }).locator("..");
    await listSection.locator("article").first().waitFor();
    const unpublishButtons = listSection.getByRole("button", { name: "下架", exact: true });
    assert.ok((await unpublishButtons.count()) >= 1, "下架 button missing from published list");
    const linkCount = await listSection.locator("article a[href]").count();
    assert.ok(linkCount >= 1, "published list has no links");
    report.checks.push(`已发布网页 lists ${apps.length} app(s) with links and 下架 buttons (not clicked)`);
  } else {
    report.checks.push("已发布网页 empty (no published apps)");
  }
  await adminPage.screenshot({ path: join(out, "admin-publishing-dark.png") });

  // 2. Market management cards readable in dark mode too.
  await adminPage.getByRole("button", { name: "市场能力", exact: true }).click();
  await adminPage.getByRole("heading", { name: "市场能力管理", exact: true }).waitFor();
  const marketCard = adminPage.locator(".admin-market-card").first();
  await marketCard.waitFor();
  const marketBg = await marketCard.evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(marketBg, "rgb(32, 35, 41)", `market card background not dark panel: ${marketBg}`);
  report.checks.push("市场能力管理 cards readable in dark mode");
  await adminPage.screenshot({ path: join(out, "admin-market-dark.png") });
  await admin.context.close();

  // 3. Employee file manager: checking two files shows 删除/下载 in the
  //    toolbar; selection is cancelled without any mutation.
  const employee = await openSession({ ...employeeIdentity, colorScheme: "light" });
  const page = employee.page;
  await page.goto(`${baseURL}/?frontend=dsh&workagent=workspaces`);
  const projectsDialog = page.getByRole("dialog", { name: "项目", exact: true });
  const projectCard = projectsDialog.locator("article").first();
  await projectCard.waitFor();
  await projectCard.getByRole("button", { name: "管理文件", exact: true }).click();
  await page.locator('.workagent-file-tree[aria-label="项目文件树"]').waitFor();
  const boxes = page.locator('input[type="checkbox"][aria-label^="选择 "]');
  await boxes.first().waitFor();
  assert.ok((await boxes.count()) >= 2, "project has fewer than two selectable entries");
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  const toolbar = page.locator(".workagent-move-selection");
  await toolbar.waitFor();
  assert.ok((await toolbar.innerText()).includes("已选择 2 项"), "toolbar did not report two selected entries");
  await toolbar.getByRole("button", { name: "删除", exact: true }).waitFor();
  await toolbar.getByRole("button", { name: "下载", exact: true }).waitFor();
  await page.screenshot({ path: join(out, "employee-files-multiselect.png") });
  await toolbar.getByRole("button", { name: "取消选择", exact: true }).click();
  await toolbar.waitFor({ state: "detached" });
  report.checks.push("multi-select toolbar shows 删除/下载 for two files; selection cancelled untouched");
  await employee.context.close();

  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  await writeFile(join(out, "report.json"), JSON.stringify({ status: "passed", ...report }, null, 2));
  console.log(JSON.stringify({ status: "passed", checks: report.checks }));
} catch (error) {
  await writeFile(
    join(out, "report.json"),
    JSON.stringify({ status: "failed", ...report, errors, failure: String(error) }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
