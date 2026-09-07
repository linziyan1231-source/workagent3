import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseURL, json, withPage } from "./smoke-dsh-helpers.mjs";

const output = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
await mkdir(output, { recursive: true });
await withPage(async (page) => {
  await page.evaluate(() =>
    localStorage.setItem("workagent.files.open", "false"),
  );
  const created = new Set();
  const reports = [];
  const endpoint = "/api/runtime/v1/sessions";
  const post = (path, body = {}) =>
    json(page, path, { method: "POST", body: JSON.stringify(body) });
  const presets = await json(page, "/api/runtime/v1/presets");
  try {
    for (const engine of ["codex", "kimi"]) {
      const preset = presets.find(
        (row) => row.engine === engine && row.enabled,
      );
      assert.ok(preset, `${engine} assistant must be enabled for smoke`);
      const main = await post(endpoint, {
        engine,
        presetId: preset.id,
        title: `side-delete-${engine}-${Date.now()}`,
        workspace: "default",
        permissionMode: "read_only",
      });
      created.add(main.id);
      const historic = await post(`${endpoint}/${main.id}/side-chat`);
      created.add(historic.id);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(`${baseURL}/?frontend=dsh&session=${main.id}`);
      const open = async () => {
        await page.getByLabel("继续对话", { exact: true }).fill("/btw");
        await page.getByRole("button", { name: "发送", exact: true }).click();
        await page.getByRole("complementary", { name: "侧聊 BTW" }).waitFor();
        return page.evaluate(
          (id) => localStorage.getItem(`workagent.side-chat.${id}`),
          main.id,
        );
      };
      const sideId = await open();
      created.add(sideId);
      assert.notEqual(sideId, historic.id);
      const side = page.getByRole("complementary", { name: "侧聊 BTW" });
      await side.getByLabel("侧聊消息").fill("只回复 SIDE-DELETE-CHECK。");
      await side.getByRole("button", { name: "发送", exact: true }).click();
      await page.waitForFunction(async (path) => {
        const rows = await fetch(path).then((response) => response.json());
        return Array.isArray(rows) && rows.some((row) => row.role === "user");
      }, `${endpoint}/${sideId}/messages`);
      await side.getByRole("button", { name: "删除侧聊" }).click();
      const dialog = page.getByRole("alertdialog", { name: "确认删除侧聊" });
      await dialog.waitFor();
      assert.equal(
        (await page.request.get(`${baseURL}${endpoint}/${sideId}`)).status(),
        200,
      );
      await page.screenshot({
        path: join(output, `${engine}-confirm.png`),
        animations: "disabled",
      });
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await side.waitFor();
      await side.getByRole("button", { name: "删除侧聊" }).click();
      await page.route(`**${endpoint}/${sideId}`, async (route) => {
        if (route.request().method() === "DELETE")
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "session_close_failed" }),
          });
        else await route.continue();
      });
      await dialog
        .getByRole("button", { name: "确认删除", exact: true })
        .click();
      await dialog.getByRole("alert").waitFor();
      assert.equal(
        await page.evaluate(
          (id) => localStorage.getItem(`workagent.side-chat.${id}`),
          main.id,
        ),
        sideId,
      );
      assert.equal(
        (await page.request.get(`${baseURL}${endpoint}/${sideId}`)).status(),
        200,
      );
      await page.unroute(`**${endpoint}/${sideId}`);
      await dialog
        .getByRole("button", { name: "确认删除", exact: true })
        .click();
      await side.waitFor({ state: "detached" });
      created.delete(sideId);
      assert.equal(
        (await page.request.get(`${baseURL}${endpoint}/${sideId}`)).status(),
        404,
      );
      assert.equal(
        (
          await page.request.get(`${baseURL}${endpoint}/${sideId}/messages`)
        ).status(),
        404,
      );
      assert.equal(
        (await page.request.get(`${baseURL}${endpoint}/${main.id}`)).status(),
        200,
      );
      assert.equal(
        (
          await page.request.get(`${baseURL}${endpoint}/${historic.id}`)
        ).status(),
        200,
      );
      await page.reload();
      await page.getByLabel("继续对话", { exact: true }).waitFor();
      assert.equal(await side.count(), 0);
      const reopenedId = await open();
      created.add(reopenedId);
      assert.notEqual(reopenedId, sideId);
      assert.notEqual(reopenedId, historic.id);
      assert.deepEqual(
        await json(page, `${endpoint}/${reopenedId}/messages`),
        [],
      );
      await page.reload();
      await side.waitFor();
      assert.equal(
        await page.evaluate(
          (id) => localStorage.getItem(`workagent.side-chat.${id}`),
          main.id,
        ),
        reopenedId,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await side.getByRole("button", { name: "删除侧聊" }).click();
      await dialog.waitFor();
      await page.screenshot({
        path: join(output, `${engine}-confirm-mobile.png`),
        animations: "disabled",
      });
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      reports.push({
        engine,
        cancellation: true,
        failurePreservesChat: true,
        deletedSessionAndMessages: true,
        mainPreserved: true,
        historicPreserved: true,
        freshAfterReload: true,
      });
    }
    await writeFile(
      join(output, "side-delete.json"),
      JSON.stringify(reports, null, 2),
    );
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    for (const id of [...created].reverse())
      await json(page, `${endpoint}/${id}`, { method: "DELETE" }).catch(
        () => {},
      );
  }
});
console.log(
  "Side chat deletion confirmation, failure recovery and fresh reopening verified for Codex and Kimi",
);
