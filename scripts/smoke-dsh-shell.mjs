import { baseURL, login, withPage } from "./smoke-dsh-helpers.mjs";

await withPage(async (page) => {
  const overlays = [
    ["助手", "assistants"],
    ["定时任务", "automations"],
    ["通知", "notifications"],
  ];
  for (const [label, target] of overlays) {
    await page.goto(`${baseURL}/?frontend=dsh`);
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("dialog", { name: label }).waitFor();
  }
  await page.goto(`${baseURL}/?frontend=dsh`);
  await page
    .locator(".workagent-sidebar-heading")
    .getByText("项目", { exact: true })
    .waitFor();
  await page.getByRole("checkbox", { name: "团队模式" }).waitFor();
  if (await page.getByRole("button", { name: "团队", exact: true }).count())
    throw new Error("team management must not be a standalone sidebar page");
  await page.goto(`${baseURL}/?frontend=dsh`);
  const before = await page
    .locator("body")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  const wasDark =
    (await page.locator("body").getAttribute("data-workagent-theme")) ===
    "graphite";
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .getByRole("dialog", { name: "设置", exact: true })
    .getByRole("button", {
      name: wasDark ? "云瓷白" : "石墨黑",
      exact: true,
    })
    .click();
  await page.waitForFunction(
    (color) => getComputedStyle(document.body).backgroundColor !== color,
    before,
  );
  await page.reload();
  if (
    (await page
      .locator("body")
      .evaluate((node) => getComputedStyle(node).backgroundColor)) === before
  )
    throw new Error("theme was not persisted by the dsh theme service");

  await page.getByRole("button", { name: "聊天模式" }).click();
  await page.getByRole("checkbox", { name: "团队模式" }).waitFor();
  if (
    (await page.evaluate(() =>
      localStorage.getItem("workagent.hero.agent"),
    )) !== "builtin-general"
  )
    throw new Error("chat mode did not select the general assistant");
  await page.goto(`${baseURL}/?frontend=dsh`);
  await page.getByRole("button", { name: "退出登录" }).click();
  const unauthorized = await page.request.get(`${baseURL}/api/session.search`);
  if (unauthorized.status() !== 401)
    throw new Error("logout did not clear the session");
  await login(page);
});

console.log("dsh sidebar smoke passed");
