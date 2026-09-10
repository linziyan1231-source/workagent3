import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseURL, json, withPage } from "./smoke-dsh-helpers.mjs";
const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
const prior = JSON.parse(
  await readFile(join(evidence, "remaining-native-features.json"), "utf8"),
);
const report = process.env.WORKAGENT_SKILL_RESUME
  ? JSON.parse(
      await readFile(join(evidence, "skill-suggestion-real.json"), "utf8"),
    )
  : {};
const body = (value, method = "POST") => ({
  method,
  body: JSON.stringify(value),
});
await withPage(async (page) => {
  try {
    const automation = report.automation
      ? await json(page, `/api/runtime/v1/automations/${report.automation}`)
      : await json(
          page,
          "/api/runtime/v1/automations",
          body({
            name: `技能建议验收-${Date.now()}`,
            enabled: false,
            schedule: { kind: "interval", everyMinutes: 60 },
            presetId: "builtin-kimi",
            engine: "kimi",
            workspaceId: prior.workspace,
            input:
              "执行一个小任务：演示把 abc 转成大写，得到 ABC。把这个经过演示的步骤按后附要求写成技能建议文件，技能名 uppercase-demo。只生成该建议文件，不改其他文件。",
            notificationPolicy: "none",
            executionMode: "new_conversation",
            conversationId: null,
          }),
        );
    report.automation = automation.id;
    const run = report.run
      ? { id: report.run }
      : await json(
          page,
          `/api/runtime/v1/automations/${automation.id}/run`,
          body({}),
        );
    report.run = run.id;
    await writeFile(
      join(evidence, "skill-suggestion-real.json"),
      JSON.stringify(report, null, 2),
    );
    const end = Date.now() + 180000;
    let outcome;
    while (Date.now() < end) {
      outcome = (
        await json(page, `/api/runtime/v1/automations/${automation.id}/runs`)
      ).find((row) => row.id === run.id);
      if (!["pending", "running"].includes(outcome.status)) break;
      if (outcome.sessionId) {
        report.runningSessionLinked = true;
        const interactions = await json(
          page,
          `/api/runtime/v1/interactions?sessionId=${encodeURIComponent(outcome.sessionId)}`,
        );
        for (const item of interactions.filter(
          (item) => item.status === "pending",
        )) {
          const text = item.input?.content?.[0]?.content?.text;
          const allowed =
            item.native &&
            item.input.content.length === 1 &&
            ((item.tool === "Bash" &&
              [
                `Requesting approval to Running: echo "abc" | tr 'a-z' 'A-Z'`,
                `Requesting approval to Running: echo "abc" | tr '[:lower:]' '[:upper:]'`,
              ].includes(text)) ||
              (item.tool === "Write" &&
                text ===
                  `Requesting approval to Writing .workagent/skill-suggestions/${run.id}/SKILL.md`));
          if (!allowed) continue;
          await json(
            page,
            `/api/runtime/v1/interactions/${encodeURIComponent(item.id)}/respond`,
            body({ decision: "allow" }),
          );
          (report.fixtureApprovals ??= []).push({
            id: item.id,
            tool: item.tool,
            summary: text,
          });
        }
      }
      await page.waitForTimeout(1500);
    }
    report.outcome = outcome;
    assert.equal(outcome.status, "succeeded", JSON.stringify(outcome));
    assert.ok(outcome.skillSuggestionPath);
    await page.goto(`${baseURL}/?frontend=dsh&workagent=automations`);
    const card = page
      .locator(".workagent-card")
      .filter({ has: page.getByText(automation.name, { exact: true }) });
    await card.getByRole("button", { name: "运行记录", exact: true }).click();
    await card
      .getByRole("button", { name: "预览技能建议", exact: true })
      .click();
    await card.getByLabel("建议技能内容").waitFor();
    assert.match(
      await card.getByLabel("建议技能内容").inputValue(),
      /uppercase|ABC/i,
    );
    await card
      .getByLabel("建议技能名称")
      .fill(`uppercase-verified-${Date.now()}`);
    await page.screenshot({
      path: join(evidence, "remaining-skill-preview.png"),
      animations: "disabled",
    });
    await card
      .getByRole("button", { name: "保存技能并绑定任务", exact: true })
      .click();
    for (let i = 0; i < 30; i++) {
      const latest = await json(
        page,
        `/api/runtime/v1/automations/${automation.id}`,
      );
      if (latest.skillId) break;
      await page.waitForTimeout(1000);
    }
    report.skillId = (
      await json(page, `/api/runtime/v1/automations/${automation.id}`)
    ).skillId;
    assert.ok(report.skillId);
    await page.screenshot({
      path: join(evidence, "remaining-skill-suggestion.png"),
      animations: "disabled",
    });
    report.complete = true;
    await json(page, `/api/runtime/v1/automations/${automation.id}`, {
      method: "DELETE",
    });
  } finally {
    await writeFile(
      join(evidence, "skill-suggestion-real.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  }
});
