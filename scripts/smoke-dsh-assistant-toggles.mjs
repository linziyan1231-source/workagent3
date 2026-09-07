import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseURL, withPage, json } from "./smoke-dsh-helpers.mjs";

const output = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
await mkdir(output, { recursive: true });
await withPage(async (page) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const initial = (await json(page, "/api/runtime/v1/presets")).filter(
    (row) => row.source === "builtin",
  );
  assert.equal(
    initial.find((row) => row.id === "builtin-general").enabled,
    false,
  );
  const open = async () => {
    await page.getByRole("button", { name: "助手", exact: true }).click();
    return page.getByRole("dialog", { name: "助手", exact: true });
  };
  let dialog = await open();
  try {
    for (const row of initial) {
      const name = row.name === "General" ? "DSH" : row.name;
      const control = dialog.getByRole("switch", {
        name: `${name} 开关`,
        exact: true,
      });
      assert.equal(
        await control.getAttribute("aria-checked"),
        String(row.enabled),
      );
      await control.click();
      await page.waitForFunction(
        ({ id, enabled }) =>
          fetch(`/api/runtime/v1/presets/${encodeURIComponent(id)}`)
            .then((r) => r.json())
            .then((r) => r.enabled === enabled),
        { id: row.id, enabled: !row.enabled },
      );
      await page.waitForFunction(
        ({ name, enabled }) => {
          const visible = [...document.querySelectorAll('[role="radio"]')].some(
            (node) => node.textContent.trim() === name,
          );
          return visible === enabled;
        },
        { name, enabled: !row.enabled },
      );
      await page.reload();
      dialog = await open();
      assert.equal(
        await dialog
          .getByRole("switch", { name: `${name} 开关`, exact: true })
          .getAttribute("aria-checked"),
        String(!row.enabled),
      );
      await dialog
        .getByRole("switch", { name: `${name} 开关`, exact: true })
        .click();
      await page.waitForFunction(
        ({ id, enabled }) =>
          fetch(`/api/runtime/v1/presets/${encodeURIComponent(id)}`)
            .then((r) => r.json())
            .then((r) => r.enabled === enabled),
        { id: row.id, enabled: row.enabled },
      );
    }
    await page.waitForFunction(
      (rows) =>
        rows.every((row) => {
          const name = row.name === "General" ? "DSH" : row.name;
          return (
            document
              .querySelector(`[role="switch"][aria-label="${name} 开关"]`)
              ?.getAttribute("aria-checked") === String(row.enabled)
          );
        }),
      initial,
    );
    await page.screenshot({
      animations: "disabled",
      path: join(output, "assistant-switches-desktop.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog
      .getByRole("switch", { name: "Kimi 开关", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      animations: "disabled",
      path: join(output, "assistant-switches-mobile.png"),
    });
    await page.goto(`${baseURL}/?frontend=dsh`);
    assert.equal(
      await page.getByRole("radio", { name: "DSH", exact: true }).count(),
      0,
    );
    await page.getByRole("radio", { name: "Codex", exact: true }).waitFor();
    await writeFile(
      join(output, "assistant-toggles.json"),
      JSON.stringify(
        {
          defaults: "DSH off",
          toggled: initial.map((row) => row.id),
          refreshPersistence: true,
          disabledHidden: true,
          desktop: true,
          mobile: true,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const row of initial)
      await json(
        page,
        `/api/runtime/v1/presets/${encodeURIComponent(row.id)}`,
        { method: "PATCH", body: JSON.stringify({ enabled: row.enabled }) },
      );
  }
});
console.log("Assistant toggles authenticated browser smoke passed");
