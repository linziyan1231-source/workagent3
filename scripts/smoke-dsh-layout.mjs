import {
  baseURL,
  json,
  openSettingsSection,
  uniqueName,
  withPage,
} from "./smoke-dsh-helpers.mjs";
import { join } from "node:path";

await withPage(async (page) => {
  const name =
    uniqueName("dsh-layout-") + "这是用于检查省略效果的较长项目名称".repeat(4);
  const project = await json(page, "/api/runtime/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  const session = await json(page, "/api/runtime/v1/sessions", {
    method: "POST",
    body: JSON.stringify({
      engine: "harness",
      title: name,
      workspace: project.id,
    }),
  });
  const screenshot = async (name) => {
    if (process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR)
      await page.screenshot({
        path: join(process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR, name),
        fullPage: true,
      });
  };
  try {
    const [loaded] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes("/model-options") && response.ok(),
      ),
      page.goto(`${baseURL}/?frontend=dsh`),
    ]);
    const groups = await loaded.json();
    for (const engine of ["harness", "codex", "kimi"]) {
      const group = groups.find((row) => row.engine === engine);
      if (group?.state !== "ready" || !group.models.length)
        throw new Error(
          `${engine} model discovery failed: ${JSON.stringify(group)}`,
        );
    }
    const sidebar = page.locator(".hHd-Xa_root");
    const overflow = await sidebar
      .locator(
        ".workagent-sidebar-browser, .workagent-sidebar-projects, .workagent-sidebar-project",
      )
      .evaluateAll((nodes) =>
        nodes.some((node) => node.scrollWidth > node.clientWidth + 1),
      );
    if (overflow) throw new Error("Project list has horizontal overflow");
    const action = await sidebar
      .getByRole("button", { name: "助手", exact: true })
      .boundingBox();
    const projects = await sidebar
      .locator(".workagent-sidebar-heading")
      .boundingBox();
    const newChat = await sidebar.locator(".hHd-Xa_newSession").boundingBox();
    if (!(newChat.y < action.y && action.y < projects.y))
      throw new Error(
        "Sidebar actions are not directly below New conversation",
      );
    const settings = await sidebar
      .getByRole("button", { name: "设置", exact: true })
      .boundingBox();
    const logout = await sidebar
      .getByRole("button", { name: "退出登录", exact: true })
      .boundingBox();
    if (
      Math.abs(
        settings.y + settings.height / 2 - logout.y - logout.height / 2,
      ) > 2
    )
      throw new Error(
        `Settings/logout are misaligned: ${JSON.stringify({ settings, logout })}`,
      );
    await screenshot("ui-home.png");
    await page.getByRole("radio", { name: "Codex", exact: true }).click();
    const group = groups.find((row) => row.engine === "codex");
    await page.waitForFunction(
      (ids) =>
        ids.includes(
          document.querySelector('select[aria-label="模型"]')?.value,
        ),
      group.models.map((row) => row.id),
    );
    const selected = await page
      .getByRole("combobox", { name: "模型", exact: true })
      .inputValue();
    const defaultEffort = await page
      .getByRole("combobox", { name: "思考级别" })
      .inputValue();
    const efforts = await page
      .getByRole("combobox", { name: "思考级别" })
      .locator("option")
      .evaluateAll((nodes) => nodes.map((node) => node.value));
    if (
      JSON.stringify(efforts) !==
      JSON.stringify(
        group.models
          .find((row) => row.id === selected)
          .reasoning.map((option) => option.id),
      )
    )
      throw new Error(
        "Composer reasoning choices differ from live model capabilities",
      );
    if (await page.getByRole("button", { name: "刷新模型和思考强度" }).count())
      throw new Error("Manual model refresh button remains");
    const rememberedModel =
      group.models.find((model) => model.id !== selected) || group.models[0];
    const rememberedEffort =
      rememberedModel.reasoning.find(
        (effort) => effort.id !== rememberedModel.defaultReasoning,
      ) || rememberedModel.reasoning[0];
    await page
      .getByRole("combobox", { name: "模型", exact: true })
      .selectOption(rememberedModel.id);
    if (rememberedEffort)
      await page
        .getByRole("combobox", { name: "思考级别" })
        .selectOption(rememberedEffort.id);
    const checkRemembered = async () => {
      await page.waitForFunction(
        ({ model, effort }) =>
          document.querySelector('select[aria-label="模型"]')?.value ===
            model &&
          (!effort ||
            document.querySelector('select[aria-label="思考级别"]')?.value ===
              effort),
        { model: rememberedModel.id, effort: rememberedEffort?.id },
      );
    };
    await page.getByRole("radio", { name: "Kimi", exact: true }).click();
    await page.getByRole("radio", { name: "Codex", exact: true }).click();
    await checkRemembered();
    let fetchedAt = groups[0].fetchedAt;
    for (const reopen of [
      () => page.reload(),
      async () => {
        await page.goto("about:blank");
        await page.goto(`${baseURL}/?frontend=dsh`);
      },
    ]) {
      const [refreshed] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().includes("/model-options") && response.ok(),
        ),
        reopen(),
      ]);
      const nextFetchedAt = (await refreshed.json())[0].fetchedAt;
      if (nextFetchedAt === fetchedAt)
        throw new Error("Reopening did not re-query the engines");
      fetchedAt = nextFetchedAt;
      await page.waitForFunction(
        ({ model, effort }) =>
          document.querySelector('select[aria-label="模型"]')?.value ===
            model &&
          document.querySelector('select[aria-label="思考级别"]')?.value ===
            effort,
        { model: selected, effort: defaultEffort },
      );
    }
    await screenshot("ui-default-model.png");
    const modelSection = await openSettingsSection(page, "模型");
    await modelSection.locator(".workagent-model-row").first().waitFor();
    if (await modelSection.getByRole("button", { name: "刷新模型" }).count())
      throw new Error("Settings model refresh button remains");
    if ((await modelSection.innerText()).includes("未知状态"))
      throw new Error("Unknown placeholder state remains");
    await screenshot("ui-settings-models.png");
    await page
      .getByRole("dialog", { name: "设置", exact: true })
      .getByRole("button", { name: "消息渠道", exact: true })
      .click();
    await page.locator(".ima-account-page").waitFor();
    await screenshot("ui-settings-channels.png");
  } finally {
    await json(page, `/api/runtime/v1/sessions/${session.id}`, {
      method: "DELETE",
    });
    await json(page, `/api/runtime/v1/workspaces/${project.id}`, {
      method: "DELETE",
    });
  }
});
console.log("dsh layout and live model smoke passed");
