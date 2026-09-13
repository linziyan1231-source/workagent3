import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseURL, json, withPage } from "./smoke-dsh-helpers.mjs";

// Post-activation production smoke for the agent-managed web publish release.
// Read-only by design: it never toggles real skills/apps, never deletes, and
// never submits a publish form.

const output = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
assert.ok(output, "WORKAGENT_SMOKE_EVIDENCE_DIR is required");
await mkdir(output, { recursive: true });

const report = { baseURL, checks: [] };

await withPage(async (page) => {
  await page.setViewportSize({ width: 1440, height: 1000 });

  // 1. Settings exposes one merged capabilities tab and the publish tab.
  const settings = page.getByRole("dialog", { name: /settings|设置/i });
  await page.getByRole("button", { name: /settings|设置/i }).click();
  await settings.getByRole("button", { name: "MCP与技能", exact: true }).waitFor();
  await settings.getByRole("button", { name: "网页发布", exact: true }).waitFor();
  for (const removed of ["MCP 服务", "技能"])
    assert.equal(
      await settings.getByRole("button", { name: removed, exact: true }).count(),
      0,
      `old settings tab remains: ${removed}`,
    );
  report.checks.push("settings tabs merged into MCP与技能 with 网页发布 added");

  // 2. The merged tab keeps both capability areas and lists web-publish.
  await settings
    .getByRole("button", { name: "MCP与技能", exact: true })
    .click();
  const section = page.locator('[data-workagent-section="MCP与技能"]');
  await section.getByText("MCP 服务", { exact: true }).waitFor();
  await section.getByText("技能", { exact: true }).waitFor();
  const skills = await json(page, "/api/runtime/v1/skills");
  const publishSkill = skills.find((row) => row.id === "web-publish");
  assert.ok(publishSkill, "managed skill web-publish is not installed");
  assert.ok(publishSkill.enabled, "managed skill web-publish is not enabled");
  const row = section.locator("article", { hasText: "web-publish" });
  await row.getByRole("button", { name: "停用", exact: true }).waitFor();
  await page.screenshot({ path: join(output, "mcp-skills-merged.png") });
  report.checks.push("MCP与技能 lists web-publish as an enabled managed skill");

  // 3. The publish tab lists pages (or the empty state) with safe actions.
  const apps = await json(page, "/api/portal/apps");
  await settings
    .getByRole("button", { name: "网页发布", exact: true })
    .click();
  const appsSection = page.locator('[data-workagent-section="网页发布"]');
  await appsSection.waitFor();
  if (apps.items.length) {
    const card = appsSection.locator("article").first();
    await card.waitFor();
    for (const action of ["复制链接", "删除"])
      await card.getByRole("button", { name: action, exact: true }).waitFor();
    await card
      .getByRole("button", { name: /^(停用|启用)$/, exact: true })
      .waitFor();
    report.checks.push(`网页发布 lists ${apps.items.length} page(s) with copy/toggle/delete actions`);
  } else {
    await appsSection.getByText("暂无数据", { exact: true }).waitFor();
    report.checks.push("网页发布 shows the empty state (no pages yet)");
  }
  await page.screenshot({ path: join(output, "web-publish-settings.png") });
  await page.keyboard.press("Escape");

  // 4. The file manager search is a dropdown combobox; the publish panel is gone.
  await page.goto(`${baseURL}/?frontend=dsh&workagent=workspaces`);
  const projectsDialog = page.getByRole("dialog", { name: "项目", exact: true });
  const projectCard = projectsDialog.locator("article").first();
  await projectCard.waitFor();
  await projectCard
    .getByRole("button", { name: "管理文件", exact: true })
    .click();
  await page
    .locator('.workagent-file-tree[aria-label="项目文件树"]')
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "应用预览与发布" }).count(),
    0,
    "legacy publish panel remains in the file manager",
  );
  const search = page.getByRole("combobox", { name: "搜索整个项目" });
  await search.waitFor();
  await search.fill("index");
  await page
    .getByRole("listbox", { name: "项目搜索结果" })
    .waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(output, "file-search-dropdown.png") });
  await search.press("Escape");
  await page.getByRole("listbox").waitFor({ state: "detached" });
  report.checks.push("file search renders a dismissible dropdown; legacy publish UI absent");
});

await writeFile(join(output, "web-publish-smoke.json"), JSON.stringify(report, null, 2));
console.log(`web-publish production smoke passed: ${report.checks.length} checks`);
