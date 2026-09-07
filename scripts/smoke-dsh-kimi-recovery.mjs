import {
  json,
  withPage,
  uniqueName,
  killSmokeProcess,
  openDshAfterRestart,
  restartSmokeRuntime,
  rememberedSmokeProcessSID,
  resolveRemoteSmokeProcess,
} from "./smoke-dsh-helpers.mjs";

await withPage(async (page) => {
  const project = await json(page, "/api/runtime/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: uniqueName("kimi-upgrade") }),
  });
  const sessions = [];
  async function turn(id, marker) {
    await json(page, `/api/runtime/v1/sessions/${id}/turns`, {
      method: "POST",
      body: JSON.stringify({
        content: `Reply with exactly ${marker}. Do not call tools or modify files.`,
      }),
    });
    const messages = await json(
      page,
      `/api/runtime/v1/sessions/${id}/messages`,
    );
    const turnId = messages
      .filter((message) => message.role === "user")
      .at(-1).nativeTurnId;
    await page.evaluate(
      ({ id, turnId }) =>
        new Promise((resolve, reject) => {
          const stream = new EventSource(
            `/api/runtime/v1/sessions/${id}/events`,
          );
          const finish = (error) => {
            clearTimeout(timer);
            stream.close();
            if (error) reject(error);
            else resolve();
          };
          const timer = setTimeout(
            () => finish(new Error("Kimi turn timed out")),
            90_000,
          );
          stream.onmessage = ({ data }) => {
            const event = JSON.parse(data);
            if (event.turnId !== turnId) return;
            if (event.type === "turn.completed") finish();
            else if (["turn.failed", "turn.cancelled"].includes(event.type))
              finish(new Error(event.message || event.type));
          };
          stream.onerror = () => finish(new Error("Kimi event stream failed"));
        }),
      { id, turnId },
    );
    const completed = await json(
      page,
      `/api/runtime/v1/sessions/${id}/messages`,
    );
    if (
      !completed.some(
        (message) =>
          message.role === "assistant" &&
          message.nativeTurnId === turnId &&
          message.text.includes(marker),
      )
    )
      throw new Error(`Kimi did not reply with ${marker}`);
  }
  try {
    const group = (await json(page, "/api/runtime/v1/model-options")).find(
      (group) => group.engine === "kimi",
    );
    const model = group.models[0];
    const session = await json(page, "/api/runtime/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        engine: "kimi",
        title: uniqueName("kimi-recovery"),
        workspace: project.id,
        modelId: model.id,
        thinkingEffort: model.reasoning[0].id,
        permissionMode: "read_only",
      }),
    });
    sessions.push(session.id);
    await turn(session.id, "KIMI_UPGRADE_CREATE_OK");
    const pid = await resolveRemoteSmokeProcess(
      Number(process.env.WORKAGENT_SMOKE_HARNESS_PID),
      "node.exe",
      rememberedSmokeProcessSID(),
    );
    await killSmokeProcess(pid);
    await page.waitForFunction(async () => {
      try {
        return !(await fetch("/api/runtime/v1/sessions")).ok;
      } catch {
        return true;
      }
    });
    await restartSmokeRuntime(page);
    await openDshAfterRestart(page, "/?frontend=dsh");
    await json(page, `/api/runtime/v1/sessions/${session.id}/resume`, {
      method: "POST",
    });
    await turn(session.id, "KIMI_UPGRADE_RESUME_OK");
    const messages = await json(
      page,
      `/api/runtime/v1/sessions/${session.id}/messages`,
    );
    const last = messages.filter((message) => message.role === "user").at(-1);
    const fork = await json(
      page,
      `/api/runtime/v1/sessions/${session.id}/fork`,
      { method: "POST", body: JSON.stringify({ messageId: last.id }) },
    );
    sessions.push(fork.id);
    if (fork.id === session.id)
      throw new Error("Fork did not create a distinct conversation");
    await turn(fork.id, "KIMI_UPGRADE_FORK_OK");
    console.log(
      "dsh Kimi create, runtime restart, resume, fork and real turns passed",
    );
  } finally {
    for (const id of sessions)
      await json(page, `/api/runtime/v1/sessions/${id}`, { method: "DELETE" });
    await json(page, `/api/runtime/v1/workspaces/${project.id}`, {
      method: "DELETE",
    });
  }
});
