import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseURL, json, withPage, uniqueName } from "./smoke-dsh-helpers.mjs";

const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
if (!evidence) throw Error("Evidence directory required");
await mkdir(evidence, { recursive: true });
const report = { status: "running", checks: [], errors: [] };
try {
  await withPage(async (page) => {
    page.on("pageerror", (error) => report.errors.push(error.message));
    const presets = await json(page, "/api/runtime/v1/presets");
    assert.ok(
      presets.some(
        (preset) => preset.id === "builtin-puxin-butler" && preset.enabled,
      ),
    );
    const groups = await json(page, "/api/runtime/v1/model-options");
    const group = groups.find((row) => row.engine === "codex");
    const model = group.models.find((row) => row.isDefault) || group.models[0];
    const session = await json(page, "/api/runtime/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        engine: "codex",
        title: uniqueName("Puxin管家只读验收"),
        workspace: "default",
        presetId: "builtin-puxin-butler",
        modelId: model.id,
        permissionMode: "workspace_write",
        thinkingEffort: "low",
      }),
    });
    report.sessionId = session.id;
    await page.goto(`${baseURL}/?frontend=dsh&session=${session.id}`);
    await page.getByLabel("继续对话", { exact: true }).waitFor();
    await json(page, `/api/runtime/v1/sessions/${session.id}/turns`, {
      method: "POST",
      body: JSON.stringify({
        content:
          "这是管家功能的只读验收。请实际运行你内置的管家工具 overview，读取当前 MCP、技能、消息渠道和助手的状态，再用中文简短报告各项是否成功读取。不要修改任何配置、不要发消息给他人、不要输出密钥。如果工具失败请明确报告，不要编造成功。成功读取所有这四项后，最后写 PUXIN_BUTLER_READ_OK。",
      }),
    });
    let state;
    for (let attempt = 0; attempt < 120; attempt++) {
      state = await json(page, `/api/runtime/v1/sessions/${session.id}`);
      if (["completed", "failed", "cancelled"].includes(state.lastTurn?.status))
        break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const messages = await json(
      page,
      `/api/runtime/v1/sessions/${session.id}/messages`,
    );
    // Preserve the real read-only acceptance task; never remove production records.
    const assistant = messages
      .filter((row) => row.role === "assistant")
      .map((row) => row.text)
      .join("\n");
    report.turnStatus = state.lastTurn?.status;
    report.answer = assistant;
    assert.equal(state.lastTurn?.status, "completed");
    assert.match(assistant, /PUXIN_BUTLER_READ_OK/);
    const history = await json(page, "/api/session.history", {
      method: "POST",
      body: JSON.stringify({
        type: "client-request",
        rpcId: crypto.randomUUID(),
        method: "session.history",
        payload: { sessionId: session.id },
      }),
    });
    assert.equal(history.result?.ok, true);
    const native = history.result.value.projections.values.nativeSession;
    const toolEvidence = JSON.stringify(
      native.tools ?? native.value?.tools ?? native,
    );
    assert.match(toolEvidence, /butler_overview/);
    assert.match(toolEvidence, /overview/);
    assert.match(toolEvidence, /"status"\\?":\\?\s*200|status.*200/);
    report.checks.push(
      "native tool history records the butler MCP invocation and successful HTTP results",
    );
    const reloaded = await json(
      page,
      `/api/runtime/v1/sessions/${session.id}/capabilities/reload`,
      { method: "POST", body: "{}" },
    );
    assert.equal(reloaded.id, session.id);
    const afterReload = await json(
      page,
      `/api/runtime/v1/sessions/${session.id}/messages`,
    );
    assert.deepEqual(
      afterReload.map((row) => row.id),
      messages.map((row) => row.id),
    );
    report.checks.push(
      "idle capability reload preserves the real butler conversation and message history",
    );
    await page.screenshot({
      path: join(evidence, "butler-conversation.png"),
      fullPage: true,
    });
    report.checks.push(
      "real Codex butler conversation reads employee MCP, skills, channels and assistants using the bundled helper",
    );
    assert.deepEqual(report.errors, []);
    report.status = "passed";
  });
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  throw error;
} finally {
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify(report, null, 2));
