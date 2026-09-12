import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceStore } from "./workspace-store.js";
import { nativeFileInput, nativeImages } from "./native-images.js";
import { fileReferenceText, fileReferenceParts } from "@workagent/contracts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wa-file-references-"));
  roots.push(root);
  const home = join(root, "home"),
    work = join(root, "work");
  const store = new WorkspaceStore(work, home);
  return { root, home, work, store, project: store.create("project") };
}
async function upload(
  store: WorkspaceStore,
  id: string,
  path: string,
  bytes: Buffer,
) {
  const row = store.uploads.create(id, {
    path,
    name: path.split("/").at(-1)!,
    size: bytes.length,
    lastModified: 1,
    conflict: "rename",
  });
  await store.uploads.append(
    id,
    row.id,
    0,
    (async function* () {
      yield bytes;
    })(),
  );
  return { row, file: await store.uploads.finish(id, row.id) };
}
it("publishes concurrent same-name uploads without replacing originals, and completion retries keep the saved name", async () => {
  const { store, project } = fixture();
  store.write(project.id, "三七互娱.docx", Buffer.from("original"));
  const results = await Promise.all(
    ["one", "two"].map((text) =>
      upload(store, project.id, "三七互娱.docx", Buffer.from(text)),
    ),
  );
  expect(results.map((result) => result.file.path).sort()).toEqual([
    "三七互娱 (1).docx",
    "三七互娱 (2).docx",
  ]);
  expect(store.read(project.id, "三七互娱.docx").toString()).toBe("original");
  for (const result of results)
    expect(await store.uploads.finish(project.id, result.row.id)).toEqual(
      result.file,
    );
  expect(store.uploads.list(project.id)).toEqual([]);
});
it("keeps session attachments outside project files across restart and resolves images from the bound workspace", async () => {
  const { store, project, work, home } = fixture();
  const other = store.create("other");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO3sAAAAASUVORK5CYII=",
    "base64",
  );
  const { file } = await upload(
    store,
    project.id,
    ".workagent-attachments/session-one/upload-id/图片.png",
    png,
  );
  expect(readdirSync(store.engineRoot(project.id))).toEqual([]);
  const restarted = new WorkspaceStore(work, home);
  const reference = fileReferenceText({
    workspaceId: project.id,
    path: file.path,
    name: file.name,
  });
  const input = `请分析 ${reference} 并保留原图`;
  expect(nativeFileInput(restarted, other.id, input)).toContain(
    JSON.stringify(restarted.referencePath(project.id, file.path)),
  );
  expect(readFileSync(restarted.referencePath(project.id, file.path))).toEqual(
    png,
  );
  expect(await nativeImages(restarted, other.id, input + reference)).toEqual([
    { mimeType: "image/png", data: png.toString("base64") },
  ]);
  expect(restarted.locate(project.id, file.path).name).toBe("图片.png");
  expect(() => restarted.read(other.id, file.path)).toThrow("file_not_found");
  expect(() =>
    nativeFileInput(
      restarted,
      project.id,
      fileReferenceText({
        path: ".workagent-attachments/../secret",
        name: "secret",
      }),
    ),
  ).toThrow("invalid_relative_path");
  expect(() =>
    nativeFileInput(
      restarted,
      project.id,
      fileReferenceText({ path: "C:/Windows/secret", name: "secret" }),
    ),
  ).toThrow("invalid_relative_path");
});
it("keeps legacy references readable and round-trips Chinese, whitespace, quotes and braces", () => {
  const { store, project } = fixture();
  const name = "中文 {项目} 空格.txt";
  store.write(project.id, name, Buffer.from("hello"));
  const reference = {
    workspaceId: project.id,
    path: name,
    name: '展示 "名称".txt',
  };
  const text = fileReferenceText(reference);
  expect(fileReferenceParts(text)[0]?.reference).toEqual(reference);
  expect(
    nativeFileInput(store, project.id, `项目文件：${JSON.stringify(name)}`),
  ).toContain(JSON.stringify(store.referencePath(project.id, name)));
});
