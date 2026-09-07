import { withPage, baseURL, json } from "./smoke-dsh-helpers.mjs";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
const evidence = process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR || ".cache";
mkdirSync(evidence, { recursive: true });
const require = createRequire(
  new URL("../packages/dsh-client-workagent/package.json", import.meta.url),
);
await withPage(
  async (page) => {
    const workspace = await json(page, "/api/runtime/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "文档预览验收-" + Date.now() }),
    });
    const zip = new (require("jszip"))();
    zip.file(
      "_rels/.rels",
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    );
    zip.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>中文与 Word 文档预览。</w:t></w:r></w:p><w:p><w:r><w:t>Lorem ipsum dolor sit amet.</w:t></w:r></w:p></w:body></w:document>',
    );
    const upload = await page.request.put(
      baseURL +
        "/api/runtime/v1/workspaces/" +
        workspace.id +
        "/content?path=" +
        encodeURIComponent("预览验收.docx"),
      {
        headers: { Origin: baseURL },
        data: await zip.generateAsync({ type: "nodebuffer" }),
      },
    );
    assert.equal(upload.status(), 200);
    try {
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") console.log("browser", m.text());
      });
      if (process.env.WORKAGENT_SMOKE_LOCAL_ASSETS === "1") {
        const assets = {
          "client.js": "packages/dsh-client-workagent/client.js",
          "tokens.css": "packages/dsh-client-workagent/tokens.css",
          "document-preview.html":
            "packages/dsh-client-workagent/document-preview.html",
          "docx-preview.js": require.resolve("docx-preview"),
          "jszip.js": join(
            dirname(require.resolve("jszip/package.json")),
            "dist/jszip.min.js",
          ),
        };
        await page.route(
          "**/plugins/@workagent/dsh-client/*",
          async (route) => {
            const name = new URL(route.request().url()).pathname
              .split("/")
              .pop();
            if (assets[name])
              await route.fulfill({
                body: readFileSync(assets[name]),
                contentType: name.endsWith("css")
                  ? "text/css"
                  : name.endsWith("html")
                    ? "text/html"
                    : "text/javascript",
              });
            else await route.continue();
          },
        );
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(baseURL + "/?frontend=dsh&project=" + workspace.id + "");
      await page
        .getByRole("button", { name: "预览验收.docx", exact: true })
        .click();
      const frame = page.frameLocator('iframe[title="预览验收.docx"]');
      await frame.locator("#status").waitFor({ state: "hidden" });
      await frame
        .getByText("中文与 Word 文档预览。", { exact: true })
        .waitFor();
      assert.equal(
        await page.locator(".workagent-files-toggle").innerText(),
        "",
      );
      const n = await page
          .locator(".workagent-top-notifications")
          .boundingBox(),
        f = await page.locator(".workagent-files-toggle").boundingBox();
      assert(f.x > n.x + n.width && f.x - n.x - n.width <= 16);
      await page.screenshot({ path: join(evidence, "preview-docx-fit.png") });
      const pane = page.locator(".workagent-files-panel");
      const old = await pane.boundingBox();
      const handle = await page
        .getByRole("separator", { name: "调整文件栏宽度" })
        .boundingBox();
      await page.mouse.move(handle.x + 4, handle.y + 150);
      await page.mouse.down();
      await page.mouse.move(handle.x - 160, handle.y + 150, { steps: 12 });
      await page.mouse.up();
      assert((await pane.boundingBox()).width > old.width + 120);
      const preview = page.locator(".workagent-file-preview-pane");
      const bounds = await preview.boundingBox();
      assert(
        bounds.y <= 1 && bounds.height >= 998,
        "Preview must occupy the entire sidebar",
      );
      assert.equal(
        await page
          .getByRole("button", { name: "预览验收.docx", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page.locator(".workagent-files-project").isVisible(),
        false,
      );
      assert.equal(
        await page.getByRole("separator", { name: "调整预览区高度" }).count(),
        0,
      );
      await page
        .getByRole("button", { name: "最大化文件预览", exact: true })
        .click();
      assert((await preview.boundingBox()).width > 1300);
      await frame.locator("#zoom").selectOption("1");
      await page.screenshot({ path: join(evidence, "preview-docx-full.png") });
      const styles = await frame.locator("section.docx p").evaluateAll((es) =>
        es.map((e) => ({
          text: e.textContent,
          letterSpacing: getComputedStyle(e).letterSpacing,
          fontSize: getComputedStyle(e).fontSize,
        })),
      );
      assert(styles.every((style) => style.letterSpacing === "normal"));
      const originalPage = await frame.locator("section.docx").boundingBox();
      await frame.locator("#zoom").selectOption("1.5");
      const enlargedPage = await frame.locator("section.docx").boundingBox();
      assert(Math.abs(enlargedPage.width / originalPage.width - 1.5) < 0.01);
      assert.equal(
        await frame
          .locator("section.docx p")
          .first()
          .evaluate((e) => getComputedStyle(e).fontSize),
        styles[0].fontSize,
      );
      writeFileSync(
        join(evidence, "preview-report.json"),
        JSON.stringify(
          {
            localAssets: process.env.WORKAGENT_SMOKE_LOCAL_ASSETS === "1",
            styles,
            zoom: true,
            iconOrder: true,
            widthResize: true,
            fullSidebar: true,
            maximize: true,
          },
          null,
          2,
        ),
      );
      await page
        .getByRole("button", { name: "还原文件预览", exact: true })
        .click();
      await page.getByRole("button", { name: "返回文件列表" }).click();
      await page
        .getByRole("button", { name: "预览验收.docx", exact: true })
        .waitFor();
      assert.equal(await preview.count(), 0);
      await page.reload();
      assert((await pane.boundingBox()).width > old.width + 120);
      assert.deepEqual(errors, []);
      console.log(
        "PASS Word, icon order, width drag and full sidebar, maximize, persisted width; localAssets=" +
          process.env.WORKAGENT_SMOKE_LOCAL_ASSETS,
      );
    } finally {
      await json(page, "/api/runtime/v1/workspaces/" + workspace.id, {
        method: "DELETE",
      });
    }
  },
  { channel: "chromium" },
);
