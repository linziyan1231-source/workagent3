import { baseURL, withPage } from "./smoke-dsh-helpers.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

await withPage(async (page) => {
  const keys = [
    "workagent.sidebar.projects-collapsed",
    "workagent.sidebar.sessions-collapsed",
  ];
  const before = await page.evaluate(
    (keys) => keys.map((key) => localStorage.getItem(key)),
    keys,
  );
  const evidence = process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const openSidebar = async () => {
    const button = page.getByRole("button", {
      name: "打开侧边栏",
      exact: true,
    });
    if (await button.count()) await button.click();
  };
  const checkNearby = async () => {
    const projects = await page
      .getByRole("button", { name: "展开项目", exact: true })
      .boundingBox();
    const conversations = await page
      .getByRole("button", { name: /^(收起|展开)对话$/ })
      .boundingBox();
    if (!projects || !conversations || conversations.y - projects.y > 85)
      throw new Error("Conversations remain far below collapsed projects");
    if (await page.locator(".workagent-sidebar-project").count())
      throw new Error("Collapsed projects are still rendered");
  };
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(
      (keys) => keys.forEach((key) => localStorage.removeItem(key)),
      keys,
    );
    await page.goto(`${baseURL}/?frontend=dsh`);
    await openSidebar();
    await page.locator(".workagent-sidebar-project").first().waitFor();
    await page.getByRole("button", { name: "收起项目", exact: true }).click();
    await checkNearby();
    await page.getByRole("button", { name: "收起对话", exact: true }).click();
    if (await page.locator(".workagent-sidebar-session").count())
      throw new Error(
        "Conversation rows remain after collapsing both sections",
      );
    await page.reload();
    await openSidebar();
    await page.getByRole("button", { name: "展开对话", exact: true }).waitFor();
    await checkNearby();
    // Native buttons also support keyboard toggling.
    await page.getByRole("button", { name: "展开对话", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "收起对话", exact: true }).waitFor();
    if (evidence)
      await page.screenshot({
        path: join(evidence, "sidebar-desktop-collapsed-projects.png"),
      });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await openSidebar();
    await checkNearby();
    if (evidence)
      await page.screenshot({
        path: join(evidence, "sidebar-mobile-collapsed-projects.png"),
      });
    await page.getByRole("button", { name: "展开项目", exact: true }).click();
    await page.locator(".workagent-sidebar-project").first().waitFor();
    if (evidence)
      await writeFile(
        join(evidence, "sidebar-collapse.json"),
        JSON.stringify(
          {
            checkedAt: new Date().toISOString(),
            independentSections: true,
            persistsAfterReload: true,
            desktop: true,
            mobile: true,
            keyboard: true,
          },
          null,
          2,
        ),
      );
  } finally {
    await page.evaluate(
      ({ keys, before }) =>
        keys.forEach((key, index) =>
          before[index] === null
            ? localStorage.removeItem(key)
            : localStorage.setItem(key, before[index]),
        ),
      { keys, before },
    );
  }
});
console.log(
  "Sidebar collapse smoke passed: independent sections, persistence, keyboard, desktop and mobile",
);
