import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { baseURL, login, json } from "./smoke-dsh-helpers.mjs";
const engine = process.env.WORKAGENT_SMOKE_WEBKIT ? "webkit" : "chromium";
const output = `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/${engine}`;
await mkdir(output, { recursive: true });
const browser = await { chromium, webkit }[engine].launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const report = {
  checks: [],
  errors: [],
  preview: !!process.env.WORKAGENT_SMOKE_CLIENT,
};
const created = [];
await page.addInitScript(() =>
  localStorage.setItem("workagent.files.open", "false"),
);
page.on("pageerror", (error) => report.errors.push(error.message));
for (const [env, name, type] of [
  ["WORKAGENT_SMOKE_CLIENT", "client.js", "text/javascript"],
  ["WORKAGENT_SMOKE_CSS", "tokens.css", "text/css"],
]) {
  if (process.env[env]) {
    const body = await readFile(process.env[env], "utf8");
    await page.route(`**/plugins/@workagent/dsh-client/${name}*`, (route) =>
      route.fulfill({ contentType: type, body }),
    );
  }
}
// Only pre-publication previews use a configuration fixture; final runs read the engine.
if (report.preview)
  await page.route("**/api/runtime/v1/sessions/*/configuration", (route) =>
    route.fulfill({ json: { permissionMode: "workspace_write" } }),
  );
async function check(formSelector, kind, agent, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(350);
  const form = page.locator(formSelector);
  const input = form.locator("textarea");
  await input.fill("test");
  const value = await form.evaluate((form) => {
    const input = form.querySelector("textarea"),
      r = form.getBoundingClientRect(),
      ir = input.getBoundingClientRect();
    const selects = [
      ...form.querySelectorAll(
        ".workagent-composer-options select,.workagent-session-controls select",
      ),
    ];
    const model = selects[0],
      style = getComputedStyle(model),
      canvas = document.createElement("canvas"),
      ctx = canvas.getContext("2d");
    ctx.font = style.font;
    const text = model.selectedOptions[0]?.textContent || "";
    return {
      topGap: ir.top - r.top + parseFloat(getComputedStyle(input).paddingTop),
      overflow: form.scrollWidth > form.clientWidth + 2,
      modelText: text,
      modelWidth: model.getBoundingClientRect().width,
      textWidth: ctx.measureText(text).width,
      controls: selects.map((el) => ({
        top: el.getBoundingClientRect().top,
        right: el.getBoundingClientRect().right,
        value: el.value,
        label: el.selectedOptions[0]?.textContent,
        heading: el.querySelector("optgroup")?.label,
        options: [...el.options].map((o) => o.textContent),
      })),
      right: r.right,
    };
  });
  assert(value.topGap <= 16, JSON.stringify({ kind, agent, width, value }));
  assert(!value.overflow, JSON.stringify(value));
  assert(
    value.modelWidth <= Math.ceil(value.textWidth) + 38,
    JSON.stringify(value),
  );
  assert(
    value.controls.every(
      (c) =>
        Math.abs(c.top - value.controls[0].top) < 1 && c.right <= value.right,
    ),
    JSON.stringify(value),
  );
  assert.equal(value.controls[1].heading, "思考强度");
  assert.equal(value.controls[2].heading, "权限");
  assert(
    value.controls
      .slice(1)
      .every((c) => c.value && !c.options.some((s) => s.includes("默认"))),
    JSON.stringify(value),
  );
  report.checks.push({ kind, agent, width, ...value });
  if ([390, 1440].includes(width))
    await form.screenshot({ path: `${output}/${kind}-${agent}-${width}.png` });
  await input.fill("");
}
try {
  await login(page);
  for (const agent of ["Codex", "Kimi"]) {
    await page
      .locator(".workagent-agent")
      .filter({ hasText: new RegExp(`^${agent}$`) })
      .click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[aria-label="模型"]');
      return el && !el.disabled && el.value;
    });
    await page.locator(".workagent-project-select select").selectOption("none");
    for (const width of [1440, 390, 320])
      await check(".workagent-hero-composer", "home", agent, width);
  }
  const models = await json(page, "/api/runtime/v1/model-options");
  for (const engine of ["kimi", "codex"]) {
    const session = await json(page, "/api/runtime/v1/sessions", {
      method: "POST",
      body: JSON.stringify({
        engine,
        workspace: "default",
        title: `composer-controls-smoke-${Date.now()}`,
      }),
    });
    created.push(session.id);
    await page.evaluate((id) => {
      const url = new URL(location.href);
      url.searchParams.set("session", id);
      history.pushState(null, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, session.id);
    const effort = page.getByLabel("当前会话思考强度", { exact: true });
    await effort.waitFor({ timeout: 60000 });
    await page.waitForFunction(
      () => document.querySelector('[aria-label="当前会话权限"]')?.value,
    );
    const configuration = report.preview
      ? { permissionMode: "workspace_write" }
      : await json(
          page,
          `/api/runtime/v1/sessions/${session.id}/configuration`,
        );
    assert.equal(
      await page.getByLabel("当前会话权限", { exact: true }).inputValue(),
      configuration.permissionMode,
    );
    const selectedModel = (
      await page.getByLabel("当前会话模型", { exact: true }).inputValue()
    ).slice(engine.length + 1);
    const model = models
      .find((g) => g.engine === engine)
      ?.models.find((m) => m.id === selectedModel);
    if (model?.defaultReasoning)
      assert.equal(await effort.inputValue(), model.defaultReasoning);
    for (const width of [1440, 390, 320])
      await check(
        ".workagent-conversation-composer",
        "conversation",
        engine,
        width,
      );
    const queueGap = await page
      .locator(".workagent-conversation-composer")
      .evaluate((form) => {
        const queue = document.createElement("div");
        queue.className = "workagent-message-queue";
        queue.textContent = "排队消息";
        form.prepend(queue);
        const gap =
          form.querySelector("textarea").getBoundingClientRect().top -
          queue.getBoundingClientRect().bottom;
        queue.remove();
        return gap;
      });
    assert(queueGap >= 4, "A populated queue keeps its own row");
    const after = await json(page, `/api/runtime/v1/sessions/${session.id}`);
    assert.equal(
      after.permissionMode,
      undefined,
      "Reading does not persist a permission choice",
    );
    assert.equal(
      after.thinkingEffort,
      undefined,
      "Displaying a default does not change reasoning",
    );
  }
  assert.deepEqual(report.errors, []);
  console.log(
    JSON.stringify({
      checks: report.checks.length,
      errors: report.errors,
      preview: report.preview,
    }),
  );
} catch (error) {
  report.failure = error.message;
  await page.screenshot({ path: `${output}/failure.png` });
  throw error;
} finally {
  for (const id of created)
    await page.request.delete(
      `${baseURL}/api/runtime/v1/sessions/${encodeURIComponent(id)}`,
    );
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
