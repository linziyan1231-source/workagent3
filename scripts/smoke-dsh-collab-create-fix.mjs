import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { login, baseURL } from "./smoke-dsh-helpers.mjs";

// Production acceptance for collab-create-fix: with the REAL deployed bundle
// (no client.js override), mobile viewport, open the collaboration "+"
// create-project dialog and type a project name character by character.
// Regression: ReferenceError: assistant is not defined unmounted the whole
// collaboration sidebar on the first keystroke. No backend writes are made:
// the dialog is closed with Escape without submitting.
const out = resolve(
  process.env.WORKAGENT_COLLAB_EVIDENCE_DIR || ".cache/collab-create-fix/browser",
);
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await login(page);
  assert(baseURL, "baseURL required");
  await page.setViewportSize({ width: 390, height: 844 });
  // Prove the served bundle is the fixed one.
  const deployed = await page.request.get(
    `${baseURL}/plugins/@workagent/dsh-client/client.js`,
  );
  const text = await deployed.text();
  assert(
    !text.includes("assistant.assistant_id && !assistant.model_id"),
    "deployed client.js still contains the buggy assistant expression",
  );
  assert(
    text.includes("disabled: busy || !name.trim(),"),
    "deployed client.js does not contain the fixed disabled expression",
  );
  const expand = page.getByRole("button", { name: "打开侧边栏", exact: true });
  if (await expand.count()) await expand.click();
  const nav = page.getByRole("navigation", { name: "工作区分类" });
  await nav.getByRole("button", { name: "协作", exact: true }).click();
  const createButton = page
    .getByRole("button", { name: "新建协作项目", exact: true })
    .last();
  await createButton.waitFor();
  // Close any transient sidebar menu that may overlap the button on mobile.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  try {
    await createButton.click({ timeout: 8000 });
  } catch {
    await createButton.dispatchEvent("click");
  }
  const dialog = page.getByRole("dialog", {
    name: "新建协作项目",
    exact: true,
  });
  const input = dialog.getByLabel("共享项目名称", { exact: true });
  await input.click();
  await input.pressSequentially("协作修复验收", { delay: 120 });
  await page.waitForTimeout(500);
  // The regression: typing threw ReferenceError and the error boundary
  // unmounted the whole collaboration view. Dialog must stay alive.
  await dialog.waitFor();
  assert.deepEqual(errors, []);
  const submit = dialog.getByRole("button", { name: "创建项目", exact: true });
  assert(
    await submit.isEnabled(),
    "submit must be enabled once the name is non-empty",
  );
  await page.screenshot({ path: `${out}/mobile-create-dialog.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  assert(
    (await page.getByRole("dialog", { name: "新建协作项目" }).count()) === 0,
    "dialog did not close on Escape",
  );
  // Collaboration sidebar still works after the dialog cycle.
  const reopen = page.getByRole("button", { name: "打开侧边栏", exact: true });
  if (await reopen.count()) await reopen.click();
  await page
    .getByRole("button", { name: "新建协作项目", exact: true })
    .last()
    .waitFor();
  assert.deepEqual(errors, []);
  await writeFile(
    `${out}/report.json`,
    JSON.stringify(
      {
        status: "passed",
        checks: [
          "deployed bundle is the fixed client.js",
          "mobile create-project dialog survives typing the project name",
          "submit enabled with non-empty name",
          "dialog closes cleanly; collaboration sidebar intact",
        ],
        errors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png` });
  await writeFile(
    `${out}/failure.json`,
    JSON.stringify({ message: error.message, errors }, null, 2),
  );
  throw error;
} finally {
  await browser.close();
}
