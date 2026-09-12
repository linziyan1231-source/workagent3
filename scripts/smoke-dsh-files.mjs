import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseURL, json, uniqueName, withPage } from "./smoke-dsh-helpers.mjs";

await withPage(
  async (page) => {
    const evidence = process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR;
    if (evidence) await mkdir(evidence, { recursive: true });
    const localAssets = process.env.WORKAGENT_SMOKE_LOCAL_ASSETS === "1";
    if (localAssets) {
      const css = await page
        .locator("#workagent-dsw-tokens")
        .getAttribute("href");
      for (const [url, path, contentType] of [
        [css, "packages/dsh-client-workagent/tokens.css", "text/css"],
        [
          css.replace("tokens.css", "client.js"),
          "packages/dsh-client-workagent/client.js",
          "application/javascript",
        ],
      ])
        await page.route(
          (u) => u.pathname === new URL(url, baseURL).pathname,
          (route) => route.fulfill({ path, contentType }),
        );
    }
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const workspace = await json(page, "/api/runtime/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: uniqueName("文件侧栏验收") }),
    });
    const root = `/api/runtime/v1/workspaces/${workspace.id}`;
    const contentURL = (path) =>
      `${baseURL}${root}/content?path=${encodeURIComponent(path)}`;
    const put = async (path, data) => {
      const result = await page.request.put(contentURL(path), {
        data,
        headers: { Origin: new URL(baseURL).origin },
      });
      assert.equal(result.status(), 200);
    };
    const screenshot = async (name) => {
      if (evidence) await page.screenshot({ path: join(evidence, name) });
    };
    let session;
    try {
      const pdfObjects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        "<< /Length 49 >>\nstream\nBT /F1 18 Tf 30 330 Td (File preview test) Tj ET\nendstream",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      ];
      let pdf = "%PDF-1.4\n";
      const offsets = [0];
      for (const [index, object] of pdfObjects.entries()) {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
      }
      const xref = Buffer.byteLength(pdf);
      pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      await put("预览.pdf", Buffer.from(pdf));
      await put(
        "说明.md",
        "# 项目资料\n\n这里是 **文件预览**，可以一边对话一边查看。\n\n- 整理资料\n- 输出报告",
      );
      await put("资料/原稿.txt", "中文文件内容");
      await put(
        "网页.html",
        '<h1>安全的网页预览</h1><script>parent.document.body.dataset.filePreviewUnsafe="yes"</script>',
      );
      await put(
        "图像.png",
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${baseURL}/?frontend=dsh&project=${workspace.id}`);
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page
        .getByRole("dialog", { name: "设置", exact: true })
        .getByRole("button", { name: "云瓷白", exact: true })
        .click();
      await page.goto(`${baseURL}/?frontend=dsh&project=${workspace.id}`);
      const open = page.getByRole("button", {
        name: "打开文件侧栏",
        exact: true,
      });
      if (await open.count()) await open.click();
      const panel = page.getByRole("complementary", { name: "项目文件侧栏" });
      const backToFiles = () =>
        panel
          .getByRole("button", { name: "返回文件列表", exact: true })
          .click();
      await panel.getByRole("button", { name: "说明.md", exact: true }).click();
      await panel
        .getByRole("heading", { name: "项目资料", exact: true })
        .waitFor();
      await screenshot("files-desktop-markdown.png");
      const mainBounds = await page.locator(".wSkVaW_root").boundingBox();
      const panelBounds = await panel.boundingBox();
      assert.ok(
        mainBounds.x + mainBounds.width <= panelBounds.x + 1,
        "File panel covers the desktop chat",
      );
      await backToFiles();
      await panel.getByRole("button", { name: "资料", exact: true }).click();
      await panel
        .getByRole("button", { name: "原稿.txt", exact: true })
        .click();
      await panel.getByText("中文文件内容", { exact: true }).waitFor();
      await backToFiles();
      await panel
        .getByRole("button", { name: "操作 原稿.txt", exact: true })
        .click();
      await panel.getByRole("button", { name: "重命名", exact: true }).click();
      await panel
        .getByRole("textbox", { name: "文件名", exact: true })
        .fill("定稿.txt");
      await panel.getByRole("button", { name: "保存", exact: true }).click();
      await panel
        .getByRole("button", { name: "定稿.txt", exact: true })
        .waitFor();
      assert.equal(
        await (await page.request.get(contentURL("资料/定稿.txt"))).text(),
        "中文文件内容",
      );
      await panel
        .getByRole("button", { name: "定稿.txt", exact: true })
        .click();
      const downloading = page.waitForEvent("download");
      await panel
        .getByRole("link", { name: "下载 定稿.txt", exact: true })
        .click();
      const download = await downloading;
      assert.equal(
        await readFile(await download.path(), "utf8"),
        "中文文件内容",
      );
      await backToFiles();
      await panel.getByLabel("选择上传文件").setInputFiles({
        name: "上传.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("upload preserved"),
      });
      await panel
        .getByRole("button", { name: "上传.txt", exact: true })
        .waitFor();
      assert.equal(
        await (await page.request.get(contentURL("资料/上传.txt"))).text(),
        "upload preserved",
      );
      if (!localAssets) {
        await panel.getByLabel("选择上传文件").setInputFiles({
          name: "上传.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("must not overwrite"),
        });
        await panel
          .getByRole("alert")
          .filter({ hasText: "同名文件已存在" })
          .waitFor();
        assert.equal(
          await (await page.request.get(contentURL("资料/上传.txt"))).text(),
          "upload preserved",
        );
      }
      await panel.getByRole("button", { name: "根目录", exact: true }).click();
      await panel
        .getByRole("button", { name: "新建文件夹", exact: true })
        .click();
      await panel
        .getByRole("textbox", { name: "文件名", exact: true })
        .fill("归档");
      await panel.getByRole("button", { name: "保存", exact: true }).click();
      await panel.getByRole("button", { name: "归档", exact: true }).waitFor();
      await panel
        .getByRole("button", { name: "操作 定稿.txt", exact: true })
        .click();
      await panel.getByRole("button", { name: "移动到…", exact: true }).click();
      const chooser = panel.getByRole("dialog", { name: "移动到文件夹" });
      await chooser
        .getByRole("button", { name: "📁 归档", exact: true })
        .click();
      await chooser
        .getByRole("button", { name: "移动到这里", exact: true })
        .click();
      await panel
        .getByRole("button", { name: "操作 定稿.txt", exact: true })
        .click();
      await panel.getByRole("button", { name: "重命名", exact: true }).click();
      await panel
        .getByRole("textbox", { name: "文件名", exact: true })
        .fill("最终稿.txt");
      await panel.getByRole("button", { name: "保存", exact: true }).click();
      const archiveFolder = panel.getByRole("button", { name: "归档", exact: true });
      if (await archiveFolder.getAttribute("aria-expanded") === "true") await archiveFolder.click();
      await archiveFolder.click();
      await panel
        .getByRole("button", { name: "最终稿.txt", exact: true })
        .waitFor();
      await panel
        .getByRole("button", { name: "新建文件", exact: true })
        .click();
      await panel
        .getByRole("textbox", { name: "文件名", exact: true })
        .fill("新文件.txt");
      await panel.getByRole("button", { name: "保存", exact: true }).click();
      await panel
        .getByRole("button", { name: "新文件.txt", exact: true })
        .waitFor();
      await panel
        .getByRole("button", { name: "操作 新文件.txt", exact: true })
        .click();
      await panel.getByRole("button", { name: "删除", exact: true }).click();
      await panel
        .getByRole("button", { name: "确认删除", exact: true })
        .click();
      await panel
        .getByRole("button", { name: "新文件.txt", exact: true })
        .waitFor({ state: "detached" });
      await panel
        .getByRole("button", { name: "预览.pdf", exact: true })
        .click();
      const pdfFrame = panel.locator('iframe[title="预览.pdf"]');
      await pdfFrame.waitFor();
      const pdfResponse = await page.request.get(
        new URL(await pdfFrame.getAttribute("src"), baseURL).href,
      );
      assert.equal(pdfResponse.status(), 200);
      assert.equal(pdfResponse.headers()["content-type"], "application/pdf");
      await page.waitForTimeout(1500);
      await screenshot("files-pdf.png");
      await backToFiles();
      await panel
        .getByRole("button", { name: "网页.html", exact: true })
        .click();
      await panel
        .frameLocator('iframe[title="网页.html"]')
        .getByRole("heading", { name: "安全的网页预览" })
        .waitFor();
      assert.equal(
        await panel
          .locator('iframe[title="网页.html"]')
          .getAttribute("sandbox"),
        "",
      );
      assert.equal(
        await page.locator("body").getAttribute("data-file-preview-unsafe"),
        null,
      );
      await backToFiles();
      await panel
        .getByRole("button", { name: "图像.png", exact: true })
        .click();
      await panel.getByRole("img", { name: "图像.png", exact: true }).waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector(".workagent-file-preview-body img")
            ?.naturalWidth === 1,
      );
      await panel
        .getByRole("button", { name: "关闭文件侧栏", exact: true })
        .click();
      await page.reload();
      await page
        .getByRole("button", { name: "打开文件侧栏", exact: true })
        .click();
      await panel.waitFor();
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page
        .getByRole("dialog", { name: "设置", exact: true })
        .getByRole("button", { name: "石墨黑", exact: true })
        .click();
      await page.goto(`${baseURL}/?frontend=dsh&project=${workspace.id}`);
      await panel.getByRole("button", { name: "说明.md", exact: true }).click();
      await panel
        .getByRole("heading", { name: "项目资料", exact: true })
        .waitFor();
      await screenshot("files-desktop-dark.png");
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      );
      await screenshot("files-mobile.png");
      await panel
        .getByRole("button", { name: "关闭文件侧栏", exact: true })
        .click();
      await page.setViewportSize({ width: 1440, height: 900 });
      session = await json(page, "/api/runtime/v1/sessions", {
        method: "POST",
        body: JSON.stringify({
          engine: "codex",
          title: "文件侧栏会话验收",
          workspace: workspace.id,
          presetId: "builtin-codex",
        }),
      });
      await page.goto(
        `${baseURL}/?frontend=dsh&session=${encodeURIComponent(session.id)}`,
      );
      await page
        .getByRole("button", { name: "打开文件侧栏", exact: true })
        .click();
      await panel.getByText(workspace.name, { exact: true }).waitFor();
      await panel.getByRole("button", { name: "说明.md", exact: true }).click();
      await panel
        .getByRole("heading", { name: "项目资料", exact: true })
        .waitFor();
      assert.equal(
        await panel.getByRole("combobox", { name: "文件侧栏项目" }).count(),
        0,
      );
      const notification = await page
        .locator(".workagent-top-actions .workagent-top-notifications")
        .boundingBox();
      const fileToggle = await page
        .locator(".workagent-files-toggle")
        .boundingBox();
      const iconGap = fileToggle.x - notification.x - notification.width;
      assert(
        iconGap >= 0 && iconGap <= 16,
        "Conversation file icon must be immediately right of notifications",
      );
      await screenshot("files-conversation.png");
      const chat = await page.locator(".workagent-overlay").boundingBox();
      assert.ok(chat.x + chat.width <= (await panel.boundingBox()).x + 1);
      assert.deepEqual(errors, []);
      if (evidence)
        await writeFile(
          join(evidence, "files-report.json"),
          JSON.stringify(
            {
              localAssets,
              upload: true,
              noOverwrite: !localAssets,
              create: true,
              rename: true,
              move: true,
              delete: true,
              download: true,
              markdown: true,
              pdf: true,
              image: true,
              sandboxedHTML: true,
              sessionProject: true,
              desktop: true,
              dark: true,
              mobile: true,
            },
            null,
            2,
          ),
        );
    } finally {
      if (session)
        await json(page, `/api/runtime/v1/sessions/${session.id}`, {
          method: "DELETE",
        });
      await json(page, root, { method: "DELETE" });
    }
  },
  { channel: "chromium" },
);
console.log("DSH right file sidebar smoke passed");
