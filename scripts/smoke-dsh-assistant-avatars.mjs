import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  login,
  openSettingsSection,
  requireSmokeEnvironment,
} from "./smoke-dsh-helpers.mjs";

requireSmokeEnvironment();
const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
await mkdir(evidence, { recursive: true });
const fixture = process.env.WORKAGENT_SMOKE_AVATAR_FIXTURE === "1";
const report = { status: "running", fixture, checks: [], errors: [] };
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (error) => report.errors.push(error.message));
  const candidate = process.env.WORKAGENT_SMOKE_AVATAR_CLIENT;
  if (candidate)
    await page.route("**/plugins/@workagent/dsh-client/client.js*", (route) =>
      readFile(candidate, "utf8").then((body) =>
        route.fulfill({ contentType: "text/javascript", body }),
      ),
    );
  let rows;
  if (fixture) {
    await page.route("**/api/runtime/v1/presets", async (route) => {
      if (!rows) rows = await (await route.fetch()).json();
      if (route.request().method() === "POST") {
        const row = {
          ...rows.find((row) => row.id === "builtin-codex"),
          ...route.request().postDataJSON(),
          id: "avatar-fixture",
          source: "user",
        };
        rows.push(row);
        return route.fulfill({ json: row });
      }
      assert.equal(route.request().method(), "GET");
      await route.fulfill({ json: rows });
    });
    await page.route("**/api/runtime/v1/presets/*", async (route) => {
      assert.equal(route.request().method(), "PATCH");
      const id = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/").at(-1),
      );
      const row = rows.find((row) => row.id === id);
      Object.assign(row, route.request().postDataJSON());
      await route.fulfill({ json: row });
    });
  }
  await login(page);
  const butler = page.getByRole("radio", { name: "AI管家", exact: true });
  await butler.waitFor();
  assert.equal(
    await butler.locator(".workagent-assistant-avatar").textContent(),
    "✨",
  );
  let section = await openSettingsSection(page, "助手");
  await section
    .getByRole("button", { name: "更换AI管家头像", exact: true })
    .waitFor();
  if (fixture) {
    const form = section.locator("form");
    await form.locator('[name="name"]').fill("头像验证助手");
    await form.locator('[name="engine"]').selectOption("codex");
    await form.getByRole("button", { name: "使用🦊头像", exact: true }).click();
    await form.getByRole("button", { name: "创建助手", exact: true }).click();
    let card = section.locator("article", { hasText: "头像验证助手" });
    await card.waitFor();
    assert.equal(
      rows.find((row) => row.id === "avatar-fixture").avatar,
      "emoji:🦊",
    );
    await card.getByRole("button", { name: "更换头像" }).click();
    const bytes = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 200;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#7259d8";
      ctx.fillRect(0, 0, 320, 200);
      ctx.fillStyle = "#fff";
      ctx.font = "100px sans-serif";
      ctx.fillText("A", 125, 140);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await card
      .locator('input[type="file"]')
      .setInputFiles({
        name: "avatar.png",
        mimeType: "image/png",
        buffer: Buffer.from(bytes, "base64"),
      });
    await card.locator('img[src^="data:image/"]').first().waitFor();
    const saved = rows.find((row) => row.id === "avatar-fixture").avatar;
    assert(
      saved.startsWith("data:image/webp;base64,") && saved.length < 65_536,
    );
    await page.reload();
    const radio = page.getByRole("radio", {
      name: "头像验证助手",
      exact: true,
    });
    await radio.locator('img[src^="data:image/"]').waitFor();
    await radio.click();
    await page.screenshot({ path: join(evidence, "home-avatar.png") });
    section = await openSettingsSection(page, "助手");
    card = section.locator("article", { hasText: "头像验证助手" });
    await card.getByRole("button", { name: "编辑", exact: true }).click();
    await section
      .locator("form")
      .getByRole("button", { name: "保存助手", exact: true })
      .click();
    assert.equal(rows.find((row) => row.id === "avatar-fixture").avatar, saved);
    await card.getByRole("button", { name: "更换头像" }).click();
    await card.getByRole("button", { name: "恢复默认", exact: true }).click();
    await card.getByRole("button", { name: "恢复默认", exact: true }).waitFor();
    await page.waitForFunction(
      () => !document.querySelector('article:has(input[type="file"]) img'),
    );
    assert.equal(rows.find((row) => row.id === "avatar-fixture").avatar, null);
    report.checks.push(
      "create with emoji; upload and resize image; reload; edit preserves avatar; reset to initials",
    );
  }
  await section
    .getByRole("button", { name: "更换AI管家头像", exact: true })
    .click();
  const builtin = section.locator("article", { hasText: "AI管家" });
  await builtin
    .getByRole("button", { name: "上传头像", exact: true })
    .waitFor();
  if (fixture) {
    await builtin
      .getByRole("button", { name: "使用🐼头像", exact: true })
      .click();
    await page.waitForFunction(() =>
      [
        ...document.querySelectorAll("article .workagent-assistant-avatar"),
      ].some((node) => node.textContent === "🐼"),
    );
    assert.equal(
      rows.find((row) => row.id === "builtin-puxin-butler").avatar,
      "emoji:🐼",
    );
  }
  await builtin.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, "avatar-settings.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await builtin.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, "avatar-settings-mobile.png") });
  assert(
    await builtin.evaluate(
      (node) => node.getBoundingClientRect().right <= innerWidth + 1,
    ),
  );
  report.checks.push(
    "builtin avatar controls; distinct AI管家 identity; desktop and mobile layout",
  );
  assert.deepEqual(report.errors, []);
  report.status = "passed";
} finally {
  await browser.close();
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify(report, null, 2));
