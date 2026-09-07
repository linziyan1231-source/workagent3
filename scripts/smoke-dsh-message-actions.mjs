import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { baseURL, json, withPage } from "./smoke-dsh-helpers.mjs";

await withPage(async (page) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: baseURL,
  });
  const root = "/api/runtime/v1/sessions";
  const sessions = await json(page, root);
  let source, original, answer;
  for (const session of sessions.filter(
    (s) =>
      ["codex", "kimi"].includes(s.engine) &&
      s.activity.state === "idle" &&
      !s.parentSessionId,
  )) {
    const messages = await json(page, `${root}/${session.id}/messages`);
    const reply = messages.find(
      (m) => m.role === "assistant" && m.text && m.nativeTurnId,
    );
    if (reply) {
      source = session;
      original = messages;
      answer = reply;
      break;
    }
  }
  assert(source, "An existing completed native conversation is required");
  let forkID;
  try {
    await page.goto(`${baseURL}/?frontend=dsh&session=${source.id}`);
    const row = page.locator(`[data-message-id="${answer.id}"]`);
    await row.hover();
    await row.getByRole("button", { name: "复制", exact: true }).click();
    await row.getByRole("button", { name: "已复制", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      answer.text,
    );
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith(`/${source.id}/fork`),
    );
    await row.getByRole("button", { name: "分支", exact: true }).click();
    const result = await response;
    assert.equal(result.status(), 201);
    await page.waitForURL(
      (u) =>
        u.searchParams.has("session") &&
        u.searchParams.get("session") !== source.id,
    );
    forkID = new URL(page.url()).searchParams.get("session");
    const fork = await json(page, `${root}/${forkID}`);
    assert.equal(fork.parentSessionId, source.id);
    const messages = await json(page, `${root}/${forkID}/messages`);
    assert(
      messages.some((m) => m.role === "assistant" && m.text === answer.text),
    );
    assert.deepEqual(
      await json(page, `${root}/${source.id}/messages`),
      original,
    );
    if (process.env.WORKAGENT_SMOKE_EVIDENCE_DIR)
      await writeFile(
        `${process.env.WORKAGENT_SMOKE_EVIDENCE_DIR}/message-actions.json`,
        JSON.stringify(
          {
            checkedAt: new Date().toISOString(),
            engine: source.engine,
            copiedExactText: true,
            branchedAtAssistantReply: true,
            originalPreserved: true,
          },
          null,
          2,
        ),
      );
  } finally {
    if (!forkID) {
      const current = new URL(page.url()).searchParams.get("session");
      if (current && current !== source.id) forkID = current;
    }
    if (forkID) await json(page, `${root}/${forkID}`, { method: "DELETE" });
  }
});
console.log(
  "Message actions passed: exact clipboard text and actual fork at an agent reply, original preserved",
);
