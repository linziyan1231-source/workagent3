import { baseURL, withPage } from "./smoke-dsh-helpers.mjs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
await withPage(async (page) => {
  await page.getByRole("button", { name: "新建会话", exact: true }).waitFor();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  if (await dialog.getByLabel(/默认权限/).count())
    throw new Error("Duplicate permission settings");
  const select = dialog.getByLabel("字体大小", { exact: true });
  if ((await select.inputValue()) !== "13")
    throw new Error("Default text size is not compact");
  const before = await dialog
    .locator(".workagent-typography strong")
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  await select.selectOption("18");
  const after = await dialog
    .locator(".workagent-typography strong")
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  if (after / before < 1.3)
    throw new Error("Font setting did not scale the text");
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  if ((await select.inputValue()) !== "18")
    throw new Error("Font size was not persisted");
  await select.selectOption("13");
  const directory = process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await page.screenshot({
      path: join(directory, "typography-settings.png"),
      fullPage: true,
    });
  }
  await dialog.getByRole("button", { name: "模型", exact: true }).click();
  await dialog.getByLabel("Codex 默认权限", { exact: true }).waitFor();
  await page.goto(`${baseURL}/?frontend=dsh`);
  const styles = await page.locator("body").evaluate((el) => ({
    font: getComputedStyle(el).fontFamily,
    spacing: getComputedStyle(el).letterSpacing,
    language: document.documentElement.lang,
  }));
  if (!styles.language.startsWith("zh") || styles.spacing !== "normal")
    throw new Error(
      `Unexpected typography/language: ${JSON.stringify(styles)}`,
    );
  console.log("Typography smoke passed", JSON.stringify(styles));
});
