import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "playwright";
const baseURL = process.env.WORKAGENT_SMOKE_URL;
const api = await request.newContext({
  baseURL,
  extraHTTPHeaders: { Origin: baseURL },
});
const report = {};
try {
  assert.ok(
    (
      await api.post("/api/auth/login", {
        data: {
          username: process.env.WORKAGENT_SMOKE_USERNAME,
          password: process.env.WORKAGENT_SMOKE_PASSWORD,
        },
      })
    ).ok(),
  );
  const response = await api.post("/api/runtime/v1/imports/mcp", {
    data: {
      mcpServers: {
        [`import-verified-${Date.now()}`]: {
          command: "C:\\Windows\\System32\\cmd.exe",
          args: ["/c", "exit", "0"],
          env: { IMPORT_FIXTURE: "not-a-real-secret" },
        },
        invalid: { type: "unsupported" },
      },
    },
  });
  assert.ok(response.ok(), await response.text());
  const rows = await response.json();
  assert.equal(rows.filter((x) => x.resourceId).length, 1);
  assert.equal(rows.filter((x) => x.error).length, 1);
  const id = rows.find((x) => x.resourceId).resourceId;
  const catalog = await (await api.get("/api/runtime/v1/mcp-servers")).json();
  assert.ok(JSON.stringify(catalog).includes(id));
  assert.ok(!JSON.stringify(catalog).includes("not-a-real-secret"));
  const history = await (await api.get("/api/runtime/v1/imports")).json();
  assert.ok(JSON.stringify(history).includes(id));
  assert.ok(!JSON.stringify(history).includes("not-a-real-secret"));
  assert.ok((await api.delete(`/api/runtime/v1/mcp-servers/${id}`)).ok());
  Object.assign(report, {
    complete: true,
    partialFailure: true,
    credentialValueHidden: true,
    persistentHistory: true,
    fixtureRemoved: true,
  });
} finally {
  await api.dispose();
  await writeFile(
    join(process.env.WORKAGENT_SMOKE_EVIDENCE_DIR, "remaining-mcp-import.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
