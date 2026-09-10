import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  baseURL,
  json,
  openSettingsSection,
  withPage,
} from "./smoke-dsh-helpers.mjs";

const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
const channels = [
  ["weixin", "微信"],
  ["wecom", "企业微信"],
  ["feishu", "飞书"],
  ["dingtalk", "钉钉"],
];

await withPage(async (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const catalog = await json(page, "/dsh-im-connect/api/channels");
  assert.equal(catalog.ok, true);
  const before = catalog.channels.flatMap((channel) => channel.accounts || []);
  const closeFiles = page.getByRole("button", {
    name: "关闭文件侧栏",
    exact: true,
  });
  if (await closeFiles.isVisible()) await closeFiles.click();
  const section = await openSettingsSection(page, "消息渠道");
  assert.equal(await section.locator(".ima-title").innerText(), "消息渠道");
  const assistant = await json(page, "/dsh-im-connect/api/assistant");
  for (const engine of ["codex", "kimi"]) {
    const provider = assistant.providers.find(
      (row) => row.id === `workagent-${engine}`,
    );
    assert(
      provider?.models.length,
      `${engine} must expose actual native models`,
    );
  }
  const results = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const [id, label] of channels) {
    assert(catalog.channels.some((channel) => channel.id === id));
    const platform = section.locator(".ima-platform").filter({
      has: page.getByText(label, { exact: true }),
    });
    await platform
      .getByRole("button", { name: "＋ 添加账号", exact: true })
      .click();
    await page.getByText(`配置 ${label}`, { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "生成二维码", exact: true })
      .waitFor();
    for (const engine of ["Codex", "Kimi"]) {
      await page
        .getByRole("button", { name: "选择助手与模型", exact: true })
        .click();
      await page.getByRole("menuitem", { name: /^助手/ }).click();
      await page
        .getByRole("menuitemradio", { name: engine, exact: true })
        .click();
      await page
        .getByRole("button", { name: "选择助手与模型", exact: true })
        .click();
      await page.getByRole("menuitem", { name: /^模型/ }).click();
      const choice = page
        .getByRole("group", { name: engine, exact: true })
        .getByRole("menuitemradio")
        .first();
      const modelName = await choice.locator(".ima-model-name").innerText();
      await choice.click();
      assert(
        (
          await page
            .getByRole("button", { name: "选择助手与模型", exact: true })
            .innerText()
        ).includes(modelName),
      );
    }
    assert.equal(
      await page.getByText("仅已批准用户", { exact: true }).count(),
      1,
    );
    if (id === "wecom" || id === "dingtalk") {
      await page.getByRole("button", { name: "手动配置", exact: true }).click();
      await page
        .getByText(id === "wecom" ? "Bot ID" : "Client ID（原 AppKey）", {
          exact: true,
        })
        .waitFor();
      await page
        .getByRole("button", { name: "快捷绑定（推荐）", exact: true })
        .click();
    }
    if (evidence)
      await page.screenshot({ path: join(evidence, `${id}-setup.png`) });
    await page.locator(".ima-x").click();
    results.push({ channel: id, setup: "passed" });
  }
  await page.reload();
  await openSettingsSection(page, "消息渠道");
  const after = await json(page, "/dsh-im-connect/api/channels");
  assert.deepEqual(
    after.channels.flatMap((channel) => channel.accounts || []),
    before,
  );
  assert.deepEqual(errors, []);
  if (evidence) {
    await page.screenshot({ path: join(evidence, "channels-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(evidence, "channels-mobile.png") });
    await writeFile(
      join(evidence, "channels-smoke.json"),
      JSON.stringify(
        { baseURL, results, errors, existingAccountsPreserved: true },
        null,
        2,
      ),
    );
  }
  console.log(
    "DSH channel catalog, four setup dialogs, manual credentials, access defaults and reload passed",
  );
});
