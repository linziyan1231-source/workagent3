import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseURL, withPage, json, uniqueName } from "./smoke-dsh-helpers.mjs";

const output = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
await mkdir(output, { recursive: true });
await withPage(async (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const presets = await json(page, "/api/runtime/v1/presets");
  const preset = presets.find((row) => row.enabled);
  assert.ok(preset, "requires an enabled assistant");
  const projects = await json(page, "/api/runtime/v1/workspaces");
  assert.ok(projects.length, "requires an existing project");
  const name = uniqueName("定时任务界面验收");
  let automation;
  const open = async () => {
    await page.goto(`${baseURL}/?frontend=dsh&workagent=automations`);
    const dialog = page.getByRole("dialog", { name: "定时任务", exact: true });
    await dialog
      .getByRole("option", { name: preset.name, exact: true })
      .waitFor({ state: "attached" });
    return dialog;
  };
  const theme = async (mode) => {
    await page.evaluate(
      (mode) =>
        localStorage.setItem(
          "workagent.appearance.v1",
          JSON.stringify({ mode, daylight: "porcelain" }),
        ),
      mode,
    );
    return open();
  };
  try {
    await page.setViewportSize({ width: 1440, height: 1100 });
    let dialog = await theme("graphite");
    await page.screenshot({
      path: join(output, "automations-dark.png"),
      fullPage: true,
    });
    dialog = await theme("porcelain");
    await page.screenshot({
      path: join(output, "automations-light.png"),
      fullPage: true,
    });
    dialog = await theme("graphite");
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog
      .getByRole("button", { name: "创建任务", exact: true })
      .scrollIntoViewIfNeeded();
    const overflow = await dialog.evaluate(
      (node) => node.scrollWidth > node.clientWidth + 1,
    );
    assert.equal(overflow, false, "mobile dialog overflows horizontally");
    await page.screenshot({
      path: join(output, "automations-mobile-form.png"),
      fullPage: true,
    });
    await dialog
      .getByText("让日常工作，自动进行", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(output, "automations-mobile-top.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await dialog.getByLabel("任务名称", { exact: true }).fill(name);
    await dialog.getByLabel("执行助手").selectOption(preset.id);
    await dialog.getByLabel("所属项目").selectOption(projects[0].id);
    await dialog
      .getByLabel("任务内容")
      .fill("整理项目进展\n列出待办事项与风险。");
    await dialog.getByLabel("执行间隔（分钟）").fill("525600");
    await dialog.getByRole("button", { name: "创建任务", exact: true }).click();
    await dialog.locator("article", { hasText: name }).waitFor();
    automation = (await json(page, "/api/runtime/v1/automations")).find(
      (row) => row.name === name,
    );
    assert.equal(automation.engine, preset.engine);
    assert.equal(automation.workspaceId, projects[0].id);
    assert.equal(automation.schedule.everyMinutes, 525600);
    assert.equal(
      await dialog.getByLabel("任务名称", { exact: true }).inputValue(),
      "",
    );
    dialog = await open();
    const card = dialog.locator("article", { hasText: name });
    await card.waitFor();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(output, "automations-created.png"),
      fullPage: true,
    });
    await card.getByRole("button", { name: "运行记录" }).click();
    await card.getByRole("button", { name: "删除", exact: true }).click();
    await card.waitFor({ state: "detached" });
    assert.equal(
      (await json(page, "/api/runtime/v1/automations")).some(
        (row) => row.id === automation.id,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    await writeFile(
      join(output, "automation-layout.json"),
      JSON.stringify(
        {
          passed: true,
          checks: [
            "dark/light desktop",
            "390px mobile",
            "assistant/project selection",
            "engine mapping",
            "multiline input",
            "create",
            "refresh persistence",
            "history",
            "delete",
          ],
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    const remaining = (await json(page, "/api/runtime/v1/automations")).find(
      (row) => row.name === name,
    );
    if (remaining)
      await json(
        page,
        `/api/runtime/v1/automations/${encodeURIComponent(remaining.id)}`,
        { method: "DELETE" },
      );
  }
});
console.log("automation layout smoke passed");
