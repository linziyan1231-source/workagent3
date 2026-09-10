import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  baseURL,
  json,
  openSettingsSection,
  withPage,
} from "./smoke-dsh-helpers.mjs";

// The assistant catalog is real. An isolated browser account fixture exercises
// edits without changing a connected account or sending external IM messages.
await withPage(async (page) => {
  const created = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const output = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
  if (output) await mkdir(output, { recursive: true });
  try {
    for (const engine of ["codex", "kimi", "harness"]) {
      created.push(
        await json(page, "/api/runtime/v1/presets", {
          method: "POST",
          body: JSON.stringify({
            name: `渠道验收 · ${engine === "harness" ? "通用助手" : engine === "codex" ? "审阅助手" : "写作助手"}`,
            engine,
            systemPrompt: `Channel assistant ${engine}`,
          }),
        }),
      );
    }
    const catalog = await json(page, "/dsh-im-connect/api/assistant");
    for (const assistant of created)
      assert(catalog.assistants.some((row) => row.id === assistant.id));
    const channelResponse = await json(page, "/dsh-im-connect/api/channels");
    const provider = catalog.providers.find(
      (row) => row.id === "workagent-codex",
    );
    const account = {
      id: "weixin_browser_assistant_fixture",
      platform: "weixin",
      name: "助手配置验收账号",
      connected: false,
      receiveEnabled: false,
      status: "未连接",
      configuredKeys: [],
      assistant: { provider: provider.id, model: provider.models[0].id },
      cwd: catalog.cwd,
      permission: "read-only",
      privateAccess: "approved",
    };
    const saves = [];
    await page.route("**/dsh-im-connect/api/channels", (route) =>
      route.fulfill({
        json: {
          ...channelResponse,
          channels: channelResponse.channels.map((row) => ({
            ...row,
            total: row.id === "weixin" ? 1 : 0,
            online: 0,
            accounts: row.id === "weixin" ? [account] : [],
          })),
        },
      }),
    );
    await page.route(
      `**/dsh-im-connect/api/accounts/${account.id}/settings`,
      async (route) => {
        const body = route.request().postDataJSON();
        saves.push(body);
        account.assistant = {
          presetId: body.presetId,
          provider: body.provider,
          model: body.model,
          ...(body.reasoningEffort
            ? { reasoningEffort: body.reasoningEffort }
            : {}),
        };
        await route.fulfill({ json: { ok: true, account } });
      },
    );
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.goto(`${baseURL}/?frontend=dsh`);
    const settings = await openSettingsSection(page, "消息渠道");
    const accountButton = settings.getByRole("button", {
      name: /助手配置验收账号/,
    });
    await accountButton.click();
    assert.equal(
      await settings.getByText("助手与模型", { exact: true }).count(),
      1,
    );
    for (const assistant of created) {
      await settings
        .getByRole("button", { name: "选择助手与模型", exact: true })
        .click();
      await page.getByRole("menuitem", { name: /^助手/ }).click();
      const assistantChoice = page.getByRole("menuitemradio", {
        name: assistant.name,
        exact: true,
      });
      await assistantChoice.waitFor({ state: "visible" });
      await assistantChoice.scrollIntoViewIfNeeded();
      if (output)
        await page.screenshot({
          path: join(output, `assistant-choices-${assistant.engine}.png`),
        });
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().endsWith(`/accounts/${account.id}/settings`) &&
            response.status() === 200,
        ),
        assistantChoice.click(),
      ]);
      await page.waitForFunction(
        (name) =>
          document
            .querySelector(".ima-inspector .ima-model-select")
            ?.textContent.includes(name),
        assistant.name,
      );
      assert.equal(saves.at(-1).presetId, assistant.id);
      assert.equal(saves.at(-1).provider, `workagent-${assistant.engine}`);
      assert(
        catalog.providers
          .find((row) => row.id === saves.at(-1).provider)
          .models.some((row) => row.id === saves.at(-1).model),
      );
      await settings
        .getByRole("button", { name: "选择助手与模型", exact: true })
        .click();
      await page.getByRole("menuitem", { name: /^模型/ }).click();
      assert.equal(
        await page.locator(".ima-model-group").count(),
        1,
        "models stay within the selected assistant's engine",
      );
      await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().endsWith(`/accounts/${account.id}/settings`) &&
            response.status() === 200,
        ),
        page.getByRole("menuitemradio").last().click(),
      ]);
      assert.equal(
        saves.at(-1).presetId,
        assistant.id,
        "changing a model preserves the custom assistant",
      );
      await page.reload();
      await openSettingsSection(page, "消息渠道");
      await page
        .getByRole("button", { name: "选择助手与模型", exact: true })
        .filter({ hasText: assistant.name })
        .waitFor();
      assert(
        (
          await page
            .getByRole("button", { name: "选择助手与模型", exact: true })
            .innerText()
        ).includes(assistant.name),
      );
    }
    if (output) {
      await page.screenshot({
        path: join(output, "channel-custom-assistant.png"),
      });
      await writeFile(
        join(output, "channel-assistants.json"),
        JSON.stringify(
          {
            engines: created.map((row) => row.engine),
            saves,
            errors,
            accountFixture: true,
            externalMessagesSent: false,
          },
          null,
          2,
        ),
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS authenticated channel assistant catalog and custom Codex/Kimi/general selection, save payload and reload",
    );
  } finally {
    for (const assistant of created)
      await json(page, `/api/runtime/v1/presets/${assistant.id}`, {
        method: "DELETE",
      });
  }
});
