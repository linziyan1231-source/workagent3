import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { login, json } from "./smoke-dsh-helpers.mjs";
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const out = `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/${engine}`;
await mkdir(out, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 780 } });
const report = { checks: [], errors: [] };
let created;
page.on("pageerror", (e) => report.errors.push(e.message));
await page.addInitScript(() => {
  localStorage.setItem("workagent.files.open", "false");
  localStorage.setItem("workagent.font-size", "14");
});
for (const [env, file, type] of [
  ["WORKAGENT_SMOKE_CLIENT", "client.js", "text/javascript"],
  ["WORKAGENT_SMOKE_CSS", "tokens.css", "text/css"],
])
  if (process.env[env]) {
    const body = await readFile(process.env[env], "utf8");
    await page.route(`**/plugins/@workagent/dsh-client/${file}*`, (r) =>
      r.fulfill({ contentType: type, body }),
    );
  }
const boxes = () =>
  page.evaluate(() =>
    Object.fromEntries(
      [".pXSMma_root", ".workagent-agents", ".workagent-hero-composer"].map(
        (k) => {
          const e = document.querySelector(k);
          return [k, e?.getBoundingClientRect().toJSON()];
        },
      ),
    ),
  );
try {
  await login(page);
  await page.locator(".workagent-hero-composer").waitFor();
  await page.getByRole("radio", { name: "Kimi", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".workagent-model-choice select")?.value,
  );
  await page.waitForTimeout(300);
  for (const width of [390, 320, 1440]) {
    await page.setViewportSize({ width, height: 780 });
    await page.waitForTimeout(400);
    const select = page.locator(".workagent-project-select select");
    await select.selectOption("none");
    await page.waitForTimeout(150);
    const before = await boxes();
    await select.selectOption("new");
    await page.waitForTimeout(150);
    const after = await boxes();
    for (const key in before)
      for (const prop of ["y", "height"])
        assert(
          Math.abs(before[key][prop] - after[key][prop]) < 1,
          JSON.stringify({ width, key, prop, before, after }),
        );
    assert.equal(
      await page
        .locator(".workagent-hero-composer")
        .getByText("创建项目")
        .count(),
      0,
    );
    assert(
      await page
        .getByRole("button", { name: "创建项目", exact: true })
        .isVisible(),
    );
    report.checks.push({ width, before, after });
    await page.screenshot({ path: `${out}/home-${width}.png` });
  }
  await page
    .getByRole("textbox", { name: "新项目名称" })
    .fill(`布局验收-${engine}-${Date.now()}`);
  const beforeCreate = await boxes();
  const post = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/runtime/v1/workspaces") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  const response = await post;
  assert(response.ok());
  created = (await response.json()).id;
  await page.locator(".workagent-project-draft").waitFor({ state: "detached" });
  const afterCreate = await boxes();
  for (const key in beforeCreate)
    assert(
      Math.abs(beforeCreate[key].y - afterCreate[key].y) < 1,
      JSON.stringify({ beforeCreate, afterCreate }),
    );
  report.checks.push({ created: true });
  await page.getByRole("button", { name: "打开文件侧栏", exact: true }).click();
  await page.locator(".workagent-files-project").selectOption(created);
  await page.locator(".workagent-file-toolbar").waitFor();
  assert.equal(await page.locator(".workagent-upload-sessions").count(), 0);
  assert.equal(
    await page
      .getByText("拖入文件上传 · 单个最大 5 GB", { exact: true })
      .count(),
    0,
  );
  await page
    .getByLabel("选择上传文件", { exact: true })
    .setInputFiles({
      name: "layout-check.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("layout smoke"),
    });
  await page.getByText("layout-check.txt", { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/files.png` });
  report.checks.push({ upload: true });
  const pending = await json(
    page,
    `/api/runtime/v1/workspaces/${created}/uploads`,
    {
      method: "POST",
      body: JSON.stringify({
        path: "pending.txt",
        name: "pending.txt",
        size: 4,
        lastModified: 1,
      }),
    },
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event("workagent:files-changed")),
  );
  await page.locator(".workagent-upload-sessions summary").click();
  await page.getByText("pending.txt", { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/pending.png` });
  await page.getByRole("button", { name: "取消上传", exact: true }).click();
  await page
    .locator(".workagent-upload-sessions")
    .waitFor({ state: "detached" });
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(400);
  const panel = page.getByRole("complementary", { name: "项目文件侧栏" });
  await page.screenshot({ path: `${out}/files-mobile.png` });
  assert(
    await page
      .getByRole("button", { name: "上传文件", exact: true })
      .isVisible(),
  );
  report.checks.push({ pendingCancelled: true });
  report.resizeObserverWarnings = report.errors.filter(
    (e) =>
      e === "ResizeObserver loop completed with undelivered notifications.",
  );
  assert.deepEqual(
    report.errors.filter((e) => !report.resizeObserverWarnings.includes(e)),
    [],
  );
  console.log(
    JSON.stringify({ checks: report.checks.length, errors: report.errors }),
  );
} catch (e) {
  report.failure = e.message;
  report.dom = await page
    .locator(".wSkVaW_composerHero")
    .evaluate((el) => ({
      html: el.outerHTML.slice(0, 9000),
      nodes: [el, ...el.querySelectorAll("*")]
        .slice(0, 20)
        .map((e) => ({
          cls: e.className,
          rect: e.getBoundingClientRect().toJSON(),
          css: {
            height: getComputedStyle(e).height,
            minHeight: getComputedStyle(e).minHeight,
            flex: getComputedStyle(e).flex,
            padding: getComputedStyle(e).padding,
            position: getComputedStyle(e).position,
          },
        })),
    }));
  await page.screenshot({ path: `${out}/failure.png` });
  throw e;
} finally {
  if (created)
    await json(page, `/api/runtime/v1/workspaces/${created}`, {
      method: "DELETE",
    }).catch((e) => (report.cleanupError = e.message));
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
