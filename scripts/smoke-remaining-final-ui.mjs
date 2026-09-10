import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseURL, json, withPage } from "./smoke-dsh-helpers.mjs";
const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
const native = JSON.parse(
  await readFile(join(evidence, "remaining-native-features.json"), "utf8"),
);
const shared = JSON.parse(
  await readFile(join(evidence, "remaining-capabilities.json"), "utf8"),
);
const report = { checks: [] };
await withPage(async (page) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let dialogs = 0;
  page.on("dialog", async (d) => {
    dialogs++;
    await d.dismiss();
  });
  await page.goto(`${baseURL}/?frontend=dsh&workagent=teams`);
  const team = await json(page, `/api/runtime/v1/teams/${native.team}`);
  const member = team.members.find((x) => x.role === "member");
  const card = page
    .locator(".workagent-card")
    .filter({ has: page.getByText(team.name, { exact: true }) });
  const article = card
    .locator("article")
    .filter({ has: page.getByText(member.name, { exact: true }) });
  const renamed = `验收成员-${Date.now()}`;
  await article.getByLabel("成员名称", { exact: true }).fill(renamed);
  const memberResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/members/${member.id}`) &&
      r.request().method() === "PATCH",
  );
  await article
    .getByRole("button", { name: "重命名成员", exact: true })
    .click();
  assert.ok((await memberResponse).ok());
  await card.getByText(renamed, { exact: true }).waitFor();
  for (const button of await card.getByRole("button").all()) {
    const bounds = await button.boundingBox();
    if (bounds)
      assert.ok(bounds.height <= 60, "team action stretched vertically");
  }
  await page.screenshot({
    path: join(evidence, "remaining-teams-final.png"),
    animations: "disabled",
  });
  report.checks.push("团队成员页面内重命名");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(evidence, "remaining-teams-mobile.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${baseURL}/?frontend=dsh&workagent=automations`);
  const checkbox = page.locator('input[name="enabled"]').first();
  await checkbox.waitFor();
  const box = await checkbox.boundingBox();
  assert.ok(box.width <= 22 && box.height <= 22, JSON.stringify(box));
  await checkbox.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(evidence, "remaining-automation-final.png"),
    animations: "disabled",
  });
  report.checks.push("自动任务复选框尺寸和布局");
  const admin = await page.context().browser().newContext();
  try {
    assert.ok(
      (
        await admin.request.post(`${baseURL}/api/auth/login`, {
          headers: { Origin: baseURL },
          data: {
            username: "admin",
            password: process.env.WORKAGENT_SMOKE_ADMIN_PASSWORD,
          },
        })
      ).ok(),
    );
    const ap = await admin.newPage();
    ap.on("pageerror", (e) => errors.push(e.message));
    await ap.goto(`${baseURL}/?frontend=dsh&workagent=shared`);
    await ap
      .getByLabel("选择共享项目", { exact: true })
      .selectOption(shared.shared);
    const projectName = `共享资料验收-${Date.now()}`;
    await ap.getByLabel("修改共享项目名称", { exact: true }).fill(projectName);
    const projectResponse = ap.waitForResponse(
      (r) =>
        r.url().endsWith(`/shared-projects/${shared.shared}`) &&
        r.request().method() === "PATCH",
    );
    await ap.getByRole("button", { name: "重命名项目", exact: true }).click();
    assert.ok((await projectResponse).ok());
    await ap.waitForTimeout(400);
    assert.equal(
      (
        await json(ap, "/api/portal/shared-projects?include_hidden=true")
      ).projects.find((x) => x.id === shared.shared).name,
      projectName,
    );
    await ap.screenshot({
      path: join(evidence, "remaining-shared-final.png"),
      animations: "disabled",
    });
    await ap.setViewportSize({ width: 390, height: 844 });
    await ap.screenshot({
      path: join(evidence, "remaining-shared-mobile.png"),
      animations: "disabled",
    });
    report.checks.push("共享项目页面内重命名及移动端");
  } finally {
    await admin.close();
  }
  assert.equal(dialogs, 0);
  assert.deepEqual(errors, []);
  report.complete = true;
});
await writeFile(
  join(evidence, "remaining-final-ui.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
