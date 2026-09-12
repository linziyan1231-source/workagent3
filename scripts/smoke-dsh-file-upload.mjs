import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { baseURL, login } from "./smoke-dsh-helpers.mjs";

// Authenticated UI smoke with in-memory file routes: never modifies production projects.
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const out = `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/${engine}`;
await mkdir(out, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const report = { engine, checks: [], errors: [], uploads: [] };
await page.addInitScript(() => {
  window.__uploadChunkSizes = [];
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    if (body instanceof Blob) window.__uploadChunkSizes.push(body.size);
    return send.call(this, body);
  };
});
const rows = new Map();
const files = [];
page.on("pageerror", (error) => report.errors.push(error.message));
try {
  if (process.env.WORKAGENT_UPLOAD_CANDIDATE) {
    for (const name of ["client.js", "tokens.css"])
      await page.route(`**/plugins/@workagent/dsh-client/${name}*`, (route) =>
        route.fulfill({
          path: `${process.env.WORKAGENT_UPLOAD_CANDIDATE}/${name}`,
          contentType: name.endsWith("css") ? "text/css" : "text/javascript",
        }),
      );
  }
  await page.route(
    /\/api\/runtime\/v1\/workspaces(?:\/|$|\?)/,
    async (route) => {
      const req = route.request(),
        url = new URL(req.url()),
        path = url.pathname;
      let data;
      if (path.endsWith("/workspaces"))
        data = [
          { id: "smoke-upload-one", name: "上传验证项目", scope: "personal" },
          { id: "smoke-upload-two", name: "第二个项目", scope: "personal" },
        ];
      else if (path.endsWith("/uploads")) {
        if (req.method() === "POST") {
          const body = req.postDataJSON();
          if (files.some((file) => file.path === body.path))
            return route.fulfill({
              status: 409,
              json: { error: "文件已存在" },
            });
          data = { ...body, id: `upload-${rows.size}`, offset: 0 };
          rows.set(data.id, data);
        } else data = [...rows.values()];
      } else if (path.endsWith("/complete")) {
        const row = rows.get(path.split("/").at(-2));
        files.push({
          name: row.name,
          path: row.path,
          kind: "file",
          size: row.size,
        });
        report.uploads.push({
          path: row.path,
          size: row.size,
          offset: row.offset,
        });
        rows.delete(row.id);
        data = {};
      } else if (path.includes("/uploads/") && req.method() === "PATCH") {
        data = rows.get(path.split("/").at(-1));
        assert.equal(Number(req.headers()["upload-offset"]), data.offset);
        const blobSize = await page.evaluate(() =>
          window.__uploadChunkSizes.shift(),
        );
        const body = req.postDataBuffer();
        if (engine === "chromium") assert.equal(body.length, blobSize);
        data.offset += blobSize;
      } else if (path.endsWith("/files")) {
        const directory = url.searchParams.get("path") || "";
        data =
          directory === "资料"
            ? files.filter((file) => file.path.startsWith("资料/"))
            : [
                { name: "资料", path: "资料", kind: "directory" },
                ...files.filter((file) => !file.path.includes("/")),
              ];
      } else if (path.endsWith("/smoke-upload-one"))
        data = {
          id: "smoke-upload-one",
          name: "上传验证项目",
          scope: "personal",
        };
      else return route.fallback();
      await route.fulfill({ json: data });
    },
  );
  await login(page);
  await page
    .getByRole("combobox", { name: "个人项目" })
    .selectOption("smoke-upload-one");
  await page.getByLabel("输入消息", { exact: true }).waitFor();
  const fileInput = page.getByLabel("选择会话附件");
  await fileInput.waitFor({ state: "attached" });
  await drop("body", [
    { name: "脚本.py", body: "print(1)", type: "" },
    {
      name: "报告.docx",
      body: "document",
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  ]);
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="输入消息"]')
      ?.textContent.includes("报告.docx"),
  );
  assert.equal(
    await page.getByText("当前无法添加图片", { exact: true }).count(),
    0,
  );
  assert.equal(report.uploads.length, 2);
  assert(
    report.uploads.every(
      (row) =>
        !row.path.includes("/") && row.offset === row.size,
    ),
  );
  report.checks.push(
    "homepage document-level drag accepts .py and .docx once, inserts saved attachment paths",
  );
  await drop(".workagent-hero-composer", [
    { name: "图片.png", body: "image", type: "image/png" },
  ]);
  await page.waitForFunction(() =>
    document
      .querySelector('[aria-label="输入消息"]')
      ?.textContent.includes("图片.png"),
  );
  report.checks.push("composer drop accepts images");
  await page.getByRole("button", { name: "管理项目", exact: true }).click();
  await page
    .getByRole("button", { name: "管理文件", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "资料", exact: true }).waitFor();
  assert(
    await page.evaluate(() => {
      const cards = document.querySelectorAll(".workagent-workspace-card"),
        files = document.querySelector(".workagent-file-browser");
      return (
        cards[0].nextElementSibling === files &&
        files.nextElementSibling === cards[1]
      );
    }),
  );
  await page.getByLabel("选择项目上传文件").setInputFiles({
    name: "选择上传.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("chooser"),
  });
  await page
    .getByRole("button", { name: "选择上传.txt", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "资料", exact: true }).click();
  await page.getByText("此文件夹还没有文件", { exact: true }).waitFor();
  await drop(".workagent-file-browser", [
    { name: "拖入报告.docx", body: "folder-document", type: "" },
  ]);
  await page
    .getByRole("button", { name: "拖入报告.docx", exact: true })
    .waitFor();
  assert(
    report.uploads.some(
      (row) => row.path === "资料/拖入报告.docx" && row.offset === row.size,
    ),
  );
  await drop(".workagent-file-browser", [
    { name: "拖入报告.docx", body: "conflict", type: "" },
  ]);
  await page.getByRole("alert").filter({ hasText: "文件已存在" }).waitFor();
  report.checks.push(
    "project chooser, folder drop, complete byte count, and non-overwriting conflict feedback",
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    // Let the responsive sidebar effect and its transition finish before toggling.
    await page.waitForTimeout(350);
    if (width === 390) {
      const sidebar = page.locator(".hHd-Xa_root");
      if (!(await sidebar.getAttribute("class")).includes("hHd-Xa_collapsed"))
        await page.locator(".hHd-Xa_toggle").click();
      await page
        .getByRole("button", { name: "上传文件", exact: true })
        .click({ trial: true });
    }
    await page.screenshot({
      path: `${out}/project-${width}.png`,
      fullPage: true,
    });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
  }
  report.checks.push(
    "details follow selected project; desktop/mobile have no horizontal overflow",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    localStorage.setItem("workagent.files.open", "true");
    localStorage.setItem("workagent.hero.workspace", "smoke-upload-one");
  });
  if (
    (await page.locator(".hHd-Xa_root").getAttribute("class")).includes(
      "hHd-Xa_collapsed",
    )
  )
    await page.locator(".hHd-Xa_toggle").click();
  await page
    .getByRole("button", { name: "返回首页", exact: true })
    .evaluate((button) => button.click());
  await page.getByLabel("选择上传文件", { exact: true }).setInputFiles({
    name: "侧边上传.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("sidebar"),
  });
  await page.getByText("已上传 1 个文件", { exact: true }).waitFor();
  assert(
    report.uploads.some(
      (row) =>
        row.path === "侧边上传.txt" && row.size === 7 && row.offset === 7,
    ),
  );
  await page
    .getByTitle("上传文件 · 单个最大 5 GB，也可拖入文件", { exact: true })
    .waitFor();
  report.checks.push(
    "sidebar uses the shared uploader and displays the 5 GB policy",
  );
  assert.equal(report.errors.length, 0);
  await writeFile(`${out}/upload-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png`, fullPage: true });
  console.log(
    JSON.stringify({
      report,
      forms: await page.locator("form").evaluateAll((els) =>
        els.map((el) => ({
          className: el.className,
          inputs: [...el.querySelectorAll("input,textarea")].map((x) => ({
            label: x.getAttribute("aria-label"),
            value: x.value,
          })),
        })),
      ),
    }),
  );
  throw error;
} finally {
  await browser.close();
}

async function drop(selector, input) {
  await page
    .locator(selector)
    .first()
    .evaluate((el, input) => {
      const transfer = new DataTransfer();
      for (const file of input)
        transfer.items.add(
          new File([file.body], file.name, { type: file.type }),
        );
      for (const type of ["dragenter", "dragover", "drop"])
        el.dispatchEvent(
          new DragEvent(type, {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
          }),
        );
    }, input);
}
