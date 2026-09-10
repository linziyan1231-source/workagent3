import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { baseURL, json, withPage } from "./smoke-dsh-helpers.mjs";
const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
await mkdir(evidence, { recursive: true });
const report = [];
await withPage(async (page) => {
  await page.evaluate(() =>
    localStorage.setItem("workagent.files.open", "false"),
  );
  const sessions = await json(page, "/api/runtime/v1/sessions");
  const rows = Array.isArray(sessions) ? sessions : sessions.sessions;
  const session =
    process.env.WORKAGENT_SMOKE_SESSION ||
    rows.find((s) => s.engine === "kimi").id;
  await page.goto(`${baseURL}/?frontend=dsh&session=${session}`);
  await page.locator(".workagent-message-list").waitFor();
  await page.getByLabel("当前会话思考强度", { exact: true }).waitFor();
  if (process.env.WORKAGENT_SMOKE_CSS)
    await page.addStyleTag({
      content: await readFile(process.env.WORKAGENT_SMOKE_CSS, "utf8"),
    });
  // Local DOM fixtures exercise the actual deployed scroll container without writing history.
  await page.locator(".workagent-message-list").evaluate((list) => {
    for (let i = 0; i < 20; i++) {
      const article = document.createElement("article");
      article.className = "workagent-message is-assistant";
      const body = document.createElement("div");
      body.textContent = "长对话布局回归检查。\n".repeat(10);
      article.append(body);
      list.append(article);
    }
    const tools = document.createElement("details");
    tools.className = "workagent-tool-history";
    tools.id = "tool-layout-check";
    const title = document.createElement("summary");
    title.textContent = "工具过程 · 1";
    tools.append(title);
    const tool = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "read_file · 完成";
    tool.append(summary);
    const output = document.createElement("pre");
    output.textContent = "工具输出内容\n".repeat(100);
    tool.append(output);
    tools.append(tool);
    list.append(tools);
  });
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 1024, height: 600 },
    { width: 390, height: 740 },
  ]) {
    await page.setViewportSize(viewport);
    for (const open of [false, true]) {
      await page.locator("#tool-layout-check").evaluate((el, open) => {
        el.open = open;
        el.querySelector("details").open = open;
        el.scrollTop = 0;
        el.parentElement.scrollTop = el.parentElement.scrollHeight;
      }, open);
      await page.waitForTimeout(150);
      const result = await page.locator("#tool-layout-check").evaluate((el) => {
        const box = el.getBoundingClientRect(),
          title = el.firstElementChild.getBoundingClientRect(),
          list = el.parentElement.getBoundingClientRect();
        return {
          height: el.clientHeight,
          scrollHeight: el.scrollHeight,
          titleTop: title.top,
          titleBottom: title.bottom,
          top: box.top,
          bottom: box.bottom,
          listBottom: list.bottom,
          shrink: getComputedStyle(el).flexShrink,
        };
      });
      report.push({ viewport, open, ...result });
      assert(
        result.titleTop >= result.top && result.titleBottom <= result.bottom,
        JSON.stringify(result),
      );
      assert(result.bottom <= result.listBottom + 1, JSON.stringify(result));
      assert.equal(result.shrink, "0");
      if (open) {
        assert(result.height >= 300);
        assert(result.scrollHeight > result.height);
        await page
          .locator("#tool-layout-check")
          .evaluate((el) => (el.scrollTop = el.scrollHeight));
        assert(
          await page
            .locator("#tool-layout-check")
            .evaluate((el) => el.scrollTop > 0),
        );
        await page.locator("#tool-layout-check").evaluate((el) => {
          el.scrollTop = 0;
        });
      }
      await page.screenshot({
        path: `${evidence}/tools-${viewport.width}-${open ? "open" : "closed"}.png`,
      });
    }
  }
});
await writeFile(
  `${evidence}/tool-history-report.json`,
  JSON.stringify(report, null, 2),
);
console.log("Tool history collapsed/expanded layout passed at all 3 viewports");
