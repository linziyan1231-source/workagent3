import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { baseURL, login, openSettingsSection } from "./smoke-dsh-helpers.mjs";

const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
if (!evidence) throw new Error("Evidence directory required");
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const report = { checks: [], errors: [] };
page.on("pageerror", (error) => report.errors.push(error.message));
if (process.env.WORKAGENT_SMOKE_CLIENT) {
  const client = await readFile(process.env.WORKAGENT_SMOKE_CLIENT, "utf8");
  await page.route("**/plugins/@workagent/dsh-client/client.js*", (route) =>
    route.fulfill({ contentType: "text/javascript", body: client }),
  );
}
try {
  await login(page);
  const sidebar = page.locator(".hHd-Xa_root");
  await sidebar
    .getByRole("button", { name: "聊天模式", exact: true })
    .waitFor();
  assert.equal(
    await sidebar.getByRole("button", { name: "助手", exact: true }).count(),
    0,
  );
  await page.screenshot({ path: `${evidence}/sidebar-desktop.png` });
  await openSettingsSection(page, "助手");
  await page.getByRole("button", { name: "创建助手", exact: true }).waitFor();
  await page.screenshot({ path: `${evidence}/assistant-settings.png` });
  report.checks.push(
    "Chat mode in sidebar; assistant editor remains accessible in settings",
  );
  await page.goto(`${baseURL}/?frontend=dsh`);
  await openSettingsSection(page, "系统与帮助");
  const address = page.getByLabel("聊天网页地址", { exact: true });
  await address.fill("javascript:alert(1)");
  await page.getByRole("button", { name: "保存聊天地址", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "聊天网页地址" }).waitFor();
  const target = "https://chat.example.test/chatgpt/";
  await page.route(target, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<p>Standalone chat test</p>",
    }),
  );
  await address.fill(target);
  await page.getByRole("button", { name: "保存聊天地址", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "已保存" }).waitFor();
  await page.reload();
  await openSettingsSection(page, "系统与帮助");
  assert.equal(await address.inputValue(), target);
  await page.screenshot({ path: `${evidence}/chat-address-settings.png` });
  await page.goto(`${baseURL}/?frontend=dsh`);
  await sidebar.getByRole("button", { name: "聊天模式", exact: true }).click();
  await page.waitForURL(target);
  report.checks.push(
    "Configured standalone URL persists after reload and is used by chat entry; invalid schemes rejected",
  );
  await page.goto(`${baseURL}/?frontend=dsh`);
  await openSettingsSection(page, "系统与帮助");
  await address.fill("");
  await page.getByRole("button", { name: "保存聊天地址", exact: true }).click();
  await page.goto(`${baseURL}/?frontend=dsh`);
  await page.setViewportSize({ width: 390, height: 740 });
  await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  await openSettingsSection(page, "系统与帮助");
  await address.waitFor();
  await page.waitForTimeout(350);
  const addressBounds = await address.boundingBox();
  assert(
    addressBounds.width > 100 &&
      addressBounds.x >= 0 &&
      addressBounds.x + addressBounds.width <= 390,
  );
  await page.screenshot({ path: `${evidence}/chat-address-mobile.png` });
  await page.goto(`${baseURL}/?frontend=dsh`);
  await page.setViewportSize({ width: 390, height: 740 });
  await page.getByRole("button", { name: "打开侧边栏", exact: true }).click();
  await sidebar
    .getByRole("button", { name: "聊天模式", exact: true })
    .waitFor();
  await page.screenshot({ path: `${evidence}/sidebar-mobile.png` });
  const responsePromise = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/chatgpt/",
  );
  await sidebar.getByRole("button", { name: "聊天模式", exact: true }).click();
  const response = await responsePromise;
  await page.waitForURL("**/chatgpt/");
  report.checks.push("Mobile chat entry navigates to standalone /chatgpt/");
  report.chatService = { status: response.status(), available: response.ok() };
  if (!response.ok()) report.chatService.error = (await response.json()).error;
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report));
} finally {
  await writeFile(
    `${evidence}/chat-entry-report.json`,
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
