import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseURL, withPage } from "./smoke-dsh-helpers.mjs";

await withPage(async (page) => {
  const evidence = process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const submissions = [];
  // Observe submission without creating sessions or sending model requests.
  await page.route("**/api/runtime/v1/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    submissions.push(route.request().postDataJSON());
    await route.fulfill({
      status: 409,
      json: { error: "IME smoke intercepted" },
    });
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/runtime/v1/sessions/ime-smoke"),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === "POST") {
        submissions.push(route.request().postDataJSON());
        return route.fulfill({
          status: 409,
          json: { error: "IME smoke intercepted" },
        });
      }
      if (path.endsWith("/events"))
        return route.fulfill({ contentType: "text/event-stream", body: "" });
      return route.fulfill({
        json: path.endsWith("/messages")
          ? []
          : { id: "ime-smoke", engine: "codex", title: "输入法验收" },
      });
    },
  );
  const results = [];
  for (const [name, path, label] of [
    ["home", "/?frontend=dsh", "输入消息"],
    ["conversation", "/?frontend=dsh&session=ime-smoke", "继续对话"],
  ]) {
    await page.goto(`${baseURL}${path}`);
    const input = page.getByRole("textbox", { name: label, exact: true });
    await input.waitFor();
    if (name === "home")
      await page.waitForFunction(
        () => document.querySelector('select[aria-label="模型"]')?.value,
      );
    await input.evaluate((element) => {
      element.form.dataset.imeSubmits = "0";
      element.form.addEventListener("submit", () => {
        element.form.dataset.imeSubmits = String(
          Number(element.form.dataset.imeSubmits) + 1,
        );
      });
    });
    const before = submissions.length;
    await input.dispatchEvent("compositionstart", { data: "" });
    await input.fill("nihao");
    await input.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      isComposing: true,
    });
    assert.equal(await input.inputValue(), "nihao");
    assert.equal(await input.evaluate((el) => el.form.dataset.imeSubmits), "0");
    await input.dispatchEvent("compositionend", { data: "你好" });
    await input.fill("你好");
    await input.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 229,
      isComposing: false,
    });
    assert.equal(await input.inputValue(), "你好");
    assert.equal(await input.evaluate((el) => el.form.dataset.imeSubmits), "0");
    await input.press("End");
    await input.press("Shift+Enter");
    assert.equal(await input.inputValue(), "你好\n");
    assert.equal(submissions.length, before);
    if (evidence)
      await page.screenshot({
        path: join(evidence, `ime-${name}-confirmed.png`),
      });
    await input.press("Enter");
    await page
      .getByRole("alert")
      .filter({ hasText: "IME smoke intercepted" })
      .waitFor();
    assert.equal(await input.evaluate((el) => el.form.dataset.imeSubmits), "1");
    assert.equal(submissions.length, before + 1);
    assert.equal(
      name === "home" ? submissions.at(-1).title : submissions.at(-1).content,
      "你好",
    );
    results.push({
      name,
      compositionEnter: "preserved",
      keyCode229: "preserved",
      shiftEnter: "newline",
      enter: "submitted once with Chinese text",
    });
  }
  if (evidence)
    await writeFile(
      join(evidence, "ime-report.json"),
      JSON.stringify(results, null, 2),
    );
});

console.log("DSH IME confirmation smoke passed for both composers");
