import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { baseURL, json, uniqueName, withPage } from "./smoke-dsh-helpers.mjs";

const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
if (!evidence) throw new Error("WORKAGENT_SMOKE_EVIDENCE_DIR required");
await mkdir(evidence, { recursive: true });
const report = { sessions: [], errors: [], checks: [] };
await withPage(async (page) => {
  page.on("dialog", (dialog) => dialog.accept());
  page.on("pageerror", (error) => report.errors.push(error.message));
  const workspace = await json(page, "/api/runtime/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: uniqueName("插件验收") }),
  });
  report.workspace = workspace.id;
  const contentURL = `/api/runtime/v1/workspaces/${workspace.id}/content?path=qa.txt`;
  await json(page, contentURL, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: "WORKBENCH_FILE_OK",
  });
  for (const engine of ["codex", "kimi"]) {
    const session = await json(page, "/api/runtime/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        engine,
        title: uniqueName(`插件-${engine}`),
        workspace: workspace.id,
        presetId: `builtin-${engine}`,
        modelId: engine === "codex" ? "gpt-6-astra" : "kimi-code/kimi-k3",
        thinkingEffort: "low",
        permissionMode: "workspace_write",
      }),
    });
    report.sessions.push({ engine, id: session.id });
    await page.goto(`${baseURL}/?frontend=dsh&session=${session.id}`);
    const input = page.getByLabel("继续对话", { exact: true });
    await input.waitFor();
    await page.getByLabel("当前会话模型").waitFor({ timeout: 30000 });
    assert.match(
      await page.locator(".workagent-session-controls").innerText(),
      /项目内读写/,
    );
    await input.fill(`${engine} draft`);
    await page.reload();
    await page.getByLabel("当前会话模型").waitFor({ timeout: 30000 });
    assert.equal(await input.inputValue(), `${engine} draft`);
    const effort = page.getByLabel("当前会话思考强度");
    const option = await effort.locator('option[value="high"]').count();
    if (option) {
      const response = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/session.selectModel" &&
          response.request().method() === "POST",
      );
      await effort.selectOption("high");
      assert.equal((await (await response).json()).result.ok, true);
      await page.waitForFunction(
        () =>
          !document.querySelector('[aria-label="当前会话思考强度"]').disabled,
      );
      const lowResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/session.selectModel" && response.request().method() === "POST");
      await effort.selectOption("low");
      assert.equal((await (await lowResponse).json()).result.ok, true);
      await page.waitForFunction(
        () =>
          !document.querySelector('[aria-label="当前会话思考强度"]').disabled,
      );
    }
    await page.getByLabel(`置顶 ${session.title}`, { exact: true }).click();
    await page.reload();
    await page
      .getByLabel(`取消置顶 ${session.title}`, { exact: true })
      .waitFor();
    await input.fill("@");
    await page
      .locator(".workagent-composer-menu")
      .getByRole("button", { name: "qa.txt", exact: true })
      .click();
    assert.match(await input.inputValue(), /项目文件.*qa.txt/);
    await input.locator("xpath=ancestor::form[1]").getByLabel("选择会话附件").setInputFiles({
      name: "附加资料.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("ATTACHMENT_OK"),
    });
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="继续对话"]')
        .value.includes(".attachments/"),
    );
    const reference = await input.inputValue();
    await input.fill(
      `${reference}\n请用文件读取工具读取 qa.txt，确认其中的口令。然后原样输出以下 Markdown，不要加外层代码围栏：\n\n| 插件 | 状态 |\n|---|---|\n| Workbench | OK |\n\n公式：$x^2$\n\n[文件](qa.txt)\n\n\`\`\`mermaid\ngraph TD\nA[Input] --> B[Done]\n\`\`\``,
    );
    await page.getByLabel("当前会话模型").waitFor();
    const accepted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/session.prompt" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const firstResponse = await (await accepted).json();
    assert.equal(firstResponse.result.ok, true, JSON.stringify(firstResponse));
    const deadline = Date.now() + 240000;
    let rejectedApproval = false;
    while (Date.now() < deadline) {
      const state = await json(page, `/api/runtime/v1/sessions/${session.id}`);
      const pending = await json(
        page,
        `/api/runtime/v1/interactions?sessionId=${session.id}`,
      );
      if (pending.length) {
        // Never broadly approve model-generated commands in acceptance.
        await page
          .getByRole("button", { name: "拒绝", exact: true })
          .first()
          .click();
        rejectedApproval = true;
        report.checks.push(`${engine}: approval rejected through UI`);
      }
      if (state.lastTurn && state.activity?.state === "idle") {
        assert(
          ["completed", ...(rejectedApproval ? ["cancelled"] : [])].includes(
            state.lastTurn.status,
          ),
          JSON.stringify(state.lastTurn),
        );
        if (rejectedApproval)
          report.checks.push(
            `${engine}: rejected approval settled as ${state.lastTurn.status}`,
          );
        break;
      }
      await page.waitForTimeout(1500);
    }
    // A separate output task follows the approval check. A rejected native tool
    // can legitimately end its turn; it is not retried or broadly approved.
    await input.fill(
      "这是独立的排版检查，无需读取文件、无需执行工具。请原样输出下面的 Markdown，不要加外层代码围栏：\n\n| 插件 | 状态 |\n|---|---|\n| Workbench | OK |\n\n公式：$x^2$\n\n[文件](qa.txt)\n\n```mermaid\ngraph TD\nA[Input] --> B[Done]\n```",
    );
    const precedingTurn = (
      await json(page, `/api/runtime/v1/sessions/${session.id}`)
    ).lastTurn?.id;
    const formattingAccepted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/session.prompt" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const formattingResponse = await (await formattingAccepted).json();
    assert.equal(formattingResponse.result.ok, true, JSON.stringify(formattingResponse));
    await page.waitForFunction(
      async ({ id, precedingTurn }) => {
        const state = await (
          await fetch(`/api/runtime/v1/sessions/${id}`)
        ).json();
        return (
          state.activity?.state === "idle" &&
          state.lastTurn?.id !== precedingTurn &&
          state.lastTurn?.status === "completed"
        );
      },
      { id: session.id, precedingTurn },
      { timeout: 180000, polling: 1500 },
    );
    const messages = await json(
      page,
      `/api/runtime/v1/sessions/${session.id}/messages`,
    );
    assert(
      messages.some((row) => row.role === "assistant"),
      "native reply missing",
    );
    await page
      .locator(".workagent-message.is-assistant table")
      .last()
      .waitFor({ timeout: 30000 });
    await page
      .locator(".workagent-message.is-assistant .katex")
      .last()
      .waitFor();
    await page
      .locator(".workagent-message.is-assistant .workagent-diagram svg")
      .last()
      .waitFor({ timeout: 30000 });
    await page.getByText(/工具过程 ·/).waitFor();
    await page.getByText(/工具过程 ·/).click();
    await page
      .getByRole("button", { name: "停止", exact: true })
      .waitFor({ state: "hidden", timeout: 30000 });
    await page.getByLabel("当前会话模型").waitFor();
    const closeFiles = page.getByRole("button", {
      name: "关闭文件侧栏",
      exact: true,
    });
    if (await closeFiles.count()) await closeFiles.first().click();
    await page
      .locator(".workagent-message.is-assistant table")
      .last()
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${evidence}/workbench-${engine}.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .locator(".workagent-message.is-assistant table")
      .last()
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${evidence}/workbench-${engine}-mobile.png`,
      fullPage: true,
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 2,
    );
    assert.equal(overflow, false, "mobile page overflow");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.reload();
    await page
      .locator(".workagent-message.is-assistant table")
      .last()
      .waitFor({ timeout: 30000 });
    report.checks.push(
      `${engine}: model, draft, pin, file reference, upload, native prompt, tool details, markdown, math, Mermaid, refresh, mobile`,
    );
  }
  await json(page, contentURL, {
    method: "PATCH",
    body: JSON.stringify({ original: "WORKBENCH_FILE_OK", text: "EDITED_OK" }),
  });
  const conflict = await page.request.patch(`${baseURL}${contentURL}`, {
    data: { original: "WORKBENCH_FILE_OK", text: "STALE" },
    headers: { Origin: new URL(baseURL).origin },
  });
  assert.equal(conflict.status(), 409);
  report.checks.push("file edit conflict preserves concurrent change");
  const openFiles = page.getByRole("button", {
    name: "打开文件侧栏",
    exact: true,
  });
  if (await openFiles.count()) await openFiles.click();
  const panel = page.getByRole("complementary", { name: "项目文件侧栏" });
  await panel.getByRole("button", { name: "qa.txt", exact: true }).click();
  await panel.getByRole("button", { name: "编辑文件", exact: true }).click();
  await panel.getByLabel("编辑文件内容").fill("SAVED_THROUGH_UI");
  await panel.getByRole("button", { name: "保存文件", exact: true }).click();
  await panel.getByRole("button", { name: "编辑文件", exact: true }).waitFor();
  assert.equal(
    await (await page.request.get(`${baseURL}${contentURL}`)).text(),
    "SAVED_THROUGH_UI",
  );
  await panel.getByRole("button", { name: "编辑文件", exact: true }).click();
  await panel.getByLabel("编辑文件内容").fill("MY_UNSAVED_EDIT");
  await json(page, contentURL, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: "CONCURRENT_EDIT",
  });
  await panel.getByRole("button", { name: "保存文件", exact: true }).click();
  await panel.getByRole("alert").waitFor();
  assert.equal(
    await panel.getByLabel("编辑文件内容").inputValue(),
    "MY_UNSAVED_EDIT",
  );
  assert.equal(
    await (await page.request.get(`${baseURL}${contentURL}`)).text(),
    "CONCURRENT_EDIT",
  );
  await page.screenshot({
    path: `${evidence}/workbench-file-editor-conflict.png`,
  });
  report.checks.push(
    "authenticated file editor saves and retains a conflicting draft",
  );
  const saveButton = await panel
    .getByRole("button", { name: "保存文件", exact: true })
    .boundingBox();
  assert(saveButton.height < 60, "editor action stretched vertically");
  await panel.getByRole("button", { name: "取消编辑", exact: true }).click();
  await json(page, contentURL, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: "\uFEFF原文",
  });
  await panel
    .getByRole("button", { name: "返回文件列表", exact: true })
    .click();
  await panel.getByRole("button", { name: "qa.txt", exact: true }).click();
  await panel.getByRole("button", { name: "编辑文件", exact: true }).click();
  await panel.getByLabel("编辑文件内容").fill("修改后");
  await panel.getByRole("button", { name: "保存文件", exact: true }).click();
  await panel.getByRole("button", { name: "编辑文件", exact: true }).waitFor();
  const savedBytes = await (
    await page.request.get(`${baseURL}${contentURL}`)
  ).body();
  assert.equal(savedBytes.toString("utf8"), "\uFEFF修改后");
  report.checks.push("Windows UTF-8 BOM preserved through browser edit");
  report.speech = await json(page, "/api/speech/capability");
  assert.deepEqual(report.errors, []);
}).finally(async () => {
  await writeFile(
    `${evidence}/workbench-report.json`,
    JSON.stringify(report, null, 2),
  );
});
console.log(JSON.stringify(report));
