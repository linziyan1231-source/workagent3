import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
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

const artifacts = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
if (artifacts) await mkdir(artifacts, { recursive: true });
await withPage(async (page) => {
  const created = new Set();
  const mutations = [];
  page.on("response", (response) => {
    const request = response.request();
    if (request.method() !== "POST") return;
    const path = new URL(response.url()).pathname;
    if (!path.startsWith("/api/session.")) return;
    const body = request.postDataJSON();
    if (!created.has(body?.payload?.sessionId)) return;
    mutations.push({
      path,
      status: response.status(),
      type: body?.type,
      method: body?.method,
      mode: body?.payload?.mode,
      sessionId: body?.payload?.sessionId,
    });
  });
  const call = (path, body) =>
    json(
      page,
      `/api/runtime/v1/sessions${path}`,
      body === undefined ? {} : { method: "POST", body: JSON.stringify(body) },
    );
  async function settled(id, expected) {
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const session = await call(`/${id}`);
      const messages = await call(`/${id}/messages`);
      const lastInput = messages.findLast((message) => message.role === "user");
      if (
        session.activity.state === "idle" &&
        session.lastTurn &&
        session.lastTurn.id === lastInput?.nativeTurnId
      ) {
        assert.equal(
          session.lastTurn?.status,
          "completed",
          JSON.stringify(session.activity),
        );
        const answer =
          messages.filter((message) => message.role === "assistant").at(-1)
            ?.text || "";
        if (expected)
          assert.ok(
            answer.includes(expected),
            `answer did not contain expected marker: ${answer}`,
          );
        return messages;
      }
      await page.waitForTimeout(700);
    }
    const pending = await json(
      page,
      `/api/runtime/v1/interactions?sessionId=${encodeURIComponent(id)}`,
    );
    const current = await call(`/${id}`);
    const history = await call(`/${id}/messages`);
    console.error(
      "Unsettled test session:",
      JSON.stringify({
        id,
        activity: current.activity,
        lastTurn: current.lastTurn,
        lastInput: history.findLast((message) => message.role === "user"),
        answerTail: history
          .findLast((message) => message.role === "assistant")
          ?.text.slice(-300),
      }),
    );
    throw new Error(
      `Conversation ${id} did not settle; pending approvals: ${JSON.stringify(pending.map(({ id, tool, status }) => ({ id, tool, status })))}`,
    );
  }
  try {
    for (const engine of process.env.WORKAGENT_SMOKE_ENGINES?.split(",") ?? [
      "codex",
      "kimi",
    ]) {
      const token = uniqueName(`remember-${engine}`);
      const source = await call("", {
        engine,
        title: uniqueName(`controls-${engine}`),
        workspace: "default",
        presetId: `builtin-${engine}`,
        modelId: engine === "codex" ? "gpt-6-astra" : "kimi-code/kimi-k3",
        thinkingEffort: "low",
        permissionMode: "read_only",
      });
      created.add(source.id);
      await call(`/${source.id}/turns`, {
        content: `请记住口令 ${token}。只回复这个口令。`,
      });
      const first = await settled(source.id, token);
      await call(`/${source.id}/turns`, {
        content: "这是发错的消息：WRONG-CONTENT。只回复收到。",
      });
      await settled(source.id);
      await call(`/${source.id}/turns`, {
        content: "这是后续消息：LATER-CONTENT。只回复收到。",
      });
      const original = await settled(source.id);
      const wrong = original.find(
        (message) =>
          message.role === "user" && message.text.includes("WRONG-CONTENT"),
      );

      await page.goto(`${baseURL}/?frontend=dsh&session=${source.id}`);
      const row = page.locator(`[data-message-id="${wrong.id}"]`);
      await row.hover();
      await row.getByRole("button", { name: "编辑", exact: true }).click();
      await row
        .getByLabel("编辑消息")
        .fill("请回忆最早的口令，只回复口令，并加上 已修订。");
      await row
        .getByRole("button", { name: "保存并重发", exact: true })
        .click();
      await page.waitForURL(
        (url) =>
          url.searchParams.get("session") !== source.id &&
          url.searchParams.has("session"),
      );
      const editedId = new URL(page.url()).searchParams.get("session");
      created.add(editedId);
      const edited = await settled(editedId, token);
      assert.ok(edited.at(-1).text.includes("已修订"));
      assert.ok(
        !edited.some((message) =>
          /WRONG-CONTENT|LATER-CONTENT/.test(message.text),
        ),
      );
      assert.deepEqual(await call(`/${source.id}/messages`), original);
      assert.equal((await call(`/${editedId}`)).parentSessionId, source.id);
      await page.goto(`${baseURL}/?frontend=dsh&session=${source.id}`);

      await page
        .locator(
          `[data-message-id="${first.find((message) => message.role === "assistant").id}"]`,
        )
        .hover();
      await page
        .locator(
          `[data-message-id="${first.find((message) => message.role === "assistant").id}"]`,
        )
        .getByRole("button", { name: "分支", exact: true })
        .click();
      await page.waitForURL(
        (url) => url.searchParams.get("session") !== source.id,
      );
      const forkId = new URL(page.url()).searchParams.get("session");
      created.add(forkId);
      await page
        .getByLabel("继续对话", { exact: true })
        .fill("最早口令是什么？只回复口令。");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await settled(forkId, token);

      await page.getByLabel("继续对话", { exact: true }).fill("/btw");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      const side = page.getByRole("complementary", { name: "侧聊 BTW" });
      await side.getByLabel("侧聊消息").fill("最早口令是什么？只回复口令。");
      await side.getByRole("button", { name: "发送", exact: true }).click();
      const sides = (await call("")).filter(
        (session) =>
          session.parentSessionId === forkId &&
          session.branchKind === "side_chat",
      );
      assert.equal(sides.length, 1);
      const sideId = sides[0].id;
      created.add(sideId);
      await settled(sideId, token);
      await page.reload();
      await page
        .getByRole("complementary", { name: "侧聊 BTW" })
        .getByText(token, { exact: false })
        .first()
        .waitFor();
      const mainBounds = await page
        .locator(".workagent-conversation-workspace > .workagent-conversation")
        .boundingBox();
      const sideBounds = await side.boundingBox();
      assert.ok(
        mainBounds.width >= 320,
        "Main chat was squeezed by side panels",
      );
      assert.ok(sideBounds.width >= 300, "Side chat has insufficient width");
      if (artifacts)
        await page.screenshot({
          path: `${artifacts}/${engine}-side-chat.png`,
          fullPage: true,
        });
      await page.getByRole("button", { name: "删除侧聊" }).click();
      await page
        .getByRole("alertdialog", { name: "确认删除侧聊" })
        .getByRole("button", { name: "确认删除", exact: true })
        .click();
      await side.waitFor({ state: "detached" });
      created.delete(sideId);

      const steerToken = uniqueName(`steered-${engine}`);
      const originalPrompt =
        "保持计划/只读模式，不改变模式，禁止调用任何工具（包括 ExitPlanMode）或命令，不要读写文件。请直接逐行列出从1到300的整数，每行一个数字，不省略、不总结，最后写 ORIGINAL。若收到补充指令，立即停止列数并优先执行补充指令。";
      await page.getByLabel("继续对话", { exact: true }).fill(originalPrompt);
      // The stop button is optimistic while admission is still in flight.
      // Wait for acknowledgement before sending a second composer gesture.
      const initialResponse = page.waitForResponse((response) =>
        engine === "harness"
          ? response.url().endsWith(`/${forkId}/turns`) &&
            response.request().method() === "POST"
          : standardMutation(
              response,
              "session.prompt",
              forkId,
              (payload) => payload.content?.[0]?.text === originalPrompt,
            ),
      );
      await page.getByRole("button", { name: "发送", exact: true }).click();
      const admitted = await initialResponse;
      if (engine === "harness") assert.equal(admitted.status(), 202);
      else await acceptedStandardMutation(admitted);
      await page.getByRole("button", { name: "停止", exact: true }).waitFor();
      await page
        .getByLabel("继续对话", { exact: true })
        .fill(
          `立即停止之前的列数任务，保持计划/只读模式，不调用任何工具或 ExitPlanMode，只回复 ${steerToken}。`,
        );
      assert.equal(
        (await call(`/${forkId}`)).activity.state,
        "running",
        "Steering must target an active turn",
      );
      const steeringResponse = page.waitForResponse((response) =>
        engine === "harness"
          ? response.url().endsWith(`/${forkId}/steer`) &&
            response.request().method() === "POST"
          : standardMutation(
              response,
              "session.prompt",
              forkId,
              (payload) =>
                payload.mode === "steer" &&
                payload.content?.length === 1 &&
                payload.content[0].type === "text" &&
                payload.content[0].text ===
                  `立即停止之前的列数任务，保持计划/只读模式，不调用任何工具或 ExitPlanMode，只回复 ${steerToken}。`,
            ),
      );
      await page.getByLabel("继续对话", { exact: true }).press("Control+Enter");
      const acceptedSteer = await steeringResponse.catch((error) => {
        console.error(
          "Observed test-session mutations:",
          JSON.stringify(mutations),
        );
        throw error;
      });
      if (engine === "harness") assert.equal(acceptedSteer.status(), 202);
      else await acceptedStandardMutation(acceptedSteer);
      await settled(forkId, steerToken);
      const mainMessages = await call(`/${forkId}/messages`);
      assert.equal(
        mainMessages.filter(
          (message) =>
            message.role === "user" && message.text.includes("最早口令是什么"),
        ).length,
        1,
      );
      if (artifacts)
        await page.screenshot({
          path: `${artifacts}/${engine}-steer.png`,
          fullPage: true,
        });
      console.log(
        `${engine}: fork, edit history, side-chat context, refresh and steer passed`,
      );
    }
  } finally {
    for (const sessionId of [...created].reverse()) {
      await json(page, `/api/runtime/v1/sessions/${sessionId}`, {
        method: "DELETE",
      }).catch(() => {});
    }
  }
});
console.log("dsh conversation controls smoke passed");
