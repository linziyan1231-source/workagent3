import assert from "node:assert/strict";
import { mkdtemp, open, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { baseURL, json, uniqueName, withPage } from "./smoke-dsh-helpers.mjs";

const size = 5 * 1024 ** 3;
const fixture = await mkdtemp(join(tmpdir(), "workagent-large-upload-"));
try {
  const file = await open(join(fixture, "5GB-streaming-test.bin"), "wx");
  await file.truncate(size);
  await file.write(Buffer.from("stream-start"), 0, 12, 0);
  await file.write(Buffer.from([73]), 0, 1, size - 1);
  await file.close();
  const oversized = await open(join(fixture, "too-large.bin"), "wx");
  await oversized.truncate(size + 1);
  await oversized.close();
  await withPage(
    async (page) => {
      const evidence = process.env.WORKAGENT_SMOKE_EVIDENCE_DIR;
      if (evidence) await mkdir(evidence, { recursive: true });
      const workspace = await json(page, "/api/runtime/v1/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: uniqueName("大文件上传验收") }),
      });
      const root = `/api/runtime/v1/workspaces/${workspace.id}`;
      const content = `${root}/content?path=5GB-streaming-test.bin`;
      const start = performance.now();
      try {
        await page.goto(`${baseURL}/?frontend=dsh&project=${workspace.id}`);
        const toggle = page.getByRole("button", {
          name: "打开文件侧栏",
          exact: true,
        });
        if (await toggle.count()) await toggle.click();
        const panel = page.getByRole("complementary", { name: "项目文件侧栏" });
        await panel
          .getByText("拖入文件上传 · 单个最大 5 GB", { exact: true })
          .waitFor();
        const uploaded = page.waitForResponse(
          (response) =>
            response.request().method() === "PUT" &&
            response.url().includes("5GB-streaming-test.bin"),
          { timeout: 3600000 },
        );
        console.log(
          "Uploading a real 5 GB file through the authenticated browser and tunnel",
        );
        await panel
          .getByLabel("选择上传文件")
          .setInputFiles(join(fixture, "5GB-streaming-test.bin"));
        const response = await uploaded;
        assert.equal(response.status(), 200);
        // Large request bodies can evict the DevTools response cache. Verify the
        // persisted file with a fresh API read instead of Network.getResponseBody.
        const files = await json(page, `${root}/files`);
        assert.equal(
          files.find((entry) => entry.path === "5GB-streaming-test.bin")?.size,
          size,
        );
        await panel
          .getByRole("button", { name: "5GB-streaming-test.bin", exact: true })
          .waitFor();
        const uploadSeconds = (performance.now() - start) / 1000;
        console.log(
          `5 GB upload completed in ${uploadSeconds.toFixed(1)} seconds`,
        );
        await panel
          .getByLabel("选择上传文件")
          .setInputFiles(join(fixture, "too-large.bin"));
        await panel
          .getByText("too-large.bin：超过 5 GB", { exact: true })
          .waitFor();
        if (evidence)
          await page.screenshot({ path: join(evidence, "large-upload.png") });
        const cookies = await page.context().cookies(baseURL);
        const download = await fetch(`${baseURL}${content}`, {
          headers: {
            cookie: cookies
              .map(({ name, value }) => `${name}=${value}`)
              .join("; "),
          },
        });
        assert.equal(download.status, 200);
        assert.equal(Number(download.headers.get("content-length")), size);
        let received = 0;
        let first = Buffer.alloc(0);
        let last;
        for await (const chunk of download.body) {
          if (first.length < 12)
            first = Buffer.concat([
              first,
              Buffer.from(chunk.subarray(0, 12 - first.length)),
            ]);
          received += chunk.length;
          last = chunk.at(-1);
        }
        assert.equal(received, size);
        assert.equal(first.toString(), "stream-start");
        assert.equal(last, 73);
        const report = {
          size,
          uploadSeconds,
          totalSeconds: (performance.now() - start) / 1000,
          browserUpload: true,
          oversizedRejected: true,
          streamedDownloadBytes: received,
          firstAndLastBytesVerified: true,
        };
        if (evidence)
          await writeFile(
            join(evidence, "large-upload.json"),
            JSON.stringify(report, null, 2),
          );
        console.log(
          "5 GB browser upload, oversized rejection and complete streaming download verified",
        );
      } finally {
        // Shrink only this generated fixture before the recoverable project removal.
        await page.request.put(`${baseURL}${content}`, {
          data: "",
          headers: { Origin: new URL(baseURL).origin },
        });
        await json(page, root, { method: "DELETE" });
      }
    },
    { channel: "chromium" },
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
