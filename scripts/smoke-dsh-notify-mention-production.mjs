import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { baseURL, login } from "./smoke-dsh-helpers.mjs";

// Read-only authenticated acceptance. Existing discussions are opened by ID;
// this never creates a project/discussion or sends a production message.
const out = resolve(process.env.WORKAGENT_COLLAB_EVIDENCE_DIR || ".cache/collab-unified/production");
const candidate = resolve(process.env.WORKAGENT_COLLAB_CLIENT_DIR || ".cache/collab-unified/client");
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
const report = { checks: [], errors: [] };
page.on("pageerror", (error) => report.errors.push(error.message));
try {
  await login(page);
  for (const name of ["client.js", "tokens.css"]) {
    const assetURL = await page.evaluate((name) => performance.getEntriesByType('resource').map((row) => row.name).find((url) => url.includes(`/plugins/@workagent/dsh-client/${name}`)), name);
    assert(assetURL, `loaded ${name} resource missing`);
    const response = await page.request.get(assetURL, { timeout: 60000 });
    assert(response.ok(), `published ${name} unavailable`);
    assert.equal(await response.text(), await readFile(resolve(candidate, name), "utf8"), `published ${name} differs from candidate`);
  }
  report.checks.push("published assets equal the immutable candidate");
  const get = async (path) => {
    const response = await page.request.get(baseURL + path);
    assert(response.ok(), path);
    return response.json();
  };
  const { projects } = await get("/api/portal/shared-projects?include_hidden=true");
  const { conversations } = await get("/api/portal/shared-conversations?include_hidden=true");
  const project = projects.find((row) => !row.hidden && conversations.some((c) => c.project_id === row.id && !c.hidden));
  assert(project, "existing visible collaboration discussion required");
  const discussion = conversations.find((row) => row.project_id === project.id && !row.hidden);
  await page.goto(`${baseURL}/?frontend=dsh&workagent=shared&project=${encodeURIComponent(project.id)}&discussion=${encodeURIComponent(discussion.id)}`);
  await page.locator('.workagent-collab-composer.workagent-compact-composer').waitFor();
  await page.getByRole("button", { name: "文件", exact: true }).waitFor();
  assert.equal(await page.locator('.workagent-collab-discussion-bar').count(), 0);
  await page.screenshot({ path: resolve(out, "desktop.png") });
  report.checks.push("existing collaboration uses the shared composer and compact header");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  if (!(await page.locator('.hHd-Xa_root').getAttribute('class')).includes('hHd-Xa_collapsed')) await page.locator('.hHd-Xa_toggle').click();
  await page.waitForFunction(() => document.querySelector('.hHd-Xa_root').classList.contains('hHd-Xa_collapsed'));
  const originalURL=page.url();
  await page.locator('.workagent-top-notifications').click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('workagent') === 'notifications');
  await page.locator('.workagent-top-notifications').click();
  await page.waitForFunction(url => location.href === url, originalURL);
  const composer=page.getByLabel('共享消息', {exact:true});
  await composer.fill('@codex');
  await page.getByRole('option').filter({hasText:/Codex/i}).first().waitFor();
  await page.screenshot({ path: resolve(out, 'mobile-codex-mention.png') });
  await composer.fill('');
  report.checks.push('mobile notification toggles back to original discussion; available Codex is searchable without sending a message');
  await page.screenshot({ path: resolve(out, "mobile-chat.png") });
  const input = await page.getByLabel('共享消息', { exact: true }).boundingBox();
  assert(input && input.x >= 0 && input.x + input.width <= 390 && input.y + input.height <= 844);
  await page.getByRole('button', { name: '打开侧边栏', exact: true }).click();
  const sidebar = page.getByRole('region', { name: '协作项目' });
  await sidebar.locator('.workagent-sidebar-project-row').first().waitFor();
  await sidebar.locator('.workagent-sidebar-session').first().waitFor();
  await page.screenshot({ path: resolve(out, "mobile-sidebar.png") });
  await sidebar.getByRole('button', { name: `项目操作 ${project.name}`, exact: true }).click();
  const menu = page.getByRole('dialog', { name: project.name, exact: true });
  await menu.getByRole('button', { name: /置顶/ }).waitFor();
  await menu.getByRole('button', { name: project.currentRole === 'owner' ? '邀请与成员' : '项目成员', exact: true }).waitFor();
  await page.screenshot({ path: resolve(out, "mobile-menu.png") });
  await page.keyboard.press('Escape');
  assert(!(await page.locator('.hHd-Xa_root').getAttribute('class')).includes('hHd-Xa_collapsed'), 'closing the menu must keep the drawer open');
  await sidebar.getByRole('button', { name: discussion.name, exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.hHd-Xa_root').classList.contains('hHd-Xa_collapsed'));
  report.checks.push('mobile project tree, pin/menu entries and discussion navigation');
  assert.equal((await get('/healthz')).status, 'healthy');
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error.message.split('Call log:')[0].trim();
  await page.screenshot({ path: resolve(out, 'failure.png') });
  process.exitCode = 1;
} finally {
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
