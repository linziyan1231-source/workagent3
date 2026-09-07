import { baseURL, withPage } from "./smoke-dsh-helpers.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const palettes = [
  ["porcelain", "云瓷白"],
  ["glacier", "冰川蓝"],
  ["graphite", "石墨黑"],
  ["paper", "暖纸色"],
  ["jade", "松石绿"],
];
await withPage(async (page) => {
  const evidence = process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const previous = await page.evaluate(() =>
    localStorage.getItem("workagent.appearance.v1"),
  );
  const report = [];
  let initialChoice;
  const settings = async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    await dialog.getByRole("button", { name: "通用设置", exact: true }).click();
    await dialog.locator(".wa-appearance").waitFor();
    return dialog;
  };
  const waitTheme = (id) =>
    page.waitForFunction(
      (expected) => document.body.dataset.workagentTheme === expected,
      id,
    );
  const capture = async (name) => {
    if (evidence)
      await page.screenshot({
        path: join(evidence, name + ".png"),
        fullPage: true,
      });
  };
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    let dialog = await settings();
    initialChoice = await dialog
      .locator('.wa-appearance-choice[aria-pressed="true"]')
      .getAttribute("aria-label");
    if (await dialog.getByRole("button", { name: /^(浅色|深色)$/ }).count())
      throw new Error("Old appearance controls remain");
    for (const label of ["字体大小", "任务运行时的发送方式"])
      await dialog.getByText(label, { exact: true }).waitFor();
    if (await dialog.getByLabel(/默认权限/).count())
      throw new Error("General settings duplicates model permissions");
    for (const [id, label] of palettes) {
      await dialog.getByRole("button", { name: label, exact: true }).click();
      await waitTheme(id);
      await capture(`appearance-${id}-settings`);
      const palette = await page.evaluate(() => {
        const style = getComputedStyle(document.body);
        const panel = getComputedStyle(document.querySelector(".VOzbGW_panel"));
        return {
          id: document.body.dataset.workagentTheme,
          background: style.backgroundColor,
          text: style.color,
          panel: panel.backgroundColor,
        };
      });
      report.push(palette);
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await page.getByRole("radio", { name: "DSH", exact: true }).waitFor();
      for (const label of ["模型", "思考级别", "权限", "个人项目"])
        await page
          .getByRole("combobox", { name: label, exact: true })
          .waitFor();
      await page.getByRole("checkbox", { name: "团队模式" }).waitFor();
      await capture(`appearance-${id}-home`);
      await page.reload();
      await waitTheme(id);
      await page.emulateMedia({
        colorScheme: id === "graphite" ? "light" : "dark",
      });
      await waitTheme(id);
      dialog = await settings();
    }
    if (new Set(report.map((row) => row.background)).size !== 5)
      throw new Error("Themes do not have five distinct body palettes");
    await dialog.getByRole("button", { name: "跟随系统", exact: true }).click();
    const day = dialog.getByRole("combobox", { name: "白昼模式" });
    const ids = await day
      .locator("option")
      .evaluateAll((nodes) => nodes.map((node) => node.value));
    if (
      JSON.stringify(ids) !==
      JSON.stringify(["porcelain", "glacier", "paper", "jade"])
    )
      throw new Error("Wrong daylight choices");
    for (const id of ids) {
      await day.selectOption(id);
      await page.emulateMedia({ colorScheme: "light" });
      await waitTheme(id);
      await page.emulateMedia({ colorScheme: "dark" });
      await waitTheme("graphite");
    }
    await day.selectOption("jade");
    await page.reload();
    await waitTheme("graphite");
    await page.emulateMedia({ colorScheme: "light" });
    await waitTheme("jade");
    dialog = await settings();
    if (
      (await dialog
        .getByRole("combobox", { name: "白昼模式" })
        .inputValue()) !== "jade"
    )
      throw new Error("Daylight choice did not survive reload");
    await capture("appearance-system-daylight");
    await page.emulateMedia({ colorScheme: "dark" });
    await waitTheme("graphite");
    await page.setViewportSize({ width: 1328, height: 670 });
    await capture("appearance-system-night-compact");
    for (const section of [
      "插件",
      "MCP 服务",
      "技能",
      "助手",
      "模型",
      "消息渠道",
    ]) {
      await dialog.getByRole("button", { name: section, exact: true }).click();
      await dialog.locator(".VOzbGW_options").waitFor();
    }
    await dialog.getByRole("button", { name: "通用设置", exact: true }).click();
    await dialog.locator(".wa-appearance").waitFor();
    const overflow = await dialog.evaluate(
      (node) => node.scrollWidth > node.clientWidth + 1,
    );
    if (overflow) throw new Error("Settings has horizontal overflow");
    if (errors.length) throw new Error(errors.join("\n"));
    if (evidence)
      await writeFile(
        join(evidence, "appearance-checks.json"),
        JSON.stringify(
          {
            palettes: report,
            daylightChoices: ids,
            systemSwitch: true,
            persisted: true,
            consoleErrors: errors,
          },
          null,
          2,
        ),
      );
    console.log(
      "Appearance smoke passed: five palettes, native settings cell replacement, all daylight choices, automatic dark/light changes, reload persistence, compact settings and original controls.",
    );
  } finally {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`${baseURL}/?frontend=dsh`);
    const dialog = await settings();
    if (initialChoice)
      await dialog
        .getByRole("button", { name: initialChoice, exact: true })
        .click();
    await page.evaluate((value) => {
      if (value === null) localStorage.removeItem("workagent.appearance.v1");
      else localStorage.setItem("workagent.appearance.v1", value);
    }, previous);
    await page.reload();
  }
});
