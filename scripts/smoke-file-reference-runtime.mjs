import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";

const [profile, evidence] = process.argv.slice(2);
assert(profile && evidence, "profile and isolated evidence directory required");
const require = createRequire(join(profile, "package.json"));
const bundle = dirname(require.resolve("@workagent/harness-bundle"));
const { WorkspaceStore } = await import(
  pathToFileURL(join(bundle, "workspace-store.js"))
);
const { nativeFileInput, nativeImages } = await import(
  pathToFileURL(join(bundle, "native-images.js"))
);
await import(pathToFileURL(join(bundle, "runtime.js")));
await mkdir(evidence, { recursive: true });
const scratch = await mkdtemp(join(evidence, "runtime-fixture-"));
const root = join(scratch, "projects"),
  home = join(scratch, "home");
let store = new WorkspaceStore(root, home);
const project = store.create("reference-test");
store.write(project.id, "报告.docx", Buffer.from("original"));
async function upload(path, bytes) {
  const row = store.uploads.create(project.id, {
    path,
    name: path.split("/").at(-1),
    size: bytes.length,
    lastModified: 1,
    conflict: "rename",
  });
  await store.uploads.append(
    project.id,
    row.id,
    0,
    (async function* () {
      yield bytes;
    })(),
  );
  const file = await store.uploads.finish(project.id, row.id);
  assert.deepEqual(await store.uploads.finish(project.id, row.id), file);
  return file;
}
const files = await Promise.all(
  ["first", "second"].map((value) => upload("报告.docx", Buffer.from(value))),
);
assert.deepEqual(files.map((file) => file.path).sort(), [
  "报告 (1).docx",
  "报告 (2).docx",
]);
assert.equal(store.read(project.id, "报告.docx").toString(), "original");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO3sAAAAASUVORK5CYII=",
  "base64",
);
const attachment = await upload(
  ".workagent-attachments/session-test/image/图片.png",
  png,
);
assert(
  !store
    .listFiles(project.id)
    .some((file) => file.path.startsWith(".workagent-attachments")),
);
store = new WorkspaceStore(root, home);
const reference = `项目文件：${JSON.stringify({ workspaceId: project.id, path: attachment.path, name: attachment.name })}`;
const absolute = store.referencePath(project.id, attachment.path);
assert(relative(root, absolute).startsWith(".."));
assert.deepEqual(await readFile(absolute), png);
assert(
  nativeFileInput(store, project.id, reference).includes(
    JSON.stringify(absolute),
  ),
);
assert.deepEqual(await nativeImages(store, project.id, reference), [
  { mimeType: "image/png", data: png.toString("base64") },
]);
assert.throws(
  () => store.referencePath(project.id, ".workagent-attachments/../private"),
  /invalid_relative_path/,
);
const report = {
  status: "passed",
  profile,
  checks: [
    "full runtime import",
    "concurrent collision rename",
    "idempotent completion",
    "original file preserved",
    "private attachment outside project",
    "restart persistence",
    "native file resolution",
    "native image bytes",
    "path traversal rejected",
  ],
  fixture: scratch,
};
await writeFile(
  join(evidence, "runtime-smoke.json"),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
