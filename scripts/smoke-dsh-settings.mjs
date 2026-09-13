import {
  json,
  openSettingsSection,
  uniqueName,
  withPage,
} from "./smoke-dsh-helpers.mjs";

await withPage(async (page) => {
  const presetName = uniqueName("dsh-preset");
  let preset;
  let mcp;
  try {
    let section = await openSettingsSection(page, "助手");
    await section.getByLabel("名称").fill(presetName);
    await section.getByRole("button", { name: "创建助手" }).click();
    await section.getByText(presetName, { exact: true }).waitFor();
    preset = (await json(page, "/api/runtime/v1/presets")).find(
      (row) => row.name === presetName,
    );
    if (!preset) throw new Error("preset was not persisted");

    const card = section.locator("article", { hasText: presetName });
    await card.getByRole("button", { name: "编辑" }).click();
    await section.getByLabel("名称").fill(`${presetName}-edited`);
    await section.getByRole("button", { name: "保存助手" }).click();
    await section.getByText(`${presetName}-edited`, { exact: true }).waitFor();
    page.once("dialog", (dialog) => dialog.accept());
    await section
      .locator("article", { hasText: `${presetName}-edited` })
      .getByRole("button", { name: "删除" })
      .click();
    await section.getByText(`${presetName}-edited`, { exact: true }).waitFor({
      state: "detached",
    });
    preset = undefined;

    await page.reload();
    section = await openSettingsSection(page, "MCP与技能");
    const mcpName = uniqueName("dsh-mcp");
    await section.getByLabel("名称").fill(mcpName);
    await section.getByLabel("服务地址").fill("https://example.invalid/mcp");
    await section.getByRole("button", { name: "添加服务" }).click();
    await section.getByText(mcpName, { exact: true }).waitFor();
    mcp = (await json(page, "/api/runtime/v1/mcp-servers")).find(
      (row) => row.name === mcpName,
    );
    if (!mcp) throw new Error("MCP server was not persisted");
    await json(
      page,
      `/api/runtime/v1/mcp-servers/${encodeURIComponent(mcp.id)}/oauth`,
      { method: "DELETE" },
    );
    await page.reload();
    section = await openSettingsSection(page, "MCP与技能");
    const needsAuth = (await json(page, "/api/runtime/v1/mcp-servers")).find(
      (row) => row.oauthState === "needs_auth",
    );
    if (!needsAuth) throw new Error("MCP OAuth logout did not require auth");
    await section
      .locator("article", { hasText: needsAuth.name })
      .getByRole("button", { name: "授权" })
      .waitFor();

    await page.reload();
    section = await openSettingsSection(page, "消息渠道");
    for (const channel of ["微信", "企业微信", "飞书", "钉钉"])
      await section.getByText(channel, { exact: true }).waitFor();
    if ((await section.innerText()).includes("im_gateway_unavailable"))
      throw new Error("Channel page exposed raw gateway errors");
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    for (const removed of ["引擎", "扩展"])
      if (
        await settings
          .getByRole("button", { name: removed, exact: true })
          .count()
      )
        throw new Error(`Unused settings section remains: ${removed}`);
  } finally {
    if (preset)
      await json(
        page,
        `/api/runtime/v1/presets/${encodeURIComponent(preset.id)}`,
        {
          method: "DELETE",
        },
      ).catch(() => {});
    if (mcp)
      await json(
        page,
        `/api/runtime/v1/mcp-servers/${encodeURIComponent(mcp.id)}`,
        {
          method: "DELETE",
        },
      ).catch(() => {});
  }
});

console.log("dsh settings smoke passed");
