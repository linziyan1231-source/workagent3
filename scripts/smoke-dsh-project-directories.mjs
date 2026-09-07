import { baseURL, json, uniqueName, withPage } from "./smoke-dsh-helpers.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

await withPage(async (page) => {
  const name = uniqueName("项目目录验收");
  let project;
  try {
    await page.goto(`${baseURL}/?frontend=dsh&workagent=workspaces`);
    const dialog = page.getByRole("dialog", { name: "项目", exact: true });
    const create = async () => {
      await dialog
        .getByRole("button", { name: "新建项目", exact: true })
        .click();
      await dialog.getByLabel("新项目名称", { exact: true }).fill(name);
      await dialog
        .getByRole("button", { name: "创建项目", exact: true })
        .click();
    };
    await create();
    await dialog.locator("article", { hasText: name }).waitFor();
    project = (await json(page, "/api/runtime/v1/workspaces")).find(
      (p) => p.name === name,
    );
    if (project?.directory !== name)
      throw new Error("Project folder does not match its initial name");
    await create();
    await dialog
      .getByText("工作区中已存在同名文件夹，请换一个项目名称。", {
        exact: true,
      })
      .waitFor();
    const path = `/api/runtime/v1/workspaces/${encodeURIComponent(project.id)}`;
    const contentURL = `${baseURL}${path}/content?path=${encodeURIComponent("资料/说明.txt")}`;
    const written = await page.request.put(contentURL, {
      data: "迁移与重命名后保留文件",
      headers: { Origin: new URL(baseURL).origin },
    });
    if (!written.ok())
      throw new Error(
        `Could not write project fixture: ${written.status()} ${await written.text()}`,
      );
    const renamed = await json(page, path, {
      method: "PATCH",
      body: JSON.stringify({ name: `${name}-显示名称` }),
    });
    if (renamed.directory !== name)
      throw new Error("Display rename moved the directory");
    const conflict = await page.request.post(
      `${baseURL}/api/runtime/v1/workspaces`,
      { data: { name }, headers: { Origin: new URL(baseURL).origin } },
    );
    if (conflict.status() !== 409)
      throw new Error(
        "Existing directory is not a conflict after display rename",
      );
    await page.reload();
    await dialog.locator("article", { hasText: `${name}-显示名称` }).waitFor();
    const persisted = (await json(page, "/api/runtime/v1/workspaces")).find(
      (p) => p.id === project.id,
    );
    if (
      persisted.directory !== name ||
      (await (await page.request.get(contentURL)).text()) !==
        "迁移与重命名后保留文件"
    )
      throw new Error("Directory or file contents were not preserved");
    const dir = process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR;
    if (dir) {
      await mkdir(dir, { recursive: true });
      await page.screenshot({
        path: join(dir, "project-directory-ui.png"),
        fullPage: true,
      });
      await writeFile(
        join(dir, "project-directory.json"),
        JSON.stringify(
          {
            checkedAt: new Date().toISOString(),
            directory: name,
            duplicateStatus: 409,
            displayRenameKeepsDirectory: true,
            filePreserved: true,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    if (project)
      await json(page, `/api/runtime/v1/workspaces/${project.id}`, {
        method: "DELETE",
      });
  }
});
console.log(
  "Project directory smoke passed: name-based folder, conflict feedback, display-only rename and file preservation",
);
