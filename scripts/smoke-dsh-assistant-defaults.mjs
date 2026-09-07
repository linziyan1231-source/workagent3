import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  baseURL,
  json,
  openSettingsSection,
  uniqueName,
  withPage,
} from "./smoke-dsh-helpers.mjs";

const output = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
await mkdir(output, { recursive: true });
await withPage(async (page) => {
  const created = [];
  const sessions = [];
  const prefix = uniqueName("助手默认值验收");
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const screenshot = (name) =>
    page.screenshot({ path: join(output, name), fullPage: true });
  const settings = async () => {
    await page.goto(`${baseURL}/?frontend=dsh`);
    const section = await openSettingsSection(page, "模型");
    await section
      .locator('select[aria-label="Codex 默认模型"]:enabled')
      .waitFor();
    return section;
  };
  const choice = (modelId, thinkingEffort, permissionMode) =>
    page.waitForFunction(
      ({ modelId, thinkingEffort, permissionMode }) =>
        document.querySelector('select[aria-label="模型"]')?.value ===
          modelId &&
        document.querySelector('select[aria-label="思考级别"]')?.value ===
          thinkingEffort &&
        document.querySelector('select[aria-label="权限"]')?.value ===
          permissionMode,
      { modelId, thinkingEffort, permissionMode },
    );
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => {
      localStorage.setItem("workagent.files.open", "false");
      localStorage.setItem(
        "workagent.appearance.v1",
        JSON.stringify({ mode: "graphite", daylight: "porcelain" }),
      );
    });
    await page.goto(`${baseURL}/?frontend=dsh&workagent=assistants`);
    const dialog = page.getByRole("dialog", { name: "助手", exact: true });
    assert.equal(await dialog.getByLabel("模型", { exact: true }).count(), 0);
    for (const suffix of ["写作", "审阅"]) {
      const name = `${prefix}-${suffix}`;
      await dialog.getByLabel("名称", { exact: true }).fill(name);
      await dialog.getByLabel("引擎").selectOption("codex");
      await dialog
        .getByRole("button", { name: "创建助手", exact: true })
        .click();
      await dialog.getByText(name, { exact: true }).waitFor();
      const preset = (await json(page, "/api/runtime/v1/presets")).find(
        (row) => row.name === name,
      );
      assert.equal(preset.modelId, null);
      created.push(preset);
    }
    await screenshot("assistant-form.png");
    const [writer, reviewer] = created;
    const models = (await json(page, "/api/runtime/v1/model-options")).find(
      (group) => group.engine === "codex",
    ).models;
    const primary = models.find((row) => row.id === "gpt-6-astra") || models[0];
    const alternate = models.find((row) => row.id !== primary.id);
    assert.ok(alternate, "requires two available Codex models");
    const effort =
      primary.reasoning.find((row) => row.id === "low")?.id ||
      primary.reasoning[0]?.id ||
      "";
    const alternateEffort =
      alternate.reasoning.find((row) => row.id !== effort)?.id ||
      alternate.reasoning[0]?.id ||
      "";
    let section = await settings();
    const builtinDefaults = await section
      .getByLabel("Codex 默认模型", { exact: true })
      .inputValue();
    for (const [preset, model, thinking, permission] of [
      [writer, primary, effort, "read_only"],
      [reviewer, alternate, alternateEffort, "workspace_write"],
    ]) {
      await section
        .getByLabel(`${preset.name} 默认模型`, { exact: true })
        .selectOption(model.id);
      if (thinking)
        await section
          .getByLabel(`${preset.name} 默认思考强度`, { exact: true })
          .selectOption(thinking);
      await section
        .getByLabel(`${preset.name} 默认权限`, { exact: true })
        .selectOption(permission);
    }
    assert.equal(
      await section.getByLabel("Codex 默认模型", { exact: true }).inputValue(),
      builtinDefaults,
    );
    await screenshot("assistant-model-defaults.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await section
      .getByLabel(`${writer.name} 默认权限`, { exact: true })
      .scrollIntoViewIfNeeded();
    assert.equal(
      await section
        .locator(`[data-preset-id="${writer.id}"]`)
        .evaluate((node) => node.scrollWidth > node.clientWidth + 1),
      false,
    );
    await screenshot("assistant-model-defaults-mobile.png");
    await page.setViewportSize({ width: 1440, height: 1000 });
    section = await settings();
    assert.equal(
      await section
        .getByLabel(`${writer.name} 默认权限`, { exact: true })
        .inputValue(),
      "read_only",
    );
    assert.equal(
      await section
        .getByLabel(`${reviewer.name} 默认模型`, { exact: true })
        .inputValue(),
      alternate.id,
    );
    await page.goto(`${baseURL}/?frontend=dsh`);
    await page.getByRole("radio", { name: writer.name, exact: true }).click();
    await choice(primary.id, effort, "read_only");
    await page.getByLabel("模型", { exact: true }).selectOption(alternate.id);
    await page.getByLabel("权限", { exact: true }).selectOption("full_access");
    await page.getByRole("radio", { name: reviewer.name, exact: true }).click();
    await choice(alternate.id, alternateEffort, "workspace_write");
    await page.getByRole("radio", { name: writer.name, exact: true }).click();
    assert.equal(
      await page.getByLabel("权限", { exact: true }).inputValue(),
      "full_access",
    );
    await page.locator(".hHd-Xa_newSession").click();
    await choice(primary.id, effort, "read_only");
    await page.getByLabel("个人项目", { exact: true }).selectOption("none");
    await page
      .getByLabel("输入消息", { exact: true })
      .fill(
        "Reply with exactly ASSISTANT_DEFAULTS_OK. Do not call tools or change files.",
      );
    await page.getByLabel("输入消息", { exact: true }).press("Enter");
    await page.waitForURL((url) => url.searchParams.has("session"), {
      timeout: 60000,
    });
    const id = new URL(page.url()).searchParams.get("session");
    sessions.push(id);
    const session = await json(page, `/api/runtime/v1/sessions/${id}`);
    assert.equal(session.preset.presetId, writer.id);
    assert.equal(session.modelId, primary.id);
    assert.equal(session.thinkingEffort || "", effort);
    assert.equal(session.permissionMode, "read_only");
    await page
      .locator(".workagent-message.is-assistant .workagent-markdown")
      .filter({ hasText: "ASSISTANT_DEFAULTS_OK" })
      .waitFor({ timeout: 120000 });
    await screenshot("assistant-defaults-real-conversation.png");
    assert.deepEqual(errors, []);
    await writeFile(
      join(output, "assistant-defaults.json"),
      JSON.stringify(
        {
          passed: true,
          checks: [
            "create without model",
            "custom assistants in settings",
            "three independent defaults",
            "builtin defaults preserved",
            "reload persistence",
            "same-engine draft isolation",
            "new conversation reset",
            "390px mobile",
            "real native session",
          ],
          session: {
            presetId: writer.id,
            modelId: session.modelId,
            thinkingEffort: session.thinkingEffort,
            permissionMode: session.permissionMode,
          },
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const id of sessions)
      await json(page, `/api/runtime/v1/sessions/${id}`, { method: "DELETE" });
    const presets = (await json(page, "/api/runtime/v1/presets")).filter(
      (row) => row.name.startsWith(prefix),
    );
    for (const preset of presets)
      await json(
        page,
        `/api/runtime/v1/presets/${encodeURIComponent(preset.id)}`,
        { method: "DELETE" },
      );
  }
});
console.log("assistant defaults smoke passed");
