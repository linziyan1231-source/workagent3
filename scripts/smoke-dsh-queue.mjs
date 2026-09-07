import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseURL, json, uniqueName, withPage } from "./smoke-dsh-helpers.mjs";

const standardMutation = (response, method, sessionId, matchesPayload) => {
  if (
    new URL(response.url()).pathname !== `/api/${method}` ||
    response.request().method() !== "POST"
  )
    return false;
  const request = response.request().postDataJSON();
  return (
    request?.type === "client-request" &&
    request.method === method &&
    request.payload?.sessionId === sessionId &&
    matchesPayload(request.payload)
  );
};
const acceptedStandardMutation = async (response) => {
  assert.equal(response.status(), 200);
  const request = response.request().postDataJSON();
  const body = await response.json();
  assert.equal(body.type, "server-response");
  assert.equal(body.rpcId, request.rpcId);
  assert.equal(body.result?.ok, true, JSON.stringify(body));
  assert.equal(body.result.value.accepted, true);
};

const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
if (evidence) await mkdir(evidence, { recursive: true });
await withPage(async (page) => {
  const errors = [];
  const created = [];
  const results = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const call = (id, action = "", body) =>
    json(
      page,
      `/api/runtime/v1/sessions${id ? `/${id}` : ""}${action ? `/${action}` : ""}`,
      body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
    );
  const settings = async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    await dialog.getByRole("button", { name: "通用设置", exact: true }).click();
    await dialog.getByLabel("任务运行时的发送方式").waitFor();
    return dialog;
  };
  const capture = async (name) => {
    if (evidence)
      await page.screenshot({
        path: join(evidence, `${name}.png`),
        fullPage: true,
      });
  };
  let original;
  try {
    await page.evaluate(() =>
      localStorage.setItem("workagent.files.open", "false"),
    );
    await page.reload();
    await page.setViewportSize({ width: 1440, height: 900 });
    let dialog = await settings();
    const mode = dialog.getByLabel("任务运行时的发送方式");
    original = await mode.inputValue();
    assert.equal(
      await dialog
        .getByText(
          /^(General|Queue|Steer|Enter behavior while busy|Busy only;.*)$/,
        )
        .count(),
      0,
    );
    await mode.selectOption("steer");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.reload();
    dialog = await settings();
    assert.equal(
      await dialog.getByLabel("任务运行时的发送方式").inputValue(),
      "steer",
    );
    await dialog.getByLabel("任务运行时的发送方式").selectOption("queue");
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="任务运行时的发送方式"]')?.value ===
        "queue",
    );
    await capture("queue-settings-zh");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    for (const engine of process.env.WORKAGENT_SMOKE_ENGINES?.split(",") ?? [
      "harness",
      "codex",
      "kimi",
    ]) {
      const session = await call("", "", {
        engine,
        title: uniqueName(`queue-${engine}`),
        workspace: "default",
        presetId:
          engine === "harness" ? "builtin-general" : `builtin-${engine}`,
        modelId:
          engine === "codex"
            ? "gpt-6-astra"
            : engine === "kimi"
              ? "kimi-code/kimi-k3"
              : undefined,
        thinkingEffort: "low",
        permissionMode: "read_only",
      });
      created.push(session.id);
      await page.goto(`${baseURL}/?frontend=dsh&session=${session.id}`);
      const input = page.getByLabel("继续对话", { exact: true });
      const send = page.getByRole("button", { name: "发送", exact: true });
      const originalPrompt =
        "保持计划/只读模式，不改变模式，禁止调用任何工具（包括 ExitPlanMode）或命令，不要读写文件。请直接逐行列出从1到300的整数，每行一个数字，不省略、不总结，最后写 ORIGINAL。若收到补充指令，立即停止列数并优先执行补充指令。";
      await input.fill(originalPrompt);
      // Stop is displayed optimistically before the composer can submit again.
      const initialResponse = page.waitForResponse((response) =>
        engine === "harness"
          ? response.url().endsWith(`/${session.id}/turns`) &&
            response.request().method() === "POST"
          : standardMutation(
              response,
              "session.prompt",
              session.id,
              (payload) => payload.content?.[0]?.text === originalPrompt,
            ),
      );
      await send.click();
      const admitted = await initialResponse;
      if (engine === "harness") assert.equal(admitted.status(), 202);
      else await acceptedStandardMutation(admitted);
      await page.getByRole("button", { name: "停止", exact: true }).waitFor();
      for (const button of [
        send,
        page.getByRole("button", { name: "停止", exact: true }),
      ]) {
        assert.equal(await button.innerText(), "");
        assert.equal(await button.locator("svg").count(), 1);
        const box = await button.boundingBox();
        assert.equal(box.width, box.height);
      }
      const queuedToken = uniqueName(`queued-${engine}`);
      const steerToken = uniqueName(`steered-${engine}`);
      for (const content of [
        `保持计划/只读模式，不调用工具或 ExitPlanMode，只回复 ${queuedToken}`,
        `立即停止之前的列数任务，保持计划/只读模式，不调用任何工具或 ExitPlanMode，只回复 ${steerToken}。`,
      ]) {
        await input.fill(content);
        const response = page.waitForResponse((r) =>
          engine === "harness"
            ? r.url().endsWith(`/${session.id}/queue`) &&
              r.request().method() === "POST"
            : standardMutation(
                r,
                "session.prompt",
                session.id,
                (payload) =>
                  payload.mode === "queue" &&
                  payload.content?.length === 1 &&
                  payload.content[0].type === "text" &&
                  payload.content[0].text === content,
              ),
        );
        await send.click();
        const acceptedQueue = await response;
        if (engine === "harness") assert.equal(acceptedQueue.status(), 202);
        else await acceptedStandardMutation(acceptedQueue);
      }
      await page.getByText("排队消息（2）", { exact: true }).waitFor();
      assert.equal(
        (await call(session.id, "messages")).filter((m) => m.role === "user")
          .length,
        1,
      );
      await capture(`${engine}-queued-icons`);
      await page.setViewportSize({ width: 390, height: 844 });
      await capture(`${engine}-queued-mobile`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert.equal(overflow, false);
      await page.setViewportSize({ width: 1440, height: 900 });
      const row = page
        .locator(".workagent-queued-message")
        .filter({ hasText: steerToken });
      const pendingQueue = await call(session.id, "queue");
      const selectedItem = pendingQueue.find((item) =>
        item.content.includes(steerToken),
      );
      assert.ok(
        selectedItem,
        "The selected steering message must still be pending",
      );
      assert.equal(
        (await call(session.id)).activity.state,
        "running",
        "Queue steering must target an active turn",
      );
      const steeringResponse = page.waitForResponse((r) =>
        engine === "harness"
          ? r.url().endsWith(`/${session.id}/queue`) &&
            r.request().method() === "POST"
          : standardMutation(
              r,
              "session.updateQueue",
              session.id,
              (payload) =>
                payload.itemId === selectedItem.messageId &&
                payload.action?.kind === "steer",
            ),
      );
      await row.getByRole("button", { name: "立即追加", exact: true }).click();
      const acceptedSteer = await steeringResponse;
      if (engine === "harness") assert.equal(acceptedSteer.status(), 200);
      else await acceptedStandardMutation(acceptedSteer);
      console.log(
        `${engine}: two messages queued, selected message steered; waiting for FIFO completion`,
      );
      const deadline = Date.now() + 150_000;
      let messages;
      let checks = 0;
      while (Date.now() < deadline) {
        messages = await call(session.id, "messages");
        const current = await call(session.id);
        if (
          current.activity.state === "idle" &&
          messages.filter((m) => m.role === "user").length === 3 &&
          (await call(session.id, "queue")).length === 0
        )
          break;
        if (++checks % 10 === 0) {
          const pending = await json(
            page,
            `/api/runtime/v1/interactions?sessionId=${encodeURIComponent(session.id)}`,
          );
          assert.equal(
            pending.length,
            0,
            `Tools-free queue fixture requested approval: ${JSON.stringify(pending.map(({ tool, status }) => ({ tool, status })))}`,
          );
        }
        await page.waitForTimeout(500);
      }
      const final = await call(session.id);
      assert.equal(
        final.activity.state,
        "idle",
        JSON.stringify({
          activity: final.activity,
          lastTurn: final.lastTurn,
          lastInput: messages.findLast((message) => message.role === "user"),
          answerTail: messages
            .findLast((message) => message.role === "assistant")
            ?.text.slice(-300),
        }),
      );
      assert.deepEqual(
        messages
          .filter((m) => m.role === "user")
          .map((m) => m.text)
          .slice(1),
        [
          `立即停止之前的列数任务，保持计划/只读模式，不调用任何工具或 ExitPlanMode，只回复 ${steerToken}。`,
          `保持计划/只读模式，不调用工具或 ExitPlanMode，只回复 ${queuedToken}`,
        ],
      );
      assert.equal((await call(session.id, "queue")).length, 0);
      assert.equal((await call(session.id)).lastTurn.status, "completed");
      assert.ok(
        messages
          .filter((m) => m.role === "assistant")
          .at(-1)
          .text.includes(queuedToken),
      );
      await capture(`${engine}-queue-complete`);
      results.push({
        engine,
        icons: true,
        persistedPreference: true,
        queued: 2,
        steered: 1,
        fifo: true,
      });
    }
    assert.deepEqual(errors, []);
    if (evidence)
      await writeFile(
        join(evidence, "queue-report.json"),
        JSON.stringify(results, null, 2),
      );
    console.log(
      "DSH queue, steer, Chinese settings and icon smoke passed",
      JSON.stringify(results),
    );
  } finally {
    await page.goto(`${baseURL}/?frontend=dsh`);
    if (original) {
      const dialog = await settings();
      await dialog.getByLabel("任务运行时的发送方式").selectOption(original);
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    }
    for (const id of created)
      await json(page, `/api/runtime/v1/sessions/${id}`, { method: "DELETE" });
  }
});
