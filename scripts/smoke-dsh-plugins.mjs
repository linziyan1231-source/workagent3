import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withPage } from "./smoke-dsh-helpers.mjs";
await withPage(async (page) => {
  const evidence = process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await dialog.getByRole("button", { name: "插件", exact: true }).click();
  const responsePromise = page.waitForResponse(
    (r) =>
      r.url().includes("pluginInventory") && r.request().method() === "POST",
  );
  await dialog.getByRole("tab", { name: "插件列表", exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  const result = await response.json();
  assert.equal(result.result.ok, true);
  assert(result.result.value.entries.length > 0);
  await dialog.getByLabel("搜索插件", { exact: true }).fill("appearance");
  await dialog.getByText("appearance", { exact: true }).waitFor();
  assert.equal(
    await dialog.getByText("暂时无法读取插件。", { exact: true }).count(),
    0,
  );
  if (evidence) await page.screenshot({ path: join(evidence, "plugins.png") });
  await dialog.getByRole("button", { name: "通用设置", exact: true }).click();
  await dialog.getByRole("button", { name: "跟随系统", exact: true }).click();
  await dialog.locator(".wa-appearance-system").scrollIntoViewIfNeeded();
  const separation = await dialog
    .locator(".wa-appearance-night")
    .evaluate((el) => {
      const style = getComputedStyle(el);
      const night = el.getBoundingClientRect();
      const day = el.previousElementSibling.getBoundingClientRect();
      return {
        border: style.borderLeftWidth,
        gap: night.x - day.right,
        padding: parseFloat(style.paddingLeft),
      };
    });
  assert.equal(separation.border, "1px");
  assert(separation.gap + separation.padding >= 40);
  if (evidence)
    await page.screenshot({ path: join(evidence, "appearance-separated.png") });
  console.log(
    JSON.stringify({ plugins: result.result.value.entries.length, separation }),
  );
});
