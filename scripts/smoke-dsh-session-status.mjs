import { baseURL, json, uniqueName, withPage } from "./smoke-dsh-helpers.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

await withPage(async (page) => {
  const evidence = process.env.WORKAGENT_SMOKE_SCREENSHOT_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const sessions = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const screenshot = async (name) => {
    if (evidence)
      await page.screenshot({ path: join(evidence, name), fullPage: true });
  };
  let project;
  try {
    await page.goto(`${baseURL}/?frontend=dsh&workagent=workspaces`);
    const dialog = page.getByRole("dialog", { name: "项目", exact: true });
    await dialog.getByLabel("搜索项目", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "新建项目", exact: true }).click();
    const name = uniqueName("对话状态验收");
    await dialog.getByLabel("新项目名称", { exact: true }).fill(name);
    await dialog.getByRole("button", { name: "创建项目", exact: true }).click();
    await dialog.locator("article", { hasText: name }).waitFor();
    project = (await json(page, "/api/runtime/v1/workspaces")).find(
      (item) => item.name === name,
    );
    if (!project) throw new Error("UI did not create a project");
    if (await dialog.getByLabel("新项目名称", { exact: true }).count())
      throw new Error("Create form stayed open after success");
    await screenshot("projects-created.png");
    const createSession = async (engine, options = {}) => {
      const session = await json(page, "/api/runtime/v1/sessions", {
        method: "POST",
        body: JSON.stringify({
          engine,
          title: uniqueName(`${engine}-状态验收`),
          workspace: project.id,
          permissionMode: "read_only",
          ...options,
        }),
      });
      sessions.push(session.id);
      return session;
    };
    const codex = await createSession("codex", {
      modelId: "gpt-6-astra",
      thinkingEffort: "low",
    });
    await page.goto(`${baseURL}/?frontend=dsh`);
    let row = page.locator(".workagent-sidebar-session", {
      hasText: codex.title,
    });
    await row.waitFor();
    await json(page, `/api/runtime/v1/sessions/${codex.id}/turns`, {
      method: "POST",
      body: JSON.stringify({
        content:
          "Write a detailed 2000 word explanation of how rain forms. Do not use tools.",
      }),
    });
    await row
      .getByRole("img", { name: "正在运行", exact: true })
      .waitFor({ timeout: 15000 });
    const spinner = row.locator(".is-running");
    const before = await spinner.evaluate(
      (el) => getComputedStyle(el).transform,
    );
    await page.waitForTimeout(180);
    const after = await spinner.evaluate(
      (el) => getComputedStyle(el).transform,
    );
    if (before === after) throw new Error("Running indicator is not rotating");
    await screenshot("sidebar-running.png");
    await page.reload();
    await row.getByRole("img", { name: "正在运行", exact: true }).waitFor();
    await json(page, `/api/runtime/v1/sessions/${codex.id}/cancel`, {
      method: "POST",
    });
    await row
      .getByRole("img", { name: "已停止，未读", exact: true })
      .waitFor({ timeout: 15000 });
    const detail = await json(page, `/api/runtime/v1/sessions/${codex.id}`);
    const listed = (await json(page, "/api/runtime/v1/sessions")).find(
      (item) => item.id === codex.id,
    );
    if (
      listed.activity.state !== "idle" ||
      listed.lastTurn.id !== detail.lastTurn.id ||
      listed.lastTurn.status !== "cancelled"
    )
      throw new Error("List and detail completion metadata disagree");
    await page.reload();
    await row.getByRole("img", { name: "已停止，未读", exact: true }).waitFor();
    await screenshot("sidebar-unread.png");
    await row.locator("button.is-main").click();
    await page.waitForURL(
      (url) => url.searchParams.get("session") === codex.id,
    );
    await row.waitFor();
    if (await row.locator(".workagent-session-status").count())
      throw new Error("Opening a conversation did not clear the dot");
    await page.reload();
    await row.waitFor();
    if (await row.locator(".workagent-session-status").count())
      throw new Error("Read marker did not persist");

    const groups = await json(page, "/api/runtime/v1/model-options");
    const model = groups.find((group) => group.engine === "kimi").models[0];
    const kimi = await createSession("kimi", {
      modelId: model.id,
      thinkingEffort: model.reasoning[0].id,
    });
    await page.goto(`${baseURL}/?frontend=dsh`);
    row = page.locator(".workagent-sidebar-session", { hasText: kimi.title });
    await row.waitFor();
    await json(page, `/api/runtime/v1/sessions/${kimi.id}/turns`, {
      method: "POST",
      body: JSON.stringify({
        content: "Reply with exactly STATUS_COMPLETE. Do not use tools.",
      }),
    });
    await row
      .getByRole("img", { name: "已完成，未读", exact: true })
      .waitFor({ timeout: 90000 });
    await screenshot("sidebar-completed.png");
    const messages = await json(
      page,
      `/api/runtime/v1/sessions/${kimi.id}/messages`,
    );
    if (
      !messages.some(
        (message) =>
          message.role === "assistant" &&
          message.text.includes("STATUS_COMPLETE"),
      )
    )
      throw new Error("Completed turn did not save its response");
    await row.locator("button.is-main").click();
    await page.waitForURL((url) => url.searchParams.get("session") === kimi.id);
    await row.waitFor();
    if (await row.locator(".workagent-session-status").count())
      throw new Error("Completed dot did not clear on read");
    if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
    const report = {
      checkedAt: new Date().toISOString(),
      createdThroughUI: true,
      backgroundPolling: true,
      animated: true,
      reloadWhileRunning: true,
      unreadSurvivesReload: true,
      readPersists: true,
      codexCancelled: true,
      kimiCompleted: true,
    };
    if (evidence)
      await writeFile(
        join(evidence, "session-status.json"),
        JSON.stringify(report, null, 2),
      );
    console.log(JSON.stringify(report));
  } finally {
    for (const id of sessions) {
      await json(page, `/api/runtime/v1/sessions/${id}/cancel`, {
        method: "POST",
      }).catch(() => {});
      await json(page, `/api/runtime/v1/sessions/${id}`, { method: "DELETE" });
    }
    if (project)
      await json(page, `/api/runtime/v1/workspaces/${project.id}`, {
        method: "DELETE",
      });
  }
});
