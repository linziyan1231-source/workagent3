import assert from "node:assert/strict";
import { withPage } from "./smoke-dsh-helpers.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
await withPage(async (page) => {
  await page.evaluate(() =>
    localStorage.setItem("workagent.locale-default.v1", "1"),
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.reload();
    await page.waitForFunction(() =>
      document.documentElement.lang.startsWith("zh"),
    );
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "通用设置", exact: true }).waitFor();
    assert.equal(
      await dialog.getByText(/^(Language|English|语言)$/).count(),
      0,
    );
    assert.equal(
      await dialog.getByRole("button", { name: /^(Plugins|插件)$/ }).count(),
      0,
    );
    for (const name of ["市场", "MCP与技能", "网页发布", "助手"])
      await dialog.getByRole("button", { name, exact: true }).waitFor();
    for (const name of ["云瓷白", "冰川蓝", "石墨黑", "暖纸色", "松石绿"])
      await dialog.getByRole("button", { name, exact: true }).waitFor();
  }
  const dir = process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR;
  if (dir) {
    await mkdir(dir, { recursive: true });
    await page.screenshot({
      path: join(dir, "settings-chinese.png"),
      fullPage: true,
    });
    await writeFile(
      join(dir, "locale.json"),
      JSON.stringify(
        {
          checkedAt: new Date().toISOString(),
          default: "zh",
          persistsAfterReload: true,
          languageRowRemoved: true,
          pluginsRemoved: true,
          marketSeparate: true,
        },
        null,
        2,
      ),
    );
  }
});
console.log(
  "Locale smoke passed: actual Chinese, reload persistence, language/plugins removed and separate market",
);
