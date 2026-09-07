import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { MAX_UPLOAD_BYTES, WorkspaceStore } from "./workspace-store.js";
import { WorkspaceController } from "./workspace-api.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "workagent-upload-"));
  roots.push(root);
  const store = new WorkspaceStore(join(root, "files"), join(root, "home"));
  const workspace = store.create("Upload test");
  return { store, id: workspace.id, root: store.engineRoot(workspace.id) };
}
async function* chunks(size: number) {
  const chunk = Buffer.alloc(1024 * 1024, 37);
  while (size > 0) {
    const length = Math.min(size, chunk.length);
    yield chunk.subarray(0, length);
    size -= length;
  }
}

it("streams exactly 1 GB to disk and back, and rejects one extra byte without replacing it", async () => {
  const { store, id, root } = setup();
  expect(MAX_UPLOAD_BYTES).toBe(1024 ** 3);
  const entry = await store.writeStream(
    id,
    "large.bin",
    chunks(MAX_UPLOAD_BYTES),
    false,
  );
  expect(entry.size).toBe(MAX_UPLOAD_BYTES);
  const content = await store.readStream(id, entry.path);
  expect(content.size).toBe(MAX_UPLOAD_BYTES);
  let size = 0;
  for await (const chunk of content.stream) {
    size += chunk.length;
    expect(chunk[0]).toBe(37);
  }
  expect(size).toBe(MAX_UPLOAD_BYTES);
  await expect(
    store.writeStream(id, "large.bin", chunks(MAX_UPLOAD_BYTES + 1)),
  ).rejects.toThrow("request_too_large");
  expect(store.listFiles(id)).toMatchObject([
    { name: "large.bin", size: MAX_UPLOAD_BYTES },
  ]);
  expect(readdirSync(join(root, ".workagent/uploads"))).toEqual([]);
}, 60000);

it("keeps existing files and cleans partial uploads after interruption or a concurrent exclusive upload", async () => {
  const { store, id, root } = setup();
  store.write(id, "notes.txt", Buffer.from("original"));
  async function* interrupted() {
    yield Buffer.from("partial");
    throw new Error("connection_aborted");
  }
  await expect(
    store.writeStream(id, "notes.txt", interrupted()),
  ).rejects.toThrow("connection_aborted");
  expect(store.read(id, "notes.txt").toString()).toBe("original");
  const uploads = await Promise.allSettled([
    store.writeStream(id, "race.bin", chunks(32 * 1024 * 1024), false),
    store.writeStream(id, "race.bin", chunks(32 * 1024 * 1024), false),
  ]);
  expect(
    uploads.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(uploads.find((result) => result.status === "rejected")).toMatchObject({
    reason: new Error("destination_exists"),
  });
  await expect(
    store.addAttachmentStream(
      id,
      "session",
      "partial.txt",
      "text/plain",
      interrupted(),
    ),
  ).rejects.toThrow("connection_aborted");
  expect(store.listAssets(id, "session")).toEqual([]);
  expect(readdirSync(join(root, ".workagent/uploads"))).toEqual([]);
});

it("serves authenticated streaming uploads and downloads and rejects oversized headers before reading the body", async () => {
  const { store, id, root } = setup();
  let handler!: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    webServer: {
      register: (route: { handler: typeof handler }) => {
        handler = route.handler;
      },
    },
  } as unknown as Context;
  new WorkspaceController(ctx, "test-upload-token", store, () => id);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/v1/workspaces/${id}`;
  const headers = { authorization: "Bearer test-upload-token" };
  try {
    const denied = await fetch(`${base}/content?path=denied.bin`, {
      method: "PUT",
      body: "x",
    });
    expect(denied.status).toBe(401);
    const oversized = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          `${base}/content?path=too-large.bin`,
          {
            method: "PUT",
            headers: { ...headers, "content-length": MAX_UPLOAD_BYTES + 1 },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("end", () => {
              resolve({ status: res.statusCode!, body });
              req.destroy();
            });
          },
        );
        req.on("error", reject);
        req.flushHeaders();
      },
    );
    expect(oversized).toEqual({
      status: 413,
      body: '{"error":"request_too_large"}',
    });
    expect(existsSync(join(root, "too-large.bin"))).toBe(false);
    const chunkedOversized = await fetch(
      `${base}/content?path=chunked-too-large.bin`,
      {
        method: "PUT",
        headers,
        body: chunks(MAX_UPLOAD_BYTES + 1),
        duplex: "half",
      } as unknown as RequestInit,
    );
    expect(chunkedOversized.status).toBe(413);
    expect(await chunkedOversized.json()).toEqual({
      error: "request_too_large",
    });
    expect(existsSync(join(root, "chunked-too-large.bin"))).toBe(false);
    expect(readdirSync(join(root, ".workagent/uploads"))).toEqual([]);
    const response = await fetch(
      `${base}/attachments?sessionId=session&name=large.bin`,
      {
        method: "PUT",
        headers,
        body: chunks(32 * 1024 * 1024),
        duplex: "half",
      } as unknown as RequestInit,
    );
    expect(response.status).toBe(201);
    const asset = (await response.json()) as { path: string; size: number };
    expect(asset.size).toBe(32 * 1024 * 1024);
    const download = await fetch(
      `${base}/content?path=${encodeURIComponent(asset.path)}`,
      { headers },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-length")).toBe(String(asset.size));
    let size = 0;
    for await (const chunk of download.body!) size += chunk.length;
    expect(size).toBe(asset.size);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 30000);
