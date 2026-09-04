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
    let section = await openSettingsSection(page, "Presets");
    await section.getByLabel("Name").fill(presetName);
    await section.getByRole("button", { name: "Create preset" }).click();
    await section.getByText(presetName, { exact: true }).waitFor();
    preset = (await json(page, "/api/runtime/v1/presets")).find(
      (row) => row.name === presetName,
    );
    if (!preset) throw new Error("preset was not persisted");

    const card = section.locator("article", { hasText: presetName });
    await card.getByRole("button", { name: "Edit" }).click();
    await section.getByLabel("Name").fill(`${presetName}-edited`);
    await section.getByRole("button", { name: "Save preset" }).click();
    await section.getByText(`${presetName}-edited`, { exact: true }).waitFor();
    await section
      .locator("article", { hasText: `${presetName}-edited` })
      .getByRole("button", { name: "Delete" })
      .click();
    await section.getByText(`${presetName}-edited`, { exact: true }).waitFor({
      state: "detached",
    });
    preset = undefined;

    await page.reload();
    section = await openSettingsSection(page, "MCP servers");
    const mcpName = uniqueName("dsh-mcp");
    await section.getByLabel("Name").fill(mcpName);
    await section.getByLabel("Endpoint").fill("https://example.invalid/mcp");
    await section.getByRole("button", { name: "Add server" }).click();
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
    section = await openSettingsSection(page, "MCP servers");
    const needsAuth = (await json(page, "/api/runtime/v1/mcp-servers")).find(
      (row) => row.oauthState === "needs_auth",
    );
    if (!needsAuth) throw new Error("MCP OAuth logout did not require auth");
    await section
      .locator("article", { hasText: needsAuth.name })
      .getByRole("button", { name: "Authorize" })
      .waitFor();

    await page.reload();
    section = await openSettingsSection(page, "Extensions");
    for (const [tab, requiresRows] of [
      ["Message channels", false],
      ["Usage quota", true],
      ["Runtime components", true],
      ["Data migration", false],
    ]) {
      await section.getByRole("button", { name: tab, exact: true }).click();
      await section.getByRole("heading", { name: `Current: ${tab}` }).waitFor();
      const result = section.locator(
        '.workagent-card, [role="alert"], p.workagent-muted:text-is("No entries")',
      );
      await result.first().waitFor();
      if (requiresRows)
        await section.locator(".workagent-card").first().waitFor();
      const alert = section.getByRole("alert");
      if ((await alert.count()) > 0) {
        const message = await alert.textContent();
        if (tab !== "Message channels" || message !== "im_gateway_unavailable")
          throw new Error(`${tab} failed to load: ${message}`);
      }
    }
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
