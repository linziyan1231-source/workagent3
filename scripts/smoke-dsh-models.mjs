import { baseURL, json, uniqueName, withPage } from "./smoke-dsh-helpers.mjs";

await withPage(async (page) => {
  const project = await json(page, "/api/runtime/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ name: uniqueName("dsh-models") }),
  });
  const sessions = [];
  try {
    for (const [engine, label] of [
      ["harness", "DSH"],
      ["codex", "Codex"],
      ["kimi", "Kimi"],
    ]) {
      const [response] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().includes("/model-options") && response.ok(),
        ),
        page.goto(`${baseURL}/?frontend=dsh`),
      ]);
      const group = (await response.json()).find(
        (group) => group.engine === engine,
      );
      if (group?.state !== "ready")
        throw new Error(`${engine} model discovery failed`);
      if (
        engine === "codex" &&
        group.models.some(
          (model) =>
            model.defaultReasoning === "ultra" ||
            model.reasoning.some((effort) => effort.id === "ultra"),
        )
      )
        throw new Error("Codex still advertises the disabled ultra effort");
      const requestedModel =
        engine === "codex"
          ? process.env.WORKAGENT_SMOKE_CODEX_MODEL
          : undefined;
      const model = requestedModel
        ? group.models.find((model) => model.id === requestedModel)
        : group.models.find((model) => model.isDefault) || group.models[0];
      if (!model)
        throw new Error(`${engine} does not advertise ${requestedModel}`);
      const effort =
        model.reasoning.find(
          (effort) => effort.id !== model.defaultReasoning,
        ) || model.reasoning[0];
      await page.getByRole("radio", { name: label, exact: true }).click();
      await page
        .getByRole("combobox", { name: "个人项目", exact: true })
        .selectOption(project.id);
      await page
        .getByRole("combobox", { name: "模型", exact: true })
        .selectOption(model.id);
      if (
        engine === "codex" &&
        (await page
          .getByRole("combobox", { name: "思考级别", exact: true })
          .locator('option[value="ultra"]')
          .count()) !== 0
      )
        throw new Error("Codex composer still offers ultra");
      if (effort)
        await page
          .getByRole("combobox", { name: "思考级别", exact: true })
          .selectOption(effort.id);
      await page
        .getByRole("combobox", { name: "权限", exact: true })
        .selectOption("read_only");
      await page
        .getByLabel("输入消息", { exact: true })
        .fill(
          "Reply with exactly MODEL_OPTIONS_OK. Do not call tools or modify files.",
        );
      await page.getByLabel("输入消息", { exact: true }).press("Enter");
      await page.waitForURL((url) => url.searchParams.has("session"), {
        timeout: 60_000,
      });
      const id = new URL(page.url()).searchParams.get("session");
      sessions.push(id);
      const session = await json(page, `/api/runtime/v1/sessions/${id}`);
      if (
        session.modelId !== model.id ||
        (effort && session.thinkingEffort !== effort.id)
      )
        throw new Error(
          `${engine} did not persist the selected model and effort`,
        );
      await page
        .locator(".workagent-message.is-assistant .workagent-markdown")
        .filter({ hasText: "MODEL_OPTIONS_OK" })
        .waitFor({ timeout: 120_000 });
      console.log(
        `${engine} ${model.id} (${effort?.id || "default"}) completed a browser turn`,
      );
    }
  } finally {
    for (const id of sessions)
      await json(page, `/api/runtime/v1/sessions/${id}`, { method: "DELETE" });
    await json(page, `/api/runtime/v1/workspaces/${project.id}`, {
      method: "DELETE",
    });
  }
});
console.log("dsh live model selection smoke passed");
