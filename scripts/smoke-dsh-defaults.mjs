import {
  baseURL,
  json,
  openSettingsSection,
  withPage,
} from "./smoke-dsh-helpers.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

await withPage(async (page) => {
  const storageKey = "workagent.model-defaults.v1";
  const original = await page.evaluate(
    (key) => localStorage.getItem(key),
    storageKey,
  );
  const sessions = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const screenshotDir = process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR;
  const screenshot = async (name) => {
    if (!screenshotDir) return;
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: join(screenshotDir, name), fullPage: true });
  };
  const checkChoice = async (model, effort, permission) =>
    page.waitForFunction(
      ({ model, effort, permission }) =>
        document.querySelector('select[aria-label="模型"]')?.value === model &&
        document.querySelector('select[aria-label="思考级别"]')?.value ===
          effort &&
        document.querySelector('select[aria-label="权限"]')?.value ===
          permission,
      { model, effort, permission },
    );
  const setDefaults = async (name, model, effort, permission) => {
    await page.goto(`${baseURL}/?frontend=dsh`);
    const section = await openSettingsSection(page, "模型");
    await section
      .getByLabel(`${name} 默认模型`, { exact: true })
      .selectOption(model);
    await section
      .getByLabel(`${name} 默认思考强度`, { exact: true })
      .selectOption(effort);
    await section
      .getByLabel(`${name} 默认权限`, { exact: true })
      .selectOption(permission);
    return section;
  };
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate((key) => {
      localStorage.removeItem(key);
      localStorage.setItem("workagent.hero.agent", "builtin-codex");
      localStorage.setItem("workagent.hero.model.codex", "gpt-5.6-sol");
      localStorage.setItem("workagent.hero.effort.codex.gpt-6-astra", "high");
      localStorage.setItem(
        "workagent.hero.effort.kimi.kimi-code/kimi-k3",
        "high",
      );
    }, storageKey);
    await page.reload();
    await checkChoice("gpt-6-astra", "low", "workspace_write");
    await page.getByRole("radio", { name: "Kimi", exact: true }).click();
    await checkChoice("kimi-code/kimi-k3", "low", "workspace_write");
    const groups = await json(page, "/api/runtime/v1/model-options");
    const alternative = groups
      .find((group) => group.engine === "codex")
      .models.find((model) => model.id !== "gpt-6-astra");
    if (!alternative)
      throw new Error(
        "Need a second live Codex model to verify configurable defaults",
      );
    const alternativeEffort =
      alternative.reasoning.find((option) => option.id === "medium")?.id ||
      alternative.reasoning[0].id;

    let section = await setDefaults(
      "Codex",
      alternative.id,
      alternativeEffort,
      "full_access",
    );
    if (
      (await section
        .getByLabel("Codex 默认权限")
        .locator("option:checked")
        .innerText()) !== "完全访问"
    )
      throw new Error("Full access is not localized");
    await screenshot("defaults-model-settings.png");
    await page.goto(`${baseURL}/?frontend=dsh`);
    await page.getByRole("radio", { name: "Codex", exact: true }).click();
    await checkChoice(alternative.id, alternativeEffort, "full_access");
    await page.getByLabel("模型", { exact: true }).selectOption("gpt-6-astra");
    await page.getByLabel("思考级别", { exact: true }).selectOption("high");
    await page.getByLabel("权限", { exact: true }).selectOption("read_only");
    await page.locator(".hHd-Xa_newSession").click();
    await checkChoice(alternative.id, alternativeEffort, "full_access");
    await page.reload();
    await checkChoice(alternative.id, alternativeEffort, "full_access");
    await page.getByRole("radio", { name: "Kimi", exact: true }).click();
    await checkChoice("kimi-code/kimi-k3", "low", "workspace_write");

    section = await setDefaults(
      "Kimi",
      "kimi-code/kimi-k3",
      "high",
      "read_only",
    );
    await page.setViewportSize({ width: 1328, height: 670 });
    await section.getByLabel("Kimi 默认模型").scrollIntoViewIfNeeded();
    if (
      await section
        .locator(".workagent-model-defaults")
        .evaluateAll((nodes) =>
          nodes.some((node) => node.scrollWidth > node.clientWidth + 1),
        )
    )
      throw new Error("Defaults controls overflow");
    await screenshot("defaults-kimi-compact.png");
    await page.goto(`${baseURL}/?frontend=dsh`);
    await checkChoice("kimi-code/kimi-k3", "high", "read_only");

    // Actual native sessions must receive settings defaults without touching the composer selectors.
    for (const [engine, name, model] of [
      ["codex", "Codex", "gpt-6-astra"],
      ["kimi", "Kimi", "kimi-code/kimi-k3"],
    ]) {
      await setDefaults(name, model, "low", "read_only");
      await page.goto(`${baseURL}/?frontend=dsh`);
      await page.getByRole("radio", { name, exact: true }).click();
      await checkChoice(model, "low", "read_only");
      await page.getByLabel("个人项目", { exact: true }).selectOption("none");
      await page
        .getByLabel("输入消息", { exact: true })
        .fill(
          "Reply with exactly DEFAULTS_OK. Do not use tools or change files.",
        );
      await page.getByLabel("输入消息", { exact: true }).press("Enter");
      await page.waitForURL((url) => url.searchParams.has("session"), {
        timeout: 60000,
      });
      const id = new URL(page.url()).searchParams.get("session");
      sessions.push(id);
      const session = await json(page, `/api/runtime/v1/sessions/${id}`);
      if (
        session.engine !== engine ||
        session.modelId !== model ||
        session.thinkingEffort !== "low" ||
        session.permissionMode !== "read_only"
      )
        throw new Error(`${engine} session did not receive defaults`);
      await page
        .locator(".workagent-message.is-assistant .workagent-markdown")
        .filter({ hasText: "DEFAULTS_OK" })
        .waitFor({ timeout: 120000 });
      console.log(
        `${name}: ${model} / low / read_only completed a real turn using settings defaults`,
      );
    }

    await page.goto(`${baseURL}/?frontend=dsh`);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    if (await dialog.getByLabel("Codex 默认权限", { exact: true }).count())
      throw new Error("General settings duplicates model permissions");
    await dialog.getByLabel("字体大小", { exact: true }).waitFor();
    await screenshot("defaults-general-typography.png");
    await dialog.getByRole("button", { name: "模型", exact: true }).click();
    const modelPermission = dialog.getByLabel("Codex 默认权限", {
      exact: true,
    });
    if ((await modelPermission.inputValue()) !== "read_only")
      throw new Error("Model permission was not preserved");
    await modelPermission.selectOption("workspace_write");
    await dialog.getByRole("button", { name: "通用设置", exact: true }).click();
    if (await dialog.getByLabel("Codex 默认权限", { exact: true }).count())
      throw new Error("General settings still contains permissions");
    if (await page.getByText(/^Full access$/i).count())
      throw new Error("English Full access remains");
    if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
    if (screenshotDir)
      await writeFile(
        join(screenshotDir, "defaults-checks.json"),
        JSON.stringify(
          {
            productDefaults: true,
            configurableDefaults: true,
            newConversationResets: true,
            reloadPersistence: true,
            perEngineIsolation: true,
            nativeSessionDefaults: true,
            permissionLocalization: true,
            pageErrors: errors,
            groups,
          },
          null,
          2,
        ),
      );
  } finally {
    for (const id of sessions)
      await json(page, `/api/runtime/v1/sessions/${id}`, { method: "DELETE" });
    await page.evaluate(
      ({ key, original }) => {
        if (original === null) localStorage.removeItem(key);
        else localStorage.setItem(key, original);
      },
      { key: storageKey, original },
    );
  }
});
console.log(
  "Model defaults smoke passed: settings, persistence, draft reset, localized permissions and real native turns",
);
