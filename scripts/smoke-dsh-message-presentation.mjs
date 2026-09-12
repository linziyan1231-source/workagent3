import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { baseURL, login } from "./smoke-dsh-helpers.mjs";

// Uses authenticated history reads and browser-only fixtures. No production
// messages, files, model calls, or session settings are changed.
const out = `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/chromium`;
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const report = { checks: [], errors: [] };
page.on("pageerror", (error) => report.errors.push(error.message));
await page.addInitScript(() =>
  localStorage.setItem("workagent.files.open", "false"),
);
try {
  const candidate = process.env.WORKAGENT_SMOKE_CANDIDATE;
  if (candidate) {
    for (const file of ["client.js", "tokens.css"]) {
      const body = await readFile(`${candidate}/${file}`);
      await page.route(`**/plugins/@workagent/dsh-client/${file}*`, (route) =>
        route.fulfill({
          body,
          contentType: file.endsWith("css")
            ? "text/css"
            : "application/javascript",
        }),
      );
    }
  }
  await login(page);
  const sessions = await (
    await page.request.get(`${baseURL}/api/runtime/v1/sessions`)
  ).json();
  const session = sessions.find(
    (row) =>
      row.engine === "codex" &&
      !["running", "retrying"].includes(row.activity?.state),
  );
  assert.ok(session, "An existing idle Codex session is required");
  if (!candidate) {
    const missing = await page.request.post(
      `${baseURL}/api/runtime/v1/sessions/${session.id}/question-reply`,
      {
        headers: { Origin: new URL(baseURL).origin },
        data: { questionId: "smoke-nonexistent-question", content: "路由验证" },
      },
    );
    assert.equal(missing.status(), 404);
    assert.equal((await missing.json()).error, "question_not_found");
    report.checks.push(
      "production reply route rejects nonexistent questions without changing data",
    );
  }
  const progress = "我先查看工作区里的原文，确认内容和申请背景。";
  const question =
    "新文书要申请哪个学校和专业？请一并提供题目或字数要求，以及希望用中文还是英文。";
  const final =
    "我已读到原文。新文书是申请哪个学校、哪个专业？我会保留真实经历，根据目标项目重新组织申请动机。";
  let savedReply;
  await page.route("**/api/session.history", async (route) => {
    const request = route.request().postDataJSON();
    if (request.payload?.sessionId !== session.id) return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    const projection = data.result.value.projections.values.nativeSession;
    assert.ok(projection);
    projection.messages = [
      {
        id: "fixture-user",
        role: "user",
        text: "根据这份材料生成一份新的申请文书。",
      },
      {
        id: "fixture-question",
        role: "assistant",
        kind: "question",
        text: question,
      },
      { id: "fixture-answer", role: "assistant", kind: "answer", text: final },
    ].map((row) => ({
      ...row,
      sessionId: session.id,
      createdAt: "2026-09-10T15:40:00.000Z",
      nativeTurnId: "fixture-turn",
    }));
    if (savedReply) projection.messages.push(savedReply);
    projection.processes = {
      "commentary-fixture": {
        processId: "commentary-fixture",
        kind: "commentary",
        text: progress,
        turnId: "fixture-turn",
      },
    };
    projection.tools = {};
    projection.draft = "";
    projection.activity = { state: "idle" };
    await route.fulfill({ response, json: data });
  });
  await page.goto(`${baseURL}/?frontend=dsh&session=${session.id}`);
  const card = page.getByRole("article", { name: "补充问题" });
  await card.waitFor();
  assert.equal(
    await page.locator(".workagent-message.is-assistant").count(),
    1,
  );
  assert.equal(
    await page
      .locator(".workagent-message.is-assistant .workagent-markdown")
      .innerText(),
    final,
  );
  assert.equal(await card.locator(".workagent-markdown").innerText(), question);
  const edited = [];
  await page.route("**/sessions/*/fork", async (route) => {
    edited.push(route.request().postDataJSON());
    await route.fulfill({
      status: 409,
      json: { error: "smoke_rejected_resend" },
    });
  });
  await page.locator('[data-message-id="fixture-user"]').hover();
  await page
    .locator('[data-message-id="fixture-user"]')
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  const editor = page.getByLabel("编辑消息", { exact: true });
  await editor.fill("中文第一行\n第二行补充");
  await editor.dispatchEvent("compositionstart", { data: "中文" });
  await editor.dispatchEvent("keydown", {
    key: "Enter",
    keyCode: 229,
    isComposing: true,
  });
  assert.equal(edited.length, 0);
  await editor.dispatchEvent("compositionend", { data: "中文" });
  await page.getByRole("button", { name: "保存并重发" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: /smoke_rejected_resend/ })
    .waitFor();
  assert.equal(edited.length, 1);
  assert.equal(edited[0].replacementContent, "中文第一行\n第二行补充");
  assert.equal(await editor.innerText(), "中文第一行\n第二行补充");
  await page.getByRole("button", { name: "取消编辑" }).click();
  assert.equal(await editor.count(), 0);
  report.checks.push(
    "Chinese IME confirmation does not submit; multiline edit/resend/cancel; resend intercepted without creating a conversation",
  );
  const replies = [];
  await page.route("**/api/session.prompt", async (route) => {
    replies.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        type: "server-response",
        rpcId: replies.at(-1).rpcId,
        result: { ok: true, value: { accepted: true } },
      },
    });
  });
  let replyAttempts = 0;
  await page.route("**/sessions/*/question-reply", async (route) => {
    const body = route.request().postDataJSON();
    assert.equal(body.questionId, "fixture-question");
    replyAttempts++;
    if (replyAttempts === 1)
      return route.fulfill({
        status: 409,
        json: { error: "reply_failed_test" },
      });
    savedReply = {
      id: "message-question-fixture-question",
      sessionId: session.id,
      role: "user",
      text: body.content,
      createdAt: new Date().toISOString(),
      nativeTurnId: "fixture-turn",
      replyTo: { id: "fixture-question", text: question },
    };
    await route.fulfill({ json: { message: savedReply } });
  });
  const reply = card.getByRole("textbox", { name: "回复补充问题" });
  await reply.fill("申请商业分析，英文。");
  await card.getByRole("button", { name: "发送回复" }).click();
  await card.getByText("reply_failed_test", { exact: true }).waitFor();
  assert.equal(await reply.inputValue(), "申请商业分析，英文。");
  await card.getByRole("button", { name: "发送回复" }).click();
  await card.getByText("✓ 已补充", { exact: true }).waitFor();
  assert.equal(await reply.count(), 0);
  assert.equal(await card.locator("details").evaluate((e) => e.open), false);
  const quoted = page.getByRole("button", {
    name: `↩ 回复补充问题 · ${question}`,
  });
  await quoted.click();
  assert.equal(await card.locator("details").evaluate((e) => e.open), true);
  await card.locator("summary").click();
  assert.equal(
    await page.evaluate(
      (id) =>
        JSON.parse(
          sessionStorage.getItem(
            `workagent.draft.${id}:question:fixture-question`,
          ),
        ),
      session.id,
    ),
    "",
  );
  const reference = `项目文件：${JSON.stringify({ workspaceId: session.workspaceId, path: "fixture-source.docx", name: "申请资料.docx" })}`;
  const composer = page.getByLabel("继续对话", { exact: true });
  await composer.fill("请分析 ");
  await composer.evaluate(
    (element, text) => element.workagentInsertReference(text),
    reference,
  );
  await composer.getByRole("link", { name: "预览 申请资料.docx" }).waitFor();
  await composer
    .locator("xpath=ancestor::form[1]")
    .locator('button[type="submit"]')
    .click();
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="继续对话"]').textContent,
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0].payload.content[0].text, `请分析 ${reference}`);
  report.checks.push(
    "native session RPC preserves file reference identity while composer shows only the file name",
  );
  report.checks.push(
    "inline reply submits to current session and clears draft after success; request intercepted without model call",
  );
  const processPanel = page.locator(".workagent-process");
  assert.equal(await processPanel.evaluate((el) => el.open), false);
  assert.equal(
    await page.getByText(progress, { exact: true }).isVisible(),
    false,
  );
  await processPanel.locator("summary").click();
  assert.equal(
    await page.getByText(progress, { exact: true }).isVisible(),
    true,
  );
  await processPanel.locator("summary").click();
  report.checks.push(
    "separate question card; unchanged final answer; commentary in collapsible process",
  );
  await page.reload();
  await card.waitFor();
  assert.equal(
    await page.locator(".workagent-message.is-assistant").count(),
    1,
  );
  assert.equal(await reply.count(), 0);
  assert.equal(await card.locator("details").evaluate((e) => e.open), false);
  await quoted.waitFor();
  report.checks.push("refresh preserves answered state and reply reference");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(400);
    if (
      width <= 760 &&
      !(await page.locator(".hHd-Xa_root").getAttribute("class")).includes(
        "hHd-Xa_collapsed",
      )
    )
      await page.locator(".hHd-Xa_toggle").click();
    for (const dark of [false, true]) {
      await page.evaluate((dark) => {
        const key = "workagent.appearance.v1";
        localStorage.setItem(
          key,
          JSON.stringify({
            mode: dark ? "graphite" : "porcelain",
            daylight: "porcelain",
          }),
        );
        window.dispatchEvent(new StorageEvent("storage", { key }));
      }, dark);
      await page.waitForFunction(
        (dark) =>
          document.body.dataset.workagentTheme ===
          (dark ? "graphite" : "porcelain"),
        dark,
      );
      if (
        width <= 760 &&
        !(await page.locator(".hHd-Xa_root").getAttribute("class")).includes(
          "hHd-Xa_collapsed",
        )
      ) {
        await page.locator(".hHd-Xa_toggle").click();
        await page.waitForFunction(() =>
          document
            .querySelector(".hHd-Xa_root")
            .classList.contains("hHd-Xa_collapsed"),
        );
      }
      await card.scrollIntoViewIfNeeded();
      await page
        .waitForFunction(
          () => {
            const card = document.querySelector(".workagent-question");
            const r = card.getBoundingClientRect();
            return card.contains(
              document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
            );
          },
          undefined,
          { timeout: 5000 },
        )
        .catch(async (error) => {
          await page.screenshot({ path: `${out}/occlusion.png` });
          console.log(
            await page.evaluate(() => {
              const card = document.querySelector(".workagent-question");
              const r = card.getBoundingClientRect();
              return {
                bounds: r.toJSON(),
                hit: document
                  .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                  ?.outerHTML.slice(0, 300),
                sidebar: document.querySelector(".hHd-Xa_root").className,
              };
            }),
          );
          throw error;
        });
      await page.screenshot({
        path: `${out}/${width}-${dark ? "dark" : "light"}.png`,
      });
      const bounds = await card.boundingBox();
      assert.ok(
        bounds.x >= 0 && bounds.x + bounds.width <= width + 1,
        "question fits viewport",
      );
      assert.ok(
        await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        "question does not overflow",
      );
      report.checks.push(`${width}px ${dark ? "dark" : "light"} theme`);
    }
  }
  assert.deepEqual(report.errors, []);
  await writeFile(
    `${out}/message-report.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
