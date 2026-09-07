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
  const report = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const entry of ["page", "settings"]) {
    const name = uniqueName(`删除确认验收-${entry}`);
    const preset = await json(page, "/api/runtime/v1/presets", {
      method: "POST",
      body: JSON.stringify({ name, engine: "codex" }),
    });
    const endpoint = `/api/runtime/v1/presets/${preset.id}`;
    let requests = 0;
    const receive = (request) => {
      if (
        new URL(request.url()).pathname === endpoint &&
        request.method() === "DELETE"
      )
        requests++;
    };
    page.on("request", receive);
    try {
      let section;
      if (entry === "page") {
        await page.goto(`${baseURL}/?frontend=dsh&workagent=assistants`);
        section = page.locator('[data-workagent-section="助手"]');
      } else {
        await page.goto(`${baseURL}/?frontend=dsh`);
        section = await openSettingsSection(page, "助手");
      }
      const card = section.locator("article", { hasText: name });
      await card.waitFor();
      const click = async (accept) => {
        const event = page.waitForEvent("dialog");
        const clicked = card
          .getByRole("button", { name: "删除", exact: true })
          .click();
        const dialog = await event;
        assert.equal(dialog.type(), "confirm");
        assert.equal(
          dialog.message(),
          `确定删除助手“${name}”？此操作无法撤销。`,
        );
        if (accept) await dialog.accept();
        else await dialog.dismiss();
        await clicked;
      };
      await click(false);
      assert.equal(requests, 0, "cancel sent a deletion request");
      assert.equal((await json(page, endpoint)).id, preset.id);
      await card.getByRole("button", { name: "编辑", exact: true }).click();
      await section
        .getByRole("button", { name: "保存助手", exact: true })
        .waitFor();
      await click(true);
      await card.waitFor({ state: "detached" });
      await section
        .getByRole("button", { name: "创建助手", exact: true })
        .waitFor();
      assert.equal(
        requests,
        1,
        "confirmation did not send exactly one deletion request",
      );
      assert.equal(
        (await json(page, "/api/runtime/v1/presets")).some(
          (row) => row.id === preset.id,
        ),
        false,
      );
      report.push({
        entry,
        cancellationPreservedAssistant: true,
        confirmationDeletedAssistant: true,
        editingCleared: true,
        requests,
      });
    } finally {
      page.off("request", receive);
      if (
        (await json(page, "/api/runtime/v1/presets")).some(
          (row) => row.id === preset.id,
        )
      )
        await json(page, endpoint, { method: "DELETE" });
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, "assistant-delete.json"),
    JSON.stringify({ passed: true, report, errors }, null, 2),
  );
});
console.log("assistant delete confirmation smoke passed");
