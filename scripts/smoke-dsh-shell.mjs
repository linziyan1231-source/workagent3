import { baseURL, login, withPage } from "./smoke-dsh-helpers.mjs";

await withPage(async (page) => {
  const overlays = [
    ["Assistants", "assistants"],
    ["Scheduled tasks", "automations"],
    ["Teams", "teams"],
    ["Notifications", "notifications"],
    ["Workspace", "workspaces"],
  ];
  for (const [label, target] of overlays) {
    await page.goto(`${baseURL}/?frontend=dsh`);
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("dialog", { name: target }).waitFor();
  }
  await page.goto(`${baseURL}/?frontend=dsh`);
  const before = await page
    .locator("body")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  await page.getByRole("button", { name: "Theme" }).click();
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

  await page.getByRole("button", { name: "ChatGPT" }).click();
  await page.waitForURL(/\/chatgpt\//);
  await page.goto(`${baseURL}/?frontend=dsh`);
  await page.getByRole("button", { name: "Log out" }).click();
  const unauthorized = await page.request.get(`${baseURL}/api/session.search`);
  if (unauthorized.status() !== 401)
    throw new Error("logout did not clear the session");
  await login(page);
});

console.log("dsh sidebar smoke passed");
