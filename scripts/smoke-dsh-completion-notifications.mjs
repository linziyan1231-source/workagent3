import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  baseURL,
  json,
  openSettingsSection,
  withPage,
} from "./smoke-dsh-helpers.mjs";

await withPage(async (page) => {
  const endpoint = "/api/runtime/v1/completion-notifications";
  const before = await json(page, endpoint);
  // This smoke never enables delivery to a real external recipient.
  assert.equal(
    before.enabled,
    false,
    "Run the settings smoke with a test employee whose reminders are off",
  );
  const initial = {
    enabled: before.enabled,
    targetId: before.targetId,
    baseURL: before.baseURL,
  };
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const closeFiles = page.getByRole("button", {
    name: "关闭文件侧栏",
    exact: true,
  });
  if (await closeFiles.isVisible()) await closeFiles.click();
  try {
    const section = await openSettingsSection(page, "消息提醒");
    const toggle = section.getByRole("switch", { name: "任务完成提醒" });
    await toggle.waitFor();
    assert.equal(await toggle.isChecked(), false);
    await toggle.check();
    await section.getByRole("combobox", { name: "接收聊天" }).selectOption("");
    await section.getByRole("button", { name: "保存提醒设置" }).click();
    await section
      .getByRole("alert")
      .filter({ hasText: "请选择已连接的接收聊天" })
      .waitFor();
    assert.equal((await json(page, endpoint)).enabled, false);
    await toggle.uncheck();
    await section
      .getByRole("textbox", { name: "WorkAgent 访问网址" })
      .fill(baseURL);
    await section.getByRole("button", { name: "保存提醒设置" }).click();
    await section
      .getByRole("status")
      .filter({ hasText: "提醒设置已保存" })
      .waitFor();
    await page.reload();
    if (await closeFiles.isVisible()) await closeFiles.click();
    const reloaded = await openSettingsSection(page, "消息提醒");
    assert.equal(
      await reloaded.getByRole("switch", { name: "任务完成提醒" }).isChecked(),
      false,
    );
    assert.equal(
      await reloaded
        .getByRole("textbox", { name: "WorkAgent 访问网址" })
        .inputValue(),
      baseURL,
    );
    assert.deepEqual(
      (await json(page, endpoint)).deliveries,
      before.deliveries,
    );
    const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({
        path: join(evidence, "completion-notifications-desktop.png"),
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: join(evidence, "completion-notifications-mobile.png"),
      });
      await writeFile(
        join(evidence, "completion-notifications-smoke.json"),
        JSON.stringify(
          {
            defaultOff: true,
            invalidRecipientRejected: true,
            settingsPersisted: true,
            externalMessagesSent: false,
            errors,
          },
          null,
          2,
        ),
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS authenticated completion notification settings, explicit recipient validation, persistence and no external sends",
    );
  } finally {
    await json(page, endpoint, {
      method: "PUT",
      body: JSON.stringify(initial),
    });
  }
});
