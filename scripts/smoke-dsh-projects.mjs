import { baseURL, json, uniqueName, withPage } from "./smoke-dsh-helpers.mjs";

await withPage(async (page) => {
  const name = uniqueName("dsh-smoke-project");
  let project;
  let session;
  try {
    await page.evaluate(() =>
      localStorage.setItem("workagent.hero.agent", "builtin-general"),
    );
    await page.reload();
    const personal = page.getByRole("combobox", { name: "个人项目" });
    await personal.selectOption("none");
    for (const label of ["模型", "思考级别", "权限"])
      await page.getByRole("combobox", { name: label }).waitFor();
    await page.waitForFunction(
      () => !document.querySelector('select[aria-label="模型"]')?.disabled,
    );
    await personal.selectOption("new");
    await page.getByLabel("新项目名称").fill(name);
    await page
      .getByLabel("输入消息", { exact: true })
      .fill("Reply with **Markdown verified** and nothing else.");
    await page.getByLabel("输入消息", { exact: true }).press("Enter");
    await page.waitForURL((url) => url.searchParams.has("session"));
    const id = new URL(page.url()).searchParams.get("session");
    session = await json(
      page,
      `/api/runtime/v1/sessions/${encodeURIComponent(id)}`,
    );
    project = (await json(page, "/api/runtime/v1/workspaces")).find(
      (row) => row.name === name,
    );
    if (
      !project ||
      session.workspaceId !== project.id ||
      project.scope === "team"
    )
      throw new Error(
        "Composer did not create and attach the personal project",
      );
    await page
      .locator(".workagent-message.is-user .workagent-markdown strong")
      .waitFor({ timeout: 90_000 });
    await page
      .locator(".workagent-message.is-assistant .workagent-markdown")
      .waitFor({ timeout: 90_000 });
    for (const [theme, label] of [
      ["light", "云瓷白"],
      ["dark", "石墨黑"],
    ]) {
      await page.goto(`${baseURL}/?frontend=dsh`);
      await page.getByRole("button", { name: /Settings|设置/ }).click();
      await page
        .getByRole("dialog", { name: /Settings|设置/ })
        .getByRole("button", { name: label, exact: true })
        .click();
      await page.goto(
        `${baseURL}/?frontend=dsh&session=${encodeURIComponent(id)}`,
      );
      await page
        .locator(".workagent-message.is-assistant .workagent-markdown")
        .waitFor();
      const contrasts = await page
        .locator(".workagent-message > .workagent-markdown")
        .evaluateAll((nodes) => {
          const luminance = (color) =>
            color
              .match(/[\d.]+/g)
              .slice(0, 3)
              .map(Number)
              .map((value) => {
                const channel = value / 255;
                return channel <= 0.04045
                  ? channel / 12.92
                  : ((channel + 0.055) / 1.055) ** 2.4;
              })
              .reduce(
                (total, value, index) =>
                  total + value * [0.2126, 0.7152, 0.0722][index],
                0,
              );
          return nodes.map((node) => {
            const style = getComputedStyle(node);
            const foreground = luminance(style.color);
            const background = luminance(style.backgroundColor);
            return (
              (Math.max(foreground, background) + 0.05) /
              (Math.min(foreground, background) + 0.05)
            );
          });
        });
      if (contrasts.some((contrast) => contrast < 4.5))
        throw new Error(`${theme} message contrast below 4.5: ${contrasts}`);
      if (process.env.WORKAGENT_SMOKE_SCREENSHOT)
        await page.screenshot({
          path: process.env.WORKAGENT_SMOKE_SCREENSHOT.replace(
            /\.png$/,
            `-${theme}.png`,
          ),
          fullPage: true,
        });
    }
    await page.goto(`${baseURL}/?frontend=dsh`);
    const projectRow = page.locator(".workagent-sidebar-project").filter({
      has: page.getByRole("button", {
        name: `编辑项目 ${name}`,
        exact: true,
      }),
    });
    const toggle = projectRow.locator(
      ".workagent-sidebar-project-row > button.is-main",
    );
    await toggle.click();
    if ((await toggle.getAttribute("aria-expanded")) !== "false")
      throw new Error("Project did not collapse");
    await toggle.click();
    await projectRow.getByRole("button", { name: /^编辑对话 / }).click();
    let dialog = page.getByRole("dialog", { name: "重命名", exact: true });
    await dialog.getByRole("textbox").fill(`${name}-session`);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await page
      .getByRole("button", { name: `编辑对话 ${name}-session`, exact: true })
      .waitFor();
    if (
      (await json(page, `/api/runtime/v1/sessions/${id}`)).title !==
      `${name}-session`
    )
      throw new Error("Session rename was not persisted");
    await page
      .getByRole("button", { name: `编辑对话 ${name}-session`, exact: true })
      .click();
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    await page
      .getByRole("dialog", { name: "确认删除", exact: true })
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await page
      .getByRole("button", { name: `编辑对话 ${name}-session`, exact: true })
      .waitFor({ state: "detached" });
    session = undefined;
    await page
      .getByRole("button", { name: `编辑项目 ${name}`, exact: true })
      .click();
    await dialog.getByRole("textbox").fill(`${name}-renamed`);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await page
      .getByRole("button", { name: `编辑项目 ${name}-renamed`, exact: true })
      .waitFor();
    if (
      !(await json(page, "/api/runtime/v1/workspaces")).some(
        (row) => row.id === project.id && row.name === `${name}-renamed`,
      )
    )
      throw new Error("Project rename was not persisted");
    await page
      .getByRole("button", { name: `编辑项目 ${name}-renamed`, exact: true })
      .click();
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    await page
      .getByRole("dialog", { name: "确认删除", exact: true })
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await page
      .getByRole("button", { name: `编辑项目 ${name}-renamed`, exact: true })
      .waitFor({ state: "detached" });
    project = undefined;
  } finally {
    if (session)
      await json(page, `/api/runtime/v1/sessions/${session.id}`, {
        method: "DELETE",
      });
    if (project)
      await json(page, `/api/runtime/v1/workspaces/${project.id}`, {
        method: "DELETE",
      });
  }
});
console.log("dsh project smoke passed");
