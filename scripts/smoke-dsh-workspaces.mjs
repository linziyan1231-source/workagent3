import { baseURL, json, uniqueName, withPage } from "./smoke-dsh-helpers.mjs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

await withPage(async (page) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const screenshotDir = process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR;
  const screenshot = async (name) => {
    if (!screenshotDir) return;
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: join(screenshotDir, name), fullPage: true });
  };
  const workspace = await json(page, "/api/runtime/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: uniqueName("项目文件验收") }),
  });
  const root = `/api/runtime/v1/workspaces/${encodeURIComponent(workspace.id)}`;
  const put = async (path, bytes, contentType) => {
    const response = await page.request.put(
      `${baseURL}${root}/content?path=${encodeURIComponent(path)}`,
      {
        data: bytes,
        headers: {
          "Content-Type": contentType,
          Origin: new URL(baseURL).origin,
        },
      },
    );
    if (!response.ok())
      throw new Error(`fixture ${path} returned ${response.status()}`);
  };
  let session;
  try {
    await put(
      "notes.txt",
      Buffer.from("workspace smoke text 中文下载验证"),
      "text/plain",
    );
    await put(
      "pixel.png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
      "image/png",
    );
    await put(
      "sample.pdf",
      Buffer.from(
        "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF",
      ),
      "application/pdf",
    );
    await json(page, `${root}/directories`, {
      method: "POST",
      body: JSON.stringify({ path: "资料" }),
    });
    await put("资料/原稿.txt", Buffer.from("nested content"), "text/plain");
    await page.goto(`${baseURL}/?frontend=dsh&workagent=workspaces`);
    const dialog = page.getByRole("dialog", { name: "项目", exact: true });
    await dialog.getByLabel("搜索项目", { exact: true }).fill(workspace.name);
    const card = dialog.locator("article", { hasText: workspace.name });
    await card.waitFor();
    if (await dialog.getByLabel("新项目名称", { exact: true }).count())
      throw new Error("Create field is visible by default");
    if ((await dialog.locator("article").count()) !== 1)
      throw new Error("Project search did not filter");
    await dialog
      .getByLabel("搜索项目", { exact: true })
      .fill("no-project-with-this-name");
    await dialog.getByText("没有找到匹配的项目", { exact: true }).waitFor();
    await dialog
      .getByRole("button", { name: "清除项目搜索", exact: true })
      .click();
    await dialog.getByRole("button", { name: "新建项目", exact: true }).click();
    const nameInput = dialog.getByLabel("新项目名称", { exact: true });
    await nameInput.fill(uniqueName("取消创建"));
    if (!(await nameInput.evaluate((el) => el === document.activeElement)))
      throw new Error("Create field not focused");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    if (await nameInput.count())
      throw new Error("Cancel did not close create field");
    await screenshot("projects-search-toolbar.png");
    await card.getByRole("button", { name: "管理文件", exact: true }).click();
    await dialog
      .getByRole("button", { name: "预览 notes.txt", exact: true })
      .click();
    await dialog
      .getByText("workspace smoke text 中文下载验证", { exact: true })
      .waitFor();
    await dialog
      .getByLabel("搜索项目", { exact: true })
      .fill("no-match-preview");
    await dialog.getByText("没有找到匹配的项目", { exact: true }).waitFor();
    if (
      await dialog
        .getByText("workspace smoke text 中文下载验证", { exact: true })
        .count()
    )
      throw new Error("Search left a preview from a hidden project");
    await dialog
      .getByRole("button", { name: "清除项目搜索", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "预览 pixel.png", exact: true })
      .click();
    await dialog.locator('img[alt="pixel.png"]').waitFor();
    await dialog
      .getByRole("button", { name: "预览 sample.pdf", exact: true })
      .click();
    const frame = dialog.locator('iframe[title="sample.pdf"]');
    await frame.waitFor();
    const pdf = await page.request.get(
      new URL(await frame.getAttribute("src"), baseURL).href,
    );
    if (!pdf.ok()) throw new Error("PDF preview URL failed");
    await dialog.getByRole("button", { name: "关闭预览", exact: true }).click();
    const downloadPromise = page.waitForEvent("download");
    await dialog
      .getByRole("link", { name: "下载 notes.txt", exact: true })
      .click();
    const download = await downloadPromise;
    if (
      download.suggestedFilename() !== "notes.txt" ||
      !(await readFile(await download.path(), "utf8")).includes("中文下载验证")
    )
      throw new Error("Downloaded content or name is incorrect");
    await dialog.getByRole("button", { name: "资料", exact: true }).click();
    await dialog
      .getByRole("button", { name: "重命名 原稿.txt", exact: true })
      .click();
    const rename = page.getByRole("dialog", {
      name: "重命名文件",
      exact: true,
    });
    await rename.getByLabel("文件名").fill("定稿.txt");
    await rename.getByRole("button", { name: "保存", exact: true }).click();
    await dialog
      .getByRole("button", { name: "定稿.txt", exact: true })
      .waitFor();
    const entries = await json(
      page,
      `${root}/files?path=${encodeURIComponent("资料")}`,
    );
    if (entries.length !== 1 || entries[0].path !== "资料/定稿.txt")
      throw new Error("Nested rename did not persist");
    await screenshot("project-files-desktop.png");
    await page.setViewportSize({ width: 390, height: 844 });
    if (await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1))
      throw new Error("Project page overflows on mobile");
    await screenshot("project-files-mobile.png");
    await page.setViewportSize({ width: 1440, height: 900 });
    await dialog
      .getByRole("button", { name: "删除 定稿.txt", exact: true })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: "删除文件",
      exact: true,
    });
    await confirmation
      .getByRole("button", { name: "取消", exact: true })
      .click();
    if (
      !(await json(page, `${root}/files?path=${encodeURIComponent("资料")}`))
        .length
    )
      throw new Error("Cancel deleted the file");
    await dialog
      .getByRole("button", { name: "删除 定稿.txt", exact: true })
      .click();
    await confirmation
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await dialog.getByText("此文件夹还没有文件", { exact: true }).waitFor();
    await dialog
      .getByRole("navigation", { name: "文件路径" })
      .getByRole("button", { name: workspace.name, exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "notes.txt", exact: true })
      .waitFor();
    await screenshot("projects-overview.png");
    await card.getByRole("button", { name: "新建会话", exact: true }).click();
    await page.waitForURL(
      (url) => url.searchParams.get("project") === workspace.id,
    );
    await page.waitForFunction(
      (id) =>
        document.querySelector('select[aria-label="个人项目"]')?.value === id,
      workspace.id,
    );
    if (
      (await page.getByLabel("个人项目", { exact: true }).inputValue()) !==
      workspace.id
    )
      throw new Error("Project card lost project selection");
    await page.getByRole("radio", { name: "Codex", exact: true }).click();
    await page.goto(`${baseURL}/?frontend=dsh`);
    const projectRow = page.locator(".workagent-sidebar-project-row", {
      hasText: workspace.name,
    });
    await projectRow.waitFor();
    await page.mouse.move(1100, 600);
    const plus = projectRow.getByRole("button", {
      name: `在 ${workspace.name} 中新建会话`,
      exact: true,
    });
    if ((await plus.evaluate((el) => getComputedStyle(el).opacity)) !== "0")
      throw new Error("Project plus should be hidden before hover");
    await projectRow.hover();
    if ((await plus.evaluate((el) => getComputedStyle(el).opacity)) !== "1")
      throw new Error("Project plus should appear on hover");
    await page
      .getByRole("button", {
        name: `在 ${workspace.name} 中新建会话`,
        exact: true,
      })
      .click();
    await page.waitForURL(
      (url) => url.searchParams.get("project") === workspace.id,
    );
    await page.waitForFunction(
      (id) =>
        document.querySelector('select[aria-label="个人项目"]')?.value === id,
      workspace.id,
    );
    if (
      (await page.getByLabel("个人项目", { exact: true }).inputValue()) !==
      workspace.id
    )
      throw new Error("Sidebar plus lost project selection");
    await page.getByLabel("模型", { exact: true }).selectOption("gpt-5.6-sol");
    await page
      .getByLabel("输入消息", { exact: true })
      .fill("Reply with exactly PROJECT_READY. Do not use tools.");
    await page.getByLabel("输入消息", { exact: true }).press("Enter");
    await page.waitForURL((url) => url.searchParams.has("session"), {
      timeout: 60000,
    });
    session = new URL(page.url()).searchParams.get("session");
    if (
      (await json(page, `/api/runtime/v1/sessions/${session}`)).workspaceId !==
      workspace.id
    )
      throw new Error("New session is not attached to selected project");
    // This check verifies project routing; native provider availability has a separate smoke.
    await screenshot("project-conversation.png");
    if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
  } finally {
    if (session) {
      await json(page, `/api/runtime/v1/sessions/${session}/cancel`, {
        method: "POST",
      }).catch(() => {});
      await json(page, `/api/runtime/v1/sessions/${session}`, {
        method: "DELETE",
      });
    }
    await json(page, root, { method: "DELETE" });
  }
});
console.log(
  "dsh workspace smoke passed: previews, nested rename, confirmed delete, download, project shortcuts and responsive layout",
);
