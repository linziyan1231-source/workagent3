import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  baseURL,
  json,
  openSettingsSection,
  withPage,
} from "./smoke-dsh-helpers.mjs";

// Post-activation production smoke for the universal skill toggle release.
// Read-only by design: it never clicks 停用/启用 on real rows, never submits
// the assistant form, and never triggers market 禁用/恢复上架 actions.

const output = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
assert.ok(output, "WORKAGENT_SMOKE_EVIDENCE_DIR is required");
const adminUsername = process.env.WORKAGENT_SMOKE_ADMIN_USERNAME || "admin";
const adminPassword = process.env.WORKAGENT_SMOKE_ADMIN_PASSWORD;
assert.ok(adminPassword, "WORKAGENT_SMOKE_ADMIN_PASSWORD is required");
await mkdir(output, { recursive: true });

const report = { baseURL, checks: {} };

await withPage(async (page) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const skills = await json(page, "/api/runtime/v1/skills");
  assert.ok(skills.length > 0, "expected at least one installed skill");

  // 1. Every skill row — user, market and managed alike — exposes a toggle.
  const section = await openSettingsSection(page, "技能");
  await section.locator("article.workagent-card").first().waitFor();
  const rows = await section
    .locator("article.workagent-card")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        title: node.querySelector("strong")?.textContent?.trim() || "",
        detail: node.querySelector(".workagent-muted")?.textContent?.trim() || "",
        actions: [...node.querySelectorAll(".workagent-actions button")].map(
          (button) => button.textContent.trim(),
        ),
      })),
    );
  assert.equal(
    rows.length,
    skills.length,
    `settings lists ${rows.length} cards for ${skills.length} skills`,
  );
  const byName = new Map(rows.map((row) => [row.title, row]));
  for (const skill of skills) {
    const row = byName.get(skill.name);
    assert.ok(row, `settings row missing for skill ${skill.name}`);
    const expected = skill.enabled ? "停用" : "启用";
    assert.ok(
      row.actions.includes(expected),
      `skill ${skill.name} (source=${skill.source}, enabled=${skill.enabled}) lacks the ${expected} button; actions=${row.actions}`,
    );
  }
  const disabled = skills.filter((skill) => skill.enabled === false);
  assert.ok(disabled.length > 0, "expected at least one disabled skill");
  for (const skill of disabled) {
    assert.ok(
      byName.get(skill.name).detail.includes("已停用"),
      `disabled skill ${skill.name} should render 已停用, got: ${byName.get(skill.name).detail}`,
    );
  }
  await page.screenshot({
    animations: "disabled",
    path: join(output, "skills-settings-toggles.png"),
  });
  report.checks.settingsToggles = {
    skills: skills.length,
    disabled: disabled.map((skill) => skill.name),
    sources: [...new Set(skills.map((skill) => skill.source))],
  };

  // 2. Disabled skills stay selectable when creating an assistant.
  const target =
    disabled.find((skill) => skill.name.includes("weixin-file-send")) ||
    disabled[0];
  const settingsDialog = page.getByRole("dialog", { name: /settings|设置/i });
  await settingsDialog
    .getByRole("button", { name: "助手", exact: true })
    .click();
  const agents = page.locator('[data-workagent-section="助手"]');
  const picker = agents
    .locator("fieldset.workagent-capability-picker")
    .filter({ has: page.locator("legend", { hasText: "技能" }) });
  await picker.locator("summary").click();
  const option = picker
    .locator(".workagent-capability-options label")
    .filter({ hasText: target.name });
  assert.equal(await option.count(), 1, `picker option for ${target.name}`);
  assert.ok(
    (await option.first().innerText()).includes("（已停用）"),
    `picker option for ${target.name} should be marked 已停用`,
  );
  const checkbox = option.first().locator('input[type="checkbox"]');
  assert.ok(await checkbox.isEnabled(), "disabled skill checkbox is usable");
  await checkbox.check();
  const selected = await picker
    .locator('input[type="hidden"][name="skillIds"]')
    .inputValue();
  assert.ok(
    selected.split(",").includes(target.id),
    `disabled skill ${target.id} should be selectable`,
  );
  await picker.locator("summary").scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: "disabled",
    path: join(output, "assistant-create-disabled-skill.png"),
  });
  await checkbox.uncheck();
  report.checks.assistantPicker = {
    disabledSkill: target.name,
    selectable: true,
    submitted: false,
  };
});

// 3. Admin market management exposes 禁用/恢复上架 without executing them.
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseURL}/admin/accounts`);
  await page.locator("#username").fill(adminUsername);
  await page.locator("#password").fill(adminPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page
    .getByRole("heading", { name: "账户与额度", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "市场能力", exact: true }).click();
  await page
    .getByRole("heading", { name: "市场能力管理", exact: true })
    .waitFor();
  await page.locator("article.admin-market-card").first().waitFor();
  const entries = await page
    .locator("article.admin-market-card")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        name: node.querySelector("h2")?.textContent?.trim() || "",
        meta: node.querySelector("p")?.textContent?.trim() || "",
        actions: [
          ...node.querySelectorAll(".admin-market-buttons button"),
        ].map((button) => button.textContent.trim()),
      })),
    );
  assert.ok(entries.length > 0, "expected at least one market entry");
  for (const entry of entries) {
    const gate = entry.meta.includes("已禁用") ? "恢复上架" : "禁用";
    assert.ok(
      entry.actions.includes(gate),
      `market entry ${entry.name} lacks the ${gate} action; actions=${entry.actions}`,
    );
    assert.ok(
      entry.actions.includes("停用") && entry.actions.includes("删除"),
      `market entry ${entry.name} lacks plain 停用/删除 actions; actions=${entry.actions}`,
    );
  }
  assert.equal(
    await page.getByRole("button", { name: /应急停用|应急删除/ }).count(),
    0,
    "old emergency-prefixed labels should be gone",
  );
  const deleteButtons = page.locator(
    "article.admin-market-card .admin-market-buttons button.admin-danger",
  );
  assert.equal(
    await deleteButtons.count(),
    entries.length,
    "every entry delete button should carry the red admin-danger styling",
  );
  for (let i = 0; i < (await deleteButtons.count()); i += 1)
    assert.equal((await deleteButtons.nth(i).innerText()).trim(), "删除");
  // Open and cancel the delete confirmation on the first entry: proves the
  // wiring without submitting anything.
  await deleteButtons.first().click();
  const confirm = page.getByRole("region", { name: "确认安全处置" });
  await confirm.waitFor();
  assert.ok(
    (await confirm.locator("h2").innerText()).startsWith("删除："),
    "delete confirmation heading should use the plain label",
  );
  await confirm
    .getByRole("button", { name: "取消", exact: true })
    .click();
  assert.equal(
    await page.locator(".admin-market-confirm").count(),
    0,
    "no destructive confirmation should remain open",
  );
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: join(output, "admin-market-disable.png"),
  });
  report.checks.adminMarket = {
    entries: entries.length,
    disabledEntries: entries.filter((entry) => entry.meta.includes("已禁用"))
      .length,
    actionsReadOnly: true,
  };
} finally {
  await browser.close();
}

await writeFile(
  join(output, "skill-toggle-smoke.json"),
  JSON.stringify(report, null, 2),
);
console.log("Skill toggle production browser smoke passed");
