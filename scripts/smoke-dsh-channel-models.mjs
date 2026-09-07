import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseURL, json, withPage } from "./smoke-dsh-helpers.mjs";

// Verify that the catalog advertised by the channel plugin names models the
// same employee runtime can actually execute. External IM delivery is tested
// separately with in-process adapters, without messaging external contacts.
await withPage(async (page) => {
  const catalog = await json(page, "/dsh-im-connect/api/assistant");
  for (const engine of ["codex", "kimi"]) {
    const provider = catalog.providers.find(
      (row) => row.id === `workagent-${engine}`,
    );
    assert(provider?.models.length);
    const model =
      provider.models.find((row) => row.id === "gpt-5.6-sol") ||
      provider.models[0];
    const created = await json(page, "/api/runtime/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        engine,
        presetId: `builtin-${engine}`,
        modelId: model.id,
        permissionMode: "read_only",
        title: `渠道模型验证 ${engine}`,
        workspace: "default",
      }),
    });
    const id = created.id;
    assert(id);
    try {
      await page.goto(
        `${baseURL}/?frontend=dsh&session=${encodeURIComponent(id)}`,
      );
      await page
        .getByLabel("继续对话", { exact: true })
        .fill(
          "Reply with exactly CHANNEL_MODEL_OK. Do not call tools or modify files.",
        );
      await page.getByLabel("继续对话", { exact: true }).press("Enter");
      console.log(`${engine}: submitted browser turn with ${model.id}`);
      await page
        .locator(".workagent-message.is-assistant .workagent-markdown")
        .filter({ hasText: "CHANNEL_MODEL_OK" })
        .waitFor({ timeout: 120_000 });
      const session = await json(page, `/api/runtime/v1/sessions/${id}`);
      assert.equal(session.engine, engine);
      assert.equal(session.modelId, model.id);
      console.log(
        `${engine}: channel catalog model ${model.id} completed an authenticated browser turn`,
      );
    } catch (error) {
      console.log(
        JSON.stringify(await json(page, `/api/runtime/v1/sessions/${id}`)),
      );
      const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({
          path: join(evidence, `${engine}-model-failure.png`),
        });
        await writeFile(
          join(evidence, `${engine}-model-failure.txt`),
          await page.locator("body").innerText(),
        );
      }
      throw error;
    } finally {
      await json(page, `/api/runtime/v1/sessions/${id}`, { method: "DELETE" });
    }
  }
});
