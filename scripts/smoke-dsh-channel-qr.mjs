import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { baseURL, withPage } from "./smoke-dsh-helpers.mjs";
await withPage(async (page) => {
  const results = [];
  const other = await page.context().browser().newContext();
  try {
    const login = await other.request.post(baseURL + "/api/auth/login", {
      data: {
        username: process.env.WORKAGENT_SMOKE_SECOND_USERNAME,
        password: process.env.WORKAGENT_SMOKE_SECOND_PASSWORD,
      },
      headers: { Origin: new URL(baseURL).origin },
    });
    assert(login.ok());
    for (const id of ["weixin", "wecom", "feishu", "dingtalk"]) {
      const path = baseURL + "/dsh-im-connect/api/channels/" + id + "/qr/";
      try {
        const reply = await page.request.post(path + "start", {
          data: {},
          headers: {
            "x-dsh-im-connect-client": "1",
            Origin: new URL(baseURL).origin,
          },
          timeout: 45000,
        });
        const body = await reply.json();
        const result = {
          channel: id,
          status: reply.status(),
          state: body.pairing?.status,
          hasQr: !!body.pairing?.qrImage,
          error: body.error,
        };
        const isolated = await (
          await other.request.get(path + "status")
        ).json();
        result.otherEmployeeState = isolated.pairing?.status;
        assert.equal(result.otherEmployeeState, "idle");
        results.push(result);
        console.log(JSON.stringify(result));
      } finally {
        await page.request.post(path + "cancel", {
          data: {},
          headers: {
            "x-dsh-im-connect-client": "1",
            Origin: new URL(baseURL).origin,
          },
          timeout: 15000,
        });
      }
    }
  } finally {
    await other.close();
    const dir = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
    if (dir) {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "channels-qr-smoke.json"),
        JSON.stringify(results, null, 2),
      );
    }
  }
  assert(results.every((x) => x.hasQr && x.status === 200));
  console.log(
    "All four live QR services and employee QR-state isolation passed; all unused QR sessions cancelled",
  );
});
